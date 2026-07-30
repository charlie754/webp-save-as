'use strict';
/**
 * One-line namespace bridge. A no-op wherever `browser` already exists.
 *
 * Measured, not assumed: Chrome 150 does define `browser` in extension pages (a separate object
 * from `chrome`, with `storage` on it), so the shared modules would in fact work there without
 * this. It is loaded anyway, in every context, so the code depends on a namespace it establishes
 * itself rather than on that behaviour holding in older Chrome and other Chromium browsers,
 * which have not been tested here. It costs one 1 KB script.
 *
 * A service worker is the one context that genuinely needs it: `chrome.menus` does not exist
 * anywhere, so the `menus` -> `contextMenus` alias below is doing real work.
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
