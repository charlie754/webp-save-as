'use strict';
/**
 * One-line namespace bridge, loaded before every shared module in Chrome.
 *
 * The shared code is written against the WebExtension `browser.*` namespace. Chrome MV3 already
 * returns promises from its APIs when no callback is passed, so aliasing `chrome` is genuinely
 * all that is needed — no shim layer and no third-party polyfill.
 *
 * The one real gap is the name of the menus API: Firefox has `browser.menus` (a superset),
 * Chrome only `chrome.contextMenus`. Aliasing it keeps the shared modules from having to care.
 * The Firefox-only extras on that API (onShown, refresh) are feature-detected at their call
 * sites, never assumed.
 */
(function (root) {
  if (typeof root.browser === 'undefined' && typeof chrome !== 'undefined') {
    root.browser = chrome;
  }
  const api = root.browser;
  if (api && !api.menus && api.contextMenus) {
    try {
      api.menus = api.contextMenus;
    } catch (err) {
      /* frozen namespace: callers fall back to contextMenus themselves */
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
