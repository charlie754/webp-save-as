'use strict';
/**
 * Test-build only: opens the self-test page once the extension starts.
 *
 * scripts/package.ps1 -IncludeTests appends this to background.scripts. The shipped manifest
 * never lists it, so none of this reaches a real install. The port matches the default in
 * test/browser/run-extension.mjs.
 */
(function () {
  const SERVER = 'http://127.0.0.1:34567';
  const page = browser.runtime.getURL('test/selftest.html') + '?server=' + encodeURIComponent(SERVER);
  // Give the background page a tick to finish building its menus first.
  setTimeout(function () {
    browser.tabs.create({ url: page, active: true }).catch(function (err) {
      console.error('[Save WebP as] self-test could not open:', err);
    });
  }, 300);
})();
