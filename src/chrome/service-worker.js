'use strict';
/**
 * Save WebP as JPG / PNG — Chrome background service worker (Manifest V3).
 *
 * Three things differ from the Firefox build, all forced by MV3 and all verified against
 * Chrome 150 rather than assumed:
 *
 *  1. There is no contextMenus.onShown and no refresh(), so the menu cannot be decided per
 *     right-click. It is built statically from the settings and rebuilt when they change.
 *     In WebP-only mode the best Chrome can do is targetUrlPatterns, which matches on the
 *     address — so a WebP served from a .jpg URL will not show the menu in that mode. With the
 *     default "every image" scope the question does not arise, and the bytes are still what
 *     decides the conversion once the item is clicked.
 *  2. Menu items reject an `icons` property outright ("Unexpected property"), so there are none.
 *  3. URL.createObjectURL does not exist in a service worker. Small outputs are handed to
 *     downloads.download() as a base64 data: URL; large ones go through the offscreen document.
 */

importScripts(
  '/src/chrome/polyfill.js',
  '/src/lib/sniff.js',
  '/src/lib/identify.js',
  '/src/lib/filename.js',
  '/src/lib/convert.js',
  '/src/lib/settings.js',
  '/src/lib/pagefetch.js',
);

const Sniff = ImageSniff;
const Identify = ImageIdentify;
const Names = ImageFilename;
const Convert = ImageConvert;
const Settings = ExtSettings;
const PageFetch = PageFetchClient;

const LOG_PREFIX = '[Save WebP as]';

const MENU_IDS = {
  jpg: 'webp-save-as-jpg',
  png: 'webp-save-as-png',
};

const TARGETS = {
  'webp-save-as-jpg': { format: 'jpeg', ext: 'jpg', mime: 'image/jpeg', label: 'JPG' },
  'webp-save-as-png': { format: 'png', ext: 'png', mime: 'image/png', label: 'PNG' },
};

/** Only these paths carry a .webp address; used when the menu is restricted to WebP. */
const WEBP_URL_PATTERNS = ['*://*/*.webp', '*://*/*.webp?*'];

/**
 * Above this encoded size, base64 is not a reasonable way to move an image: the data: URL is
 * a single string about a third larger again, crossing a process boundary. Bigger outputs go
 * through the offscreen document instead.
 */
const DATA_URL_LIMIT = 4 * 1024 * 1024;

const OFFSCREEN_CHANNEL = 'webp-save-as/offscreen';
const OFFSCREEN_URL = 'src/chrome/offscreen.html';

/* ------------------------------------------------------------------ helpers */

function userError(message) {
  const err = new Error(message);
  err.userFacing = true;
  return err;
}

function pickUrl(info) {
  if (!info) return '';
  return info.srcUrl || info.linkUrl || '';
}

function formatBytes(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function notify(title, message) {
  if (!chrome.notifications) return;
  // Chrome rejects a data: iconUrl ("Unable to download all specified images") but is happy
  // with no icon at all, and falls back to the extension icon.
  const promise = chrome.notifications.create({
    type: 'basic',
    title: title,
    message: String(message == null ? '' : message).slice(0, 400),
  });
  if (promise && promise.catch) promise.catch(function () { /* notifications can be blocked */ });
}

/* ------------------------------------------------------------------- the menu */

let menuWork = Promise.resolve();

async function buildMenus() {
  await chrome.contextMenus.removeAll();
  Settings.invalidate();
  const settings = await Settings.get();

  const webpOnly = !settings.showForAllImages;
  const base = { contexts: ['image', 'link'] };
  if (webpOnly) base.targetUrlPatterns = WEBP_URL_PATTERNS;
  // With the menu pinned to .webp addresses the label can be specific; otherwise it has to
  // stay generic, because Chrome gives us no chance to retitle it per image.
  const prefix = webpOnly ? 'Save WebP as ' : 'Save Image as ';

  if (settings.showJpg) {
    chrome.contextMenus.create(Object.assign({ id: MENU_IDS.jpg, title: prefix + 'JPG' }, base));
  }
  if (settings.showPng) {
    chrome.contextMenus.create(Object.assign({ id: MENU_IDS.png, title: prefix + 'PNG' }, base));
  }
}

/** Serialise rebuilds; overlapping removeAll/create pairs can otherwise lose both items. */
function ensureMenus() {
  menuWork = menuWork.then(buildMenus, buildMenus).catch(function (err) {
    console.error(LOG_PREFIX, 'could not build the menu:', err);
  });
  return menuWork;
}

const MENU_SETTINGS = ['showJpg', 'showPng', 'showForAllImages'];

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  // The menu is static, so it is the only thing that has to be rebuilt when its inputs change.
  if (MENU_SETTINGS.some(function (key) { return key in changes; })) ensureMenus();
});

/* -------------------------------------------------------------- the offscreen doc */

let offscreenPending = null;

async function ensureOffscreen() {
  if (!chrome.offscreen) throw userError('This Chrome is too old for the offscreen API.');
  if (await chrome.offscreen.hasDocument()) return;
  // Concurrent creates throw "Only a single offscreen document may be created"; share one.
  if (!offscreenPending) {
    offscreenPending = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Creating a blob URL for the converted image, which a service worker cannot do.',
    }).catch(function (err) {
      offscreenPending = null;
      throw err;
    });
  }
  await offscreenPending;
  offscreenPending = null;
}

async function askOffscreen(message) {
  await ensureOffscreen();
  const reply = await chrome.runtime.sendMessage(Object.assign({ channel: OFFSCREEN_CHANNEL }, message));
  if (!reply) throw new Error('the converter document did not reply');
  if (reply.error) throw new Error(reply.error);
  return reply;
}

function revokeOffscreen(objectUrl) {
  chrome.runtime.sendMessage({ channel: OFFSCREEN_CHANNEL, op: 'revoke', objectUrl: objectUrl })
    .catch(function () { /* the document may already be gone, which revokes it anyway */ });
}

/* ----------------------------------------------------------------- downloading */

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // String.fromCharCode blows the argument limit on a whole image, so build it in chunks.
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK));
  }
  return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + btoa(binary);
}

/** downloadId -> blob URL that has to outlive the download. */
const pendingRevokes = new Map();

chrome.downloads.onChanged.addListener(function (delta) {
  if (!delta || !delta.state) return;
  if (delta.state.current !== 'complete' && delta.state.current !== 'interrupted') return;
  const objectUrl = pendingRevokes.get(delta.id);
  if (!objectUrl) return;
  pendingRevokes.delete(delta.id);
  revokeOffscreen(objectUrl);
});

async function download(url, filename, settings) {
  return chrome.downloads.download({
    url: url,
    filename: filename,
    saveAs: !!settings.askWhereToSave,
    conflictAction: 'uniquify',
  });
}

/* ----------------------------------------------------------------- the action */

async function fetchDirect(url) {
  const response = await fetch(url, {
    credentials: 'include',
    cache: 'force-cache',
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error('the server replied ' + response.status + ' ' + (response.statusText || ''));
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('the image was empty');
  return blob;
}

async function loadImage(url, info, tab) {
  const tabId = tab && typeof tab.id === 'number' && tab.id >= 0 ? tab.id : null;
  const frameId = info && typeof info.frameId === 'number' ? info.frameId : undefined;

  if (/^blob:/i.test(url)) {
    if (tabId === null) throw userError('That image only exists inside the page, and the page could not be reached.');
    return PageFetch.fetchViaPage(tabId, frameId, url);
  }

  try {
    return await fetchDirect(url);
  } catch (err) {
    if (tabId !== null) {
      try {
        return await PageFetch.fetchViaPage(tabId, frameId, url);
      } catch (inner) {
        /* report the original, more informative failure */
      }
    }
    throw err;
  }
}

async function handleClick(info, tab, target) {
  const settings = await Settings.get();
  const url = pickUrl(info);
  if (!url) throw userError('Chrome did not report an address for that item.');

  const source = await loadImage(url, info, tab);
  const format = await Identify.formatOfBlob(source);

  if (format && format.isImage === false) throw userError('That is not an image file.');
  if (format && format.decodable === false) {
    throw userError(format.label + ' is not something Chrome can convert with a canvas.');
  }
  if (!format && !/^image\//i.test(source.type || '')) {
    throw userError('That does not look like an image (' + formatBytes(source.size) + ' of unrecognised data).');
  }

  const passthrough = !!(settings.passthroughSameFormat && format && format.mime === target.mime);
  let outBlob = source;
  let width = format ? format.width : null;
  let height = format ? format.height : null;

  if (!passthrough) {
    const result = await Convert.convertImage(source, {
      format: target.format,
      quality: settings.jpegQuality,
      background: settings.jpegBackground,
    });
    outBlob = result.blob;
    width = result.width;
    height = result.height;
  }

  const filename = Names.deriveFilename(url, target.ext, { fallbackPrefix: 'image', now: new Date() });

  let downloadId = null;
  let route = 'data-url';
  if (outBlob.size <= DATA_URL_LIMIT) {
    try {
      downloadId = await download(await blobToDataUrl(outBlob), filename, settings);
    } catch (err) {
      if (/cancel/i.test(String((err && err.message) || ''))) return;
      console.warn(LOG_PREFIX, 'data: URL download failed, falling back to the offscreen document:', err);
      downloadId = null;
    }
  }

  if (downloadId === null) {
    // Too big to inline, or the inline route refused: redo the work where blob URLs exist.
    // Re-fetching is cheap - the bytes are already in the HTTP cache.
    route = 'offscreen';
    if (/^blob:/i.test(url)) {
      throw userError('That image is too large to save from this page.');
    }
    const converted = await askOffscreen({
      op: 'convert',
      url: url,
      format: target.format,
      quality: settings.jpegQuality,
      background: settings.jpegBackground,
      passthrough: passthrough,
      mime: target.mime,
    });
    try {
      downloadId = await download(converted.objectUrl, filename, settings);
    } catch (err) {
      revokeOffscreen(converted.objectUrl);
      if (/cancel/i.test(String((err && err.message) || ''))) return;
      throw err;
    }
    pendingRevokes.set(downloadId, converted.objectUrl);
    if (converted.width) { width = converted.width; height = converted.height; }
  }

  const dims = width && height ? ' · ' + width + '×' + height : '';
  if (settings.warnAnimated && !passthrough && format && format.animated === true) {
    notify('Saved the first frame',
      filename + dims + '\n' + format.label + ' is animated; ' + target.label + ' cannot hold more than one frame.');
  } else if (settings.notifyOnSuccess) {
    notify('Saved as ' + target.label,
      filename + dims + ' · ' + formatBytes(outBlob.size) +
      (passthrough ? ' (original bytes, not re-encoded)' : '') +
      (route === 'offscreen' ? ' · via the converter document' : ''));
  }
}

function describeError(err) {
  if (!err) return 'Unknown error.';
  if (err.userFacing) return err.message;
  const message = String((err && err.message) || err);
  if (/NetworkError|Failed to fetch/i.test(message)) {
    return 'The image could not be downloaded: ' + message;
  }
  return message;
}

async function reportFailure(err, url) {
  console.error(LOG_PREFIX, 'conversion failed for', url || '(no url)', err);
  let settings = Settings.DEFAULTS;
  try {
    settings = await Settings.get();
  } catch (inner) { /* fall back to defaults */ }
  if (settings.notifyOnError) notify('Could not save that image', describeError(err));
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  const target = TARGETS[info.menuItemId];
  if (!target) return;
  handleClick(info, tab, target).catch(function (err) {
    reportFailure(err, pickUrl(info));
  });
});

/* -------------------------------------------------------------------- startup */

// Context menus do not survive a browser restart, and the worker is not running to notice, so
// they are rebuilt from both lifecycle events rather than from top-level code.
chrome.runtime.onInstalled.addListener(function (details) {
  ensureMenus();
  if (details && details.reason === 'install' && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});
chrome.runtime.onStartup.addListener(ensureMenus);

/** Exposed for test/chrome-selftest.js, which drives this worker through the debugger. */
self.__webpSaveAs = {
  buildMenus: buildMenus,
  ensureMenus: ensureMenus,
  handleClick: handleClick,
  blobToDataUrl: blobToDataUrl,
  askOffscreen: askOffscreen,
  ensureOffscreen: ensureOffscreen,
  loadImage: loadImage,
  TARGETS: TARGETS,
  MENU_IDS: MENU_IDS,
  WEBP_URL_PATTERNS: WEBP_URL_PATTERNS,
  DATA_URL_LIMIT: DATA_URL_LIMIT,
};
