'use strict';
/**
 * Fallback image reader that runs inside the page.
 *
 * Needed because `blob:` URLs are scoped to the origin that created them - the background page
 * cannot fetch a blob URL minted by a content page, so we ask the page to do it and hand the
 * bytes back as a data: URL. Also used as a retry path when a direct background fetch fails
 * (expired signed URLs, hotlink protection that keys off the Referer, and similar).
 *
 * MV2's tabs.executeScript cannot await an injected async function, so the injected code posts
 * its result back over runtime.onMessage keyed by a one-shot nonce instead of returning it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
  else root.PageFetchClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CHANNEL = 'webp-save-as/page-fetch';
  const TIMEOUT_MS = 20000;
  /** Cap on the data: URL round trip - base64 inflates by ~33% and messages are copied. */
  const MAX_BYTES = 48 * 1024 * 1024;

  const waiters = new Map();
  let counter = 0;

  function nextNonce() {
    counter += 1;
    return 'pf-' + Date.now().toString(36) + '-' + counter;
  }

  /**
   * Injected into the page. Must be self-contained: it is serialised with toString() on MV2.
   * Runs in the content-script sandbox, so `browser.runtime` is available but page JS is not.
   */
  function pageWorker(url, nonce, channel, maxBytes) {
    (async function () {
      const send = function (payload) {
        try {
          browser.runtime.sendMessage(Object.assign({ channel: channel, nonce: nonce }, payload));
        } catch (err) {
          /* the background page went away; nothing useful to do from here */
        }
      };
      try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) {
          send({ error: 'The page fetched ' + response.status + ' ' + (response.statusText || '') });
          return;
        }
        const blob = await response.blob();
        if (!blob.size) {
          send({ error: 'The page returned an empty image' });
          return;
        }
        if (blob.size > maxBytes) {
          send({ error: 'Image is too large to transfer from the page (' + blob.size + ' bytes)' });
          return;
        }
        const dataUrl = await new Promise(function (resolve, reject) {
          const reader = new FileReader();
          reader.onload = function () { resolve(reader.result); };
          reader.onerror = function () { reject(reader.error || new Error('FileReader failed')); };
          reader.readAsDataURL(blob);
        });
        send({ dataUrl: dataUrl, type: blob.type, size: blob.size });
      } catch (err) {
        send({ error: (err && err.message) || String(err) });
      }
    })();
  }

  async function inject(tabId, frameId, url, nonce) {
    const args = [url, nonce, CHANNEL, MAX_BYTES];
    if (typeof browser === 'undefined') throw new Error('No extension APIs available');

    // MV3 path.
    if (browser.scripting && browser.scripting.executeScript) {
      const target = { tabId: tabId };
      if (typeof frameId === 'number') target.frameIds = [frameId];
      await browser.scripting.executeScript({ target: target, func: pageWorker, args: args });
      return;
    }
    // MV2 path: no `func`, so serialise the worker and its arguments into a code string.
    if (browser.tabs && browser.tabs.executeScript) {
      const literals = args.map(function (a) { return JSON.stringify(a); }).join(', ');
      const code = '(' + pageWorker.toString() + ')(' + literals + ');';
      const details = { code: code, runAt: 'document_end' };
      if (typeof frameId === 'number') details.frameId = frameId;
      await browser.tabs.executeScript(tabId, details);
      return;
    }
    throw new Error('No script injection API available');
  }

  function handleMessage(message) {
    if (!message || message.channel !== CHANNEL) return;
    const waiter = waiters.get(message.nonce);
    if (!waiter) return;
    waiters.delete(message.nonce);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.onMessage) {
    browser.runtime.onMessage.addListener(handleMessage);
  }

  /**
   * Ask the page at `tabId`/`frameId` to fetch `url` and return its bytes.
   * @returns {Promise<Blob>}
   */
  async function fetchViaPage(tabId, frameId, url) {
    const nonce = nextNonce();
    const reply = await new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        waiters.delete(nonce);
        reject(new Error('The page did not return the image in time'));
      }, TIMEOUT_MS);
      waiters.set(nonce, { resolve: resolve, reject: reject, timer: timer });
      inject(tabId, frameId, url, nonce).catch(function (err) {
        const waiter = waiters.get(nonce);
        if (!waiter) return;
        waiters.delete(nonce);
        clearTimeout(timer);
        reject(err);
      });
    });

    if (reply.error) throw new Error(reply.error);
    if (!reply.dataUrl) throw new Error('The page returned no image data');
    const response = await fetch(reply.dataUrl);
    const blob = await response.blob();
    if (!blob.size) throw new Error('The page returned an empty image');
    return blob;
  }

  return {
    CHANNEL: CHANNEL,
    MAX_BYTES: MAX_BYTES,
    TIMEOUT_MS: TIMEOUT_MS,
    pageWorker: pageWorker,
    fetchViaPage: fetchViaPage,
  };
});
