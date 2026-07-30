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

const html = read('src/options/options.html');
const js = read('src/options/options.js');

const KOFI_URL = 'https://ko-fi.com/irp_hongkong';

/** Every id="..." defined in the markup. */
const definedIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/** Every id the script looks up, via el('x') or getElementById('x'). */
const usedIds = new Set([
  ...[...js.matchAll(/\bel\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
]);

test('every id options.js reaches for exists in options.html', () => {
  assert.ok(usedIds.size >= 5, 'expected several control lookups, found ' + usedIds.size);
  const missing = [...usedIds].filter((id) => !definedIds.has(id));
  assert.deepEqual(missing, [], 'options.js reads ids that options.html does not define');
});

test('every setting has a control on the page', () => {
  // The two non-boolean settings are driven by a slider and a colour input of the same id,
  // so the rule is uniform: one control per key.
  const missing = Object.keys(Settings.DEFAULTS).filter((key) => !definedIds.has(key));
  assert.deepEqual(missing, [], 'settings with no control on the options page');
});

/* --------------------------------------------------------------- the shim bug */

test('the namespace shim loads before anything that uses it', () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const polyfill = scripts.indexOf('../lib/polyfill.js');
  const settings = scripts.indexOf('../lib/settings.js');

  assert.notEqual(polyfill, -1,
    'options.html must load polyfill.js, so the page establishes the `browser` namespace itself ' +
    'instead of depending on the host to provide one');
  assert.notEqual(settings, -1, 'options.html must load settings.js');
  assert.ok(polyfill < settings, 'polyfill.js has to come before settings.js, not after');
});

/** Load polyfill.js fresh against a fabricated set of globals. */
function runShim({ browser, chrome }) {
  const hadBrowser = 'browser' in globalThis;
  const hadChrome = 'chrome' in globalThis;
  const beforeBrowser = globalThis.browser;
  const beforeChrome = globalThis.chrome;
  try {
    if (browser === undefined) delete globalThis.browser; else globalThis.browser = browser;
    if (chrome === undefined) delete globalThis.chrome; else globalThis.chrome = chrome;
    delete require.cache[require.resolve('../src/lib/polyfill.js')];
    require('../src/lib/polyfill.js');
    return globalThis.browser;
  } finally {
    if (hadBrowser) globalThis.browser = beforeBrowser; else delete globalThis.browser;
    if (hadChrome) globalThis.chrome = beforeChrome; else delete globalThis.chrome;
  }
}

test('the shim aliases chrome when there is no browser namespace', () => {
  const fakeChrome = { contextMenus: { tag: 'chrome-menus' }, storage: { local: {} } };
  const result = runShim({ browser: undefined, chrome: fakeChrome });
  assert.equal(result, fakeChrome, 'browser should have become chrome');
  assert.equal(result.menus, fakeChrome.contextMenus, 'browser.menus should alias contextMenus');
});

test('the shim leaves a real browser namespace alone', () => {
  // Both globals present, as in a Firefox build that also exposes `chrome`. The Firefox
  // `browser.menus` is a superset of contextMenus, so replacing it would lose onShown/refresh.
  const firefoxBrowser = { menus: { tag: 'firefox-menus', onShown: {}, refresh: () => {} } };
  const fakeChrome = { contextMenus: { tag: 'chrome-menus' } };
  const result = runShim({ browser: firefoxBrowser, chrome: fakeChrome });
  assert.equal(result, firefoxBrowser, 'the shim replaced an existing browser namespace');
  assert.equal(result.menus.tag, 'firefox-menus', 'the shim clobbered browser.menus');
  assert.ok(result.menus.onShown, 'the Firefox-only menus.onShown was lost');
});

/* ------------------------------------------------------------------- support */

test('the Ko-fi button points at the right page', () => {
  assert.ok(definedIds.has('kofi'), 'the support button is missing');
  assert.ok(html.includes(`data-url="${KOFI_URL}"`), 'the Ko-fi URL is wrong or missing');

  const links = (html.match(/ko-fi\.com\/[A-Za-z0-9_-]+/gi) || [])
    .map((u) => u.toLowerCase())
    .filter((u) => u !== 'ko-fi.com/irp_hongkong');
  assert.deepEqual(links, [], 'options.html references a Ko-fi page other than irp_hongkong');
});

test('the Ko-fi button opens a tab rather than navigating the options iframe', () => {
  assert.match(js, /browser\.tabs\.create/, 'should use tabs.create, which works inside the iframe');
  assert.match(js, /kofi\.dataset\.url/, 'the URL should come from the markup, not be duplicated in JS');
});

/* ------------------------------------------------------- no remote resources */

test('the options page loads nothing from the network', () => {
  // A remote script or stylesheet on an extension page is both a CSP violation and a
  // store-review rejection. data-url is a link the user clicks, not something the page loads.
  const loaded = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const remote = loaded.filter((u) => /^(?:https?:)?\/\//i.test(u));
  assert.deepEqual(remote, [], 'options.html loads remote resources');
});
