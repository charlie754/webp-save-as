'use strict';
/**
 * Toolbar popup. Shown when the user clicks the extension's icon.
 *
 * The extension's real interface is the right-click menu, so this exists to give it a visible
 * presence, a way into the settings, and the Ko-fi link. Without a popup the extension appears
 * in Firefox's Extensions panel as an inert, greyed-out row that does nothing when clicked.
 */
(function () {
  const el = function (id) { return document.getElementById(id); };

  const manifest = browser.runtime.getManifest();
  el('version').textContent = 'Version ' + manifest.version;

  /**
   * A popup is destroyed the moment focus leaves it, so opening a tab has to happen through
   * tabs.create (no permission needed) rather than window.open, and the panel is closed
   * explicitly afterwards.
   */
  function openTab(url) {
    if (browser.tabs && browser.tabs.create) {
      browser.tabs.create({ url: url }).then(function () { window.close(); }, function () { window.close(); });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    window.close();
  }

  const kofi = el('kofi');
  kofi.addEventListener('click', function () { openTab(kofi.dataset.url); });

  const source = el('source');
  source.addEventListener('click', function () { openTab(source.dataset.url); });

  el('settings').addEventListener('click', function () {
    if (browser.runtime.openOptionsPage) {
      browser.runtime.openOptionsPage().then(function () { window.close(); }, function () { window.close(); });
      return;
    }
    openTab(browser.runtime.getURL('src/options/options.html'));
  });
})();
