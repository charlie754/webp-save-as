import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const Settings = require('../src/lib/settings.js');

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', p), 'utf8');

const KOFI_URL = 'https://ko-fi.com/irp_hongkong';

/** Both of the extension's HTML surfaces, checked to the same standard. */
const PAGES = [
  { name: 'options', html: read('src/options/options.html'), js: read('src/options/options.js') },
  { name: 'popup', html: read('src/popup/popup.html'), js: read('src/popup/popup.js') },
];

const idsIn = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const idsUsedBy = (js) => new Set([
  ...[...js.matchAll(/\bel\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
]);

for (const page of PAGES) {
  test(`${page.name}: every id the script reaches for exists in the markup`, () => {
    const used = idsUsedBy(page.js);
    const defined = idsIn(page.html);
    assert.ok(used.size >= 3, 'expected several control lookups, found ' + used.size);
    const missing = [...used].filter((id) => !defined.has(id));
    assert.deepEqual(missing, [], `${page.name}.js reads ids the markup does not define`);
  });

  test(`${page.name}: loads nothing from the network`, () => {
    // A remote script, stylesheet or image on an extension page is both a CSP violation and a
    // store-review rejection. data-url is a link the user clicks, not something the page loads.
    const loaded = [...page.html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    const remote = loaded.filter((u) => /^(?:https?:)?\/\//i.test(u));
    assert.deepEqual(remote, [], `${page.name}.html loads remote resources`);
  });

  test(`${page.name}: establishes the browser namespace before using it`, () => {
    const scripts = [...page.html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    const polyfill = scripts.findIndex((s) => s.endsWith('lib/polyfill.js'));
    assert.notEqual(polyfill, -1,
      `${page.name}.html must load polyfill.js, so the page establishes the \`browser\` namespace ` +
      'itself instead of depending on the host to provide one');
    assert.equal(polyfill, 0, 'polyfill.js has to be the first script on the page');
  });
}

/* -------------------------------------------------------------------- Ko-fi */

for (const page of PAGES) {
  test(`${page.name}: the Ko-fi button points at the right page`, () => {
    assert.ok(idsIn(page.html).has('kofi'), 'the support button is missing');
    assert.ok(page.html.includes(`data-url="${KOFI_URL}"`), 'the Ko-fi URL is wrong or missing');

    const links = (page.html.match(/ko-fi\.com\/[A-Za-z0-9_-]+/gi) || [])
      .map((u) => u.toLowerCase())
      .filter((u) => u !== 'ko-fi.com/irp_hongkong');
    assert.deepEqual(links, [], 'references a Ko-fi page other than irp_hongkong');
  });

  test(`${page.name}: the Ko-fi button names the account on its own line`, () => {
    const button = /<button[^>]*id="kofi"[\s\S]*?<\/button>/.exec(page.html);
    assert.ok(button, 'could not find the Ko-fi button');
    assert.match(button[0], /Support me on Ko-fi/, 'the first line');
    assert.match(button[0], /IRP_HongKong/, 'the handle should be inside the button');
    // Two separate elements, so they stack rather than running together on one line.
    assert.match(button[0], /class="kofi__title"[^>]*>\s*Support me on Ko-fi/, 'the title needs its own element');
    assert.match(button[0], /class="kofi__handle"[^>]*>\s*IRP_HongKong/, 'the handle needs its own element');
  });

  test(`${page.name}: opens links in a tab rather than navigating itself`, () => {
    // The options page is an iframe and the popup is destroyed on blur; in both, window.open
    // is unreliable and tabs.create is not.
    assert.match(page.js, /browser\.tabs\.create/, 'should use tabs.create');
    assert.match(page.js, /dataset\.url/, 'the URL should come from the markup, not be duplicated in JS');
  });
}

/* ------------------------------------------------------------------ options */

test('options: every setting has a control on the page', () => {
  const defined = idsIn(PAGES[0].html);
  const missing = Object.keys(Settings.DEFAULTS).filter((key) => !defined.has(key));
  assert.deepEqual(missing, [], 'settings with no control on the options page');
});

/* -------------------------------------------------------------------- popup */

test('popup: offers a way into the settings', () => {
  const popup = PAGES[1];
  assert.ok(idsIn(popup.html).has('settings'), 'the popup should link to the settings');
  assert.match(popup.js, /openOptionsPage/, 'should use openOptionsPage rather than a raw URL');
});

test('popup: shows which version is installed', () => {
  const popup = PAGES[1];
  assert.ok(idsIn(popup.html).has('version'), 'the popup should show the version');
  assert.match(popup.js, /getManifest\(\)/, 'the version should come from the manifest, not be hardcoded');
});

/* ----------------------------------------------------------------- manifests */

const MANIFESTS = [
  { name: 'manifest.json', json: JSON.parse(read('manifest.json')), key: 'browser_action', raster: false },
  { name: 'manifest.chrome.json', json: JSON.parse(read('manifest.chrome.json')), key: 'action', raster: true },
  { name: 'manifest.v3.json', json: JSON.parse(read('manifest.v3.json')), key: 'action', raster: false },
];

for (const m of MANIFESTS) {
  test(`${m.name}: declares the toolbar button and its popup`, () => {
    const action = m.json[m.key];
    assert.ok(action, `${m.name} must declare "${m.key}" or the extension has no clickable icon`);
    assert.equal(action.default_popup, 'src/popup/popup.html', 'popup path');
    assert.ok(action.default_title, 'the button needs a tooltip');
    assert.ok(Object.keys(action.default_icon || {}).length > 0, 'the button needs an icon');
  });

  test(`${m.name}: uses an icon format this browser accepts`, () => {
    // Chrome rejects SVG for manifest and action icons; Firefox accepts either.
    const icons = Object.values(m.json.icons || {}).concat(Object.values(m.json[m.key].default_icon || {}));
    const svgs = icons.filter((p) => p.endsWith('.svg'));
    if (m.raster) {
      assert.deepEqual(svgs, [], `${m.name} is for Chrome, which cannot use SVG icons`);
      for (const p of icons) assert.match(p, /\.png$/, 'Chrome icons must be raster');
    } else {
      assert.ok(icons.length > 0, 'expected some icons');
    }
  });
}

test('all three manifests carry the same version', () => {
  const versions = MANIFESTS.map((m) => m.json.version);
  const pkg = JSON.parse(read('package.json')).version;
  assert.deepEqual([...new Set(versions)], [versions[0]], 'the manifests disagree: ' + versions.join(', '));
  assert.equal(pkg, versions[0], 'package.json disagrees with the manifests');
});
