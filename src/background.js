'use strict';
/**
 * Save WebP as JPG / PNG — Firefox background script (Manifest V2).
 *
 * Flow:
 *   right-click   -> menus.onShown -> identify the image -> show/hide + retitle -> menus.refresh()
 *   click an item -> read the bytes -> canvas re-encode -> downloads.download(blob URL)
 *
 * The per-right-click menu decision is Firefox-only; Chrome has no menus.onShown, so
 * src/chrome/service-worker.js builds a static menu instead. Both share src/lib/identify.js.
 */

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
  'webp-save-as-jpg': { format: 'jpeg', ext: 'jpg', mime: 'image/jpeg', label: 'JPG', icon: 'icons/jpg.svg' },
  'webp-save-as-png': { format: 'png', ext: 'png', mime: 'image/png', label: 'PNG', icon: 'icons/png.svg' },
};

/** Firefox-only APIs that let us decide menu visibility per right-click. */
const CAN_REFRESH_MENUS = !!(browser.menus && browser.menus.onShown && browser.menus.refresh);

const REVOKE_TIMEOUT_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ helpers */

/** An error whose message is written for the user rather than for a log. */
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
  if (!browser.notifications) return;
  const promise = browser.notifications.create({
    type: 'basic',
    title: title,
    message: String(message == null ? '' : message).slice(0, 400),
  });
  if (promise && promise.catch) promise.catch(function () { /* notifications can be disabled */ });
}

/* ------------------------------------------------------------------- the menu */

let menuWork = Promise.resolve();

function onMenuCreated() {
  const err = browser.runtime.lastError;
  if (err) console.error(LOG_PREFIX, 'menu creation failed:', err.message);
}

async function createMenus() {
  try {
    await browser.menus.removeAll();
  } catch (err) {
    /* nothing to remove yet */
  }
  // Start hidden and let onShown reveal them, so images we would refuse never flash a menu item.
  // Without onShown/refresh we cannot make that decision, so stay visible instead of invisible.
  const initiallyVisible = !CAN_REFRESH_MENUS;
  browser.menus.create({
    id: MENU_IDS.jpg,
    title: 'Save Image as JPG',
    contexts: ['image', 'link'],
    icons: { 16: TARGETS[MENU_IDS.jpg].icon },
    visible: initiallyVisible,
  }, onMenuCreated);
  browser.menus.create({
    id: MENU_IDS.png,
    title: 'Save Image as PNG',
    contexts: ['image', 'link'],
    icons: { 16: TARGETS[MENU_IDS.png].icon },
    visible: initiallyVisible,
  }, onMenuCreated);
}

/** Serialise rebuilds; two overlapping removeAll/create pairs can otherwise lose both items. */
function ensureMenus() {
  menuWork = menuWork.then(createMenus, createMenus).catch(function (err) {
    console.error(LOG_PREFIX, 'could not build the menu:', err);
  });
  return menuWork;
}

function updateItem(id, props) {
  const promise = browser.menus.update(id, props);
  if (promise && promise.catch) promise.catch(function () { /* item may not exist yet */ });
  return promise;
}

function applyMenuState(state, settings) {
  const prefix = state.webp ? 'Save WebP as ' : 'Save Image as ';
  updateItem(MENU_IDS.jpg, { visible: state.visible && settings.showJpg, title: prefix + 'JPG' });
  updateItem(MENU_IDS.png, { visible: state.visible && settings.showPng, title: prefix + 'PNG' });
}

/** Bumped on every show/hide so a slow sniff cannot repaint a menu that has moved on. */
let shownSerial = 0;

if (CAN_REFRESH_MENUS) {
  browser.menus.onHidden.addListener(function () { shownSerial += 1; });

  browser.menus.onShown.addListener(async function (info) {
    const serial = shownSerial;
    const contexts = info.contexts || [];
    const url = pickUrl(info);
    const settings = await Settings.get();
    if (serial !== shownSerial) return;

    if (!url) {
      applyMenuState({ visible: false, webp: false }, settings);
      browser.menus.refresh();
      return;
    }

    // Pass 1: everything we know for free.
    const quick = Identify.quickFormat(url);
    const first = Identify.decideVisibility(quick.format, settings, contexts);
    applyMenuState(first, settings);
    browser.menus.refresh();
    if (quick.final || !settings.sniffBytes) return;

    // Pass 2: read the actual bytes, then correct the open menu if the answer changed.
    const format = await Identify.identify(url, settings);
    if (serial !== shownSerial) return;
    const second = Identify.decideVisibility(format, settings, contexts);
    if (second.visible === first.visible && second.webp === first.webp) return;
    applyMenuState(second, settings);
    browser.menus.refresh();
  });
}

/* ----------------------------------------------------------------- the action */

async function fetchDirect(url) {
  const response = await fetch(url, {
    credentials: 'include',
    // Prefer the copy the page already downloaded: faster, and it still works for one-shot
    // signed URLs that would 403 on a second request.
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

  // blob: URLs belong to the page's origin - only the page can read them.
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

/** @returns {number|null} download id, or null when the user dismissed the file picker. */
async function startDownload(blob, filename, settings) {
  const objectUrl = URL.createObjectURL(blob);
  let id;
  try {
    id = await browser.downloads.download({
      url: objectUrl,
      filename: filename,
      saveAs: !!settings.askWhereToSave,
      conflictAction: 'uniquify',
    });
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    if (/cancel/i.test(String((err && err.message) || ''))) return null;
    throw err;
  }
  const timer = setTimeout(function () { releaseObjectUrl(id); }, REVOKE_TIMEOUT_MS);
  pendingObjectUrls.set(id, { url: objectUrl, timer: timer });
  return id;
}

/** downloadId -> { url, timer }; the blob URL must outlive the download itself. */
const pendingObjectUrls = new Map();

function releaseObjectUrl(id) {
  const entry = pendingObjectUrls.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  URL.revokeObjectURL(entry.url);
  pendingObjectUrls.delete(id);
}

browser.downloads.onChanged.addListener(function (delta) {
  if (!delta || !delta.state) return;
  if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
    releaseObjectUrl(delta.id);
  }
});

async function handleClick(info, tab, target) {
  const settings = await Settings.get();
  const url = pickUrl(info);
  if (!url) throw userError('Firefox did not report an address for that item.');

  const source = await loadImage(url, info, tab);
  const format = await Identify.formatOfBlob(source);

  if (format && format.isImage === false) throw userError('That is not an image file.');
  if (format && format.decodable === false) {
    throw userError(format.label + ' is not something Firefox can convert with a canvas.');
  }
  if (!format && !/^image\//i.test(source.type || '')) {
    throw userError('That does not look like an image (' + formatBytes(source.size) + ' of unrecognised data).');
  }

  let outBlob;
  let width = format ? format.width : null;
  let height = format ? format.height : null;
  let reencoded = true;

  if (settings.passthroughSameFormat && format && format.mime === target.mime) {
    // Already the requested format: copying the bytes beats a lossy round trip.
    outBlob = source;
    reencoded = false;
  } else {
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
  const downloadId = await startDownload(outBlob, filename, settings);
  if (downloadId === null) return; // picker dismissed

  const dims = width && height ? ' · ' + width + '×' + height : '';
  if (settings.warnAnimated && reencoded && format && format.animated === true) {
    notify('Saved the first frame',
      filename + dims + '\n' + format.label + ' is animated; ' + target.label + ' cannot hold more than one frame.');
  } else if (settings.notifyOnSuccess) {
    notify('Saved as ' + target.label,
      filename + dims + ' · ' + formatBytes(outBlob.size) + (reencoded ? '' : ' (original bytes, not re-encoded)'));
  }
}

function describeError(err) {
  if (!err) return 'Unknown error.';
  if (err.userFacing) return err.message;
  const message = String((err && err.message) || err);
  if (/NetworkError|Failed to fetch|NS_ERROR_/i.test(message)) {
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

browser.menus.onClicked.addListener(function (info, tab) {
  const target = TARGETS[info.menuItemId];
  if (!target) return;
  handleClick(info, tab, target).catch(function (err) {
    reportFailure(err, pickUrl(info));
  });
});

/* -------------------------------------------------------------------- startup */

browser.runtime.onInstalled.addListener(function (details) {
  ensureMenus();
  if (details && details.reason === 'install' && browser.runtime.openOptionsPage) {
    browser.runtime.openOptionsPage();
  }
});
browser.runtime.onStartup.addListener(ensureMenus);
ensureMenus();
