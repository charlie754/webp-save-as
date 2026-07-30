/**
 * Loads the packaged Chrome build into a throwaway Chrome profile and drives its MV3 service
 * worker over the DevTools Protocol.
 *
 *   node test/browser/run-chrome.mjs [--chrome <exe>] [--headed]
 *
 * Two things are worth knowing about how this works:
 *
 *  - `--load-extension` no longer loads anything in Chrome 137+; the supported route is the CDP
 *    command `Extensions.loadUnpacked`, which is what this uses (verified on Chrome 150).
 *  - Rather than shipping a test page inside the extension, this attaches to the service worker
 *    target and evaluates expressions against its real globals. Nothing test-only reaches the
 *    packaged build.
 *
 * Exits non-zero if any check fails or if a file the extension claims to have written is not on
 * disk with the right bytes.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const UNPACKED = join(ROOT, 'dist', 'chrome');
const PORT = 34570;
const DEBUG_PORT = 9335;
const HEADED = process.argv.includes('--headed');

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  // Deliberate: fixtures/mislabelled-as.jpg is WebP served as JPEG.
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : process.argv[i + 1];
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '\n          ' + detail : ''));
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function buildChromePackage() {
  if (process.platform !== 'win32') {
    if (!existsSync(UNPACKED)) throw new Error('Build ' + UNPACKED + ' first (scripts/package.ps1 -Chrome).');
    return;
  }
  const out = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', join(ROOT, 'scripts', 'package.ps1'), '-Chrome'], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error('packaging failed:\n' + (out.stdout || '') + (out.stderr || ''));
  console.log(out.stdout.split('\n').filter((l) => !l.startsWith('    ')).join('\n').trim());
  if (!existsSync(UNPACKED)) throw new Error('packaging succeeded but ' + UNPACKED + ' is missing');
}

/* ------------------------------------------------------------------ CDP glue */

function connect(url) {
  return new Promise((resolve_, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve_(ws);
    ws.onerror = (e) => reject(new Error('websocket failed: ' + (e.message || 'unknown')));
  });
}

function makeSender(ws) {
  let nextId = 1;
  return function send(method, params) {
    const id = nextId++;
    return new Promise((resolve_) => {
      const onMessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id !== id) return;
        ws.removeEventListener('message', onMessage);
        resolve_(msg);
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => resolve_({ error: { message: method + ' timed out' } }), 45000);
    });
  };
}

async function main() {
  const binary = arg('chrome') || CANDIDATES.find((c) => existsSync(c));
  if (!binary || !existsSync(binary)) throw new Error('Could not find Chrome. Pass --chrome <path>.');
  buildChromePackage();

  const server = createServer(async (req, res) => {
    const requested = decodeURIComponent((req.url || '/').split('?')[0]);
    const target = resolve(ROOT, '.' + requested);
    if (!target.startsWith(ROOT + sep)) { res.writeHead(403).end('outside the project'); return; }
    try {
      res.writeHead(200, {
        'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      }).end(await readFile(target));
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + PORT;

  const profile = await mkdtemp(join(tmpdir(), 'chrome-ext-'));
  const downloads = join(profile, 'downloads');
  await mkdir(downloads, { recursive: true });
  await mkdir(join(profile, 'Default'), { recursive: true });
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
    profile: { exit_type: 'Normal', exited_cleanly: true },
  }));

  const flags = [
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + DEBUG_PORT,
    '--enable-unsafe-extension-debugging',
    '--disable-features=DialMediaRouteProvider,OptimizationHints,Translate',
    'about:blank',
  ];
  if (!HEADED) flags.unshift('--headless=new');

  console.log('chrome    : ' + binary);
  console.log('profile   : ' + profile);
  console.log('downloads : ' + downloads);
  console.log('server    : ' + base);
  console.log('');

  const child = spawn(binary, flags, { stdio: ['ignore', 'pipe', 'pipe'] });
  const browserLog = [];
  child.stdout.on('data', (d) => browserLog.push(String(d)));
  child.stderr.on('data', (d) => browserLog.push(String(d)));

  const cleanup = async (code) => {
    try { child.kill(); } catch { /* gone */ }
    server.close();
    await new Promise((r) => setTimeout(r, 800));
    if (process.platform === 'win32') {
      spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore' });
    }
    for (let i = 0; i < 10; i++) {
      try { await rm(profile, { recursive: true, force: true, maxRetries: 3 }); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    process.exit(code);
  };

  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!version) { console.error('CDP never came up'); await cleanup(1); }
  console.log('engine    : ' + version.Browser);

  const browserWs = await connect(version.webSocketDebuggerUrl);
  const sendBrowser = makeSender(browserWs);
  const loaded = await sendBrowser('Extensions.loadUnpacked', { path: UNPACKED });
  if (!loaded.result || !loaded.result.id) {
    console.error('Extensions.loadUnpacked failed: ' + JSON.stringify(loaded.error || loaded));
    await cleanup(1);
  }
  const extensionId = loaded.result.id;
  console.log('extension : ' + extensionId);

  // The worker starts to receive onInstalled; wait for its target to appear.
  let workerTarget = null;
  for (let i = 0; i < 60; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    workerTarget = targets.find((t) => t.type === 'service_worker' && (t.url || '').includes(extensionId));
    if (workerTarget) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!workerTarget) {
    console.error('the service worker never started');
    console.error(browserLog.join('').split('\n').slice(0, 30).join('\n'));
    await cleanup(1);
  }
  console.log('worker    : ' + workerTarget.url);
  console.log('');

  const workerWs = await connect(workerTarget.webSocketDebuggerUrl);
  const sendWorker = makeSender(workerWs);
  await sendWorker('Runtime.enable');

  /** Evaluate an async body against a CDP target and return its value. */
  function makeEvaluator(send) {
    return async function evaluate(body) {
      const reply = await send('Runtime.evaluate', {
        expression: `(async () => { ${body} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (reply.error) throw new Error('CDP: ' + reply.error.message);
      const details = reply.result.exceptionDetails;
      if (details) {
        throw new Error((details.exception && (details.exception.description || details.exception.value)) || details.text);
      }
      return reply.result.result.value;
    };
  }

  /** Evaluate inside the real service worker. */
  const evaluate = makeEvaluator(sendWorker);

  /** Open an extension page and return an evaluator for it, plus a closer. */
  async function openPage(url) {
    const created = await sendBrowser('Target.createTarget', { url });
    if (!created.result || !created.result.targetId) {
      throw new Error('could not open ' + url + ': ' + JSON.stringify(created.error || created));
    }
    const targetId = created.result.targetId;
    let entry = null;
    for (let i = 0; i < 60; i++) {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      entry = targets.find((t) => t.id === targetId && t.webSocketDebuggerUrl);
      if (entry) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!entry) throw new Error('the page target never became debuggable');
    const ws = await connect(entry.webSocketDebuggerUrl);
    const send = makeSender(ws);
    await send('Runtime.enable');
    return {
      evaluate: makeEvaluator(send),
      close: async () => {
        try { ws.close(); } catch { /* closing anyway */ }
        await sendBrowser('Target.closeTarget', { targetId });
      },
    };
  }

  async function check(name, fn) {
    try { record(name, true, await fn()); }
    catch (err) { record(name, false, (err && err.message) || String(err)); }
  }

  /* ------------------------------------------------------------- the checks */

  await check('the extension loaded as MV3 with the manifest we ship', async () => {
    const m = await evaluate('const m = chrome.runtime.getManifest(); return {v: m.manifest_version, name: m.name, version: m.version};');
    assertEqual(m.v, 3, 'manifest_version');
    assertEqual(m.name, 'Save WebP as JPG / PNG', 'name');
    return 'v' + m.version;
  });

  await check('every shared module loaded into the service worker', async () => {
    const g = await evaluate(`return {
      sniff: typeof ImageSniff, identify: typeof ImageIdentify, names: typeof ImageFilename,
      convert: typeof ImageConvert, settings: typeof ExtSettings, pagefetch: typeof PageFetchClient,
      browser: typeof browser, menusAliased: browser.menus === chrome.contextMenus,
    };`);
    for (const key of ['sniff', 'identify', 'names', 'convert', 'settings', 'pagefetch']) {
      assertEqual(g[key], 'object', key + ' module');
    }
    assertEqual(g.browser, 'object', 'the browser namespace shim');
    assertEqual(g.menusAliased, true, 'browser.menus aliased to chrome.contextMenus');
    return 'all six modules + the namespace shim';
  });

  await check('the worker has no DOM and no blob URLs, which is why offscreen exists', async () => {
    const env = await evaluate(`return {
      document: typeof document, createObjectURL: typeof URL.createObjectURL,
      createImageBitmap: typeof createImageBitmap, OffscreenCanvas: typeof OffscreenCanvas,
      onShown: typeof chrome.contextMenus.onShown, refresh: typeof chrome.contextMenus.refresh,
    };`);
    assertEqual(env.document, 'undefined', 'document in a service worker');
    assertEqual(env.createObjectURL, 'undefined', 'URL.createObjectURL in a service worker');
    assertEqual(env.createImageBitmap, 'function', 'createImageBitmap');
    assertEqual(env.OffscreenCanvas, 'function', 'OffscreenCanvas');
    assertEqual(env.onShown, 'undefined', 'contextMenus.onShown must not exist in Chrome');
    assertEqual(env.refresh, 'undefined', 'contextMenus.refresh must not exist in Chrome');
    return 'no document, no createObjectURL, no onShown/refresh — all as the port assumes';
  });

  await check('Chrome rejects the Firefox-style menu icons the port drops', async () => {
    const message = await evaluate(`
      try {
        chrome.contextMenus.create({id:'probe-icons', title:'x', contexts:['image'], icons:{16:'icons/jpg.svg'}});
        return null;
      } catch (err) { return err.message; }`);
    assert(message && /Unexpected property|icons/i.test(message), 'expected a rejection, got ' + message);
    return String(message).slice(0, 90) + '…';
  });

  await check('settings round-trip through chrome.storage.local', async () => {
    const r = await evaluate(`
      await ExtSettings.set({jpegQuality: 0.37, jpegBackground: '#123456', showForAllImages: false});
      ExtSettings.invalidate();
      const after = await ExtSettings.get();
      const raw = await chrome.storage.local.get('jpegQuality');
      await ExtSettings.reset();
      ExtSettings.invalidate();
      const reset = await ExtSettings.get();
      return {q: after.jpegQuality, bg: after.jpegBackground, scope: after.showForAllImages,
              rawQ: raw.jpegQuality, resetQ: reset.jpegQuality, resetScope: reset.showForAllImages};`);
    assertEqual(r.q, 0.37, 'jpegQuality');
    assertEqual(r.bg, '#123456', 'jpegBackground');
    assertEqual(r.scope, false, 'showForAllImages');
    assertEqual(r.rawQ, 0.37, 'value actually in storage.local');
    assertEqual(r.resetQ, 0.92, 'quality after reset');
    assertEqual(r.resetScope, true, 'the shipped default is "every image"');
    return 'wrote 0.37/#123456, read it back, reset to the shipped defaults';
  });

  await check('the menu decision matrix behaves as designed', async () => {
    const m = await evaluate(`
      const d = ImageIdentify.decideVisibility;
      const webp = ImageSniff.fromContentType('image/webp');
      const jpeg = ImageSniff.fromContentType('image/jpeg');
      const svg  = ImageSniff.fromContentType('image/svg+xml');
      const html = {mime:'text/html', isImage:false};
      const strict = Object.assign({}, ExtSettings.DEFAULTS, {showForAllImages:false});
      const loose  = Object.assign({}, ExtSettings.DEFAULTS, {showForAllImages:true});
      const hide   = Object.assign({}, ExtSettings.DEFAULTS, {hideWhenUnknown:true});
      return {
        webpStrict: d(webp, strict, ['image']).visible, webpLabelled: d(webp, loose, ['image']).webp,
        webpLink: d(webp, strict, ['link']).visible,
        jpegStrict: d(jpeg, strict, ['image']).visible, jpegLoose: d(jpeg, loose, ['image']).visible,
        jpegLabelled: d(jpeg, loose, ['image']).webp,
        svgLoose: d(svg, loose, ['image']).visible, htmlLoose: d(html, loose, ['image']).visible,
        unknownImage: d(null, strict, ['image']).visible, unknownHidden: d(null, hide, ['image']).visible,
        unknownLink: d(null, strict, ['link']).visible,
        defaultJpeg: d(jpeg, ExtSettings.DEFAULTS, ['image']).visible,
      };`);
    assertEqual(m.webpStrict, true, 'WebP is always offered');
    assertEqual(m.webpLabelled, true, 'WebP stays labelled as WebP');
    assertEqual(m.webpLink, true, 'a link to a WebP is offered');
    assertEqual(m.jpegStrict, false, 'a JPEG is hidden in WebP-only mode');
    assertEqual(m.jpegLoose, true, 'a JPEG shows in the wider scope');
    assertEqual(m.jpegLabelled, false, 'a JPEG is not labelled WebP');
    assertEqual(m.svgLoose, false, 'SVG is never offered');
    assertEqual(m.htmlLoose, false, 'a non-image is never offered');
    assertEqual(m.unknownImage, true, 'an unidentified image is still offered');
    assertEqual(m.unknownHidden, false, 'unless hideWhenUnknown is set');
    assertEqual(m.unknownLink, false, 'an unidentified link is not offered');
    assertEqual(m.defaultJpeg, true, 'out of the box a JPEG offers the menu');
    return '12 cases, identical to the Firefox build';
  });

  await check('menus are built in both scopes and really exist afterwards', async () => {
    const r = await evaluate(`
      const dup = async () => new Promise(res => {
        chrome.contextMenus.create({id: self.__webpSaveAs.MENU_IDS.jpg, title:'dupe', contexts:['image']},
          () => res(chrome.runtime.lastError ? chrome.runtime.lastError.message : null));
      });
      await ExtSettings.set({showForAllImages: true});
      await self.__webpSaveAs.buildMenus();
      const wide = await dup();
      await ExtSettings.set({showForAllImages: false});
      await self.__webpSaveAs.buildMenus();
      const narrow = await dup();
      await ExtSettings.reset();
      await self.__webpSaveAs.buildMenus();
      return {wide, narrow, patterns: self.__webpSaveAs.WEBP_URL_PATTERNS};`);
    // A duplicate-id error is the only observable proof the item is registered: Chrome offers
    // no way to read the menu back.
    assert(r.wide && /duplicate/i.test(r.wide), 'the wide-scope item was not created: ' + r.wide);
    assert(r.narrow && /duplicate/i.test(r.narrow), 'the WebP-only item was not created: ' + r.narrow);
    return 'both scopes register; WebP-only uses ' + r.patterns.join(' ');
  });

  await check('a .webp address is recognised without any network request', async () => {
    const f = await evaluate(`const f = await ImageIdentify.identify('https://example.invalid/photo.webp', ExtSettings.DEFAULTS); return {mime: f.mime, source: f.source};`);
    assertEqual(f.mime, 'image/webp', 'mime');
    assertEqual(f.source, 'url', 'must come from the address, not a fetch');
    return 'source=url';
  });

  await check('a WebP disguised as image/jpeg at a .jpg address is still identified as WebP', async () => {
    const r = await evaluate(`
      const url = '${base}/test/fixtures/mislabelled-as.jpg';
      const probe = await fetch(url);
      const byUrl = ImageSniff.guessFromUrl(url);
      const f = await ImageIdentify.identify(url, ExtSettings.DEFAULTS);
      return {header: probe.headers.get('content-type'), byUrl: byUrl.mime,
              mime: f.mime, source: f.source, width: f.width, height: f.height};`);
    assertEqual(r.header, 'image/jpeg', 'the server really does lie');
    assertEqual(r.byUrl, 'image/jpeg', 'the address really does lie');
    assertEqual(r.mime, 'image/webp', 'identified mime');
    assertEqual(r.source, 'bytes', 'must have come from the bytes');
    assertEqual(r.width, 960, 'width read from the VP8 header');
    return 'sniffed ' + r.width + '×' + r.height + ' WebP behind a .jpg name and an image/jpeg header';
  });

  await check('the sniff result is cached for the next right-click', async () => {
    const q = await evaluate(`const q = ImageIdentify.quickFormat('${base}/test/fixtures/mislabelled-as.jpg'); return {final: q.final, mime: q.format && q.format.mime};`);
    assertEqual(q.final, true, 'the second look must be answered from cache');
    assertEqual(q.mime, 'image/webp', 'cached mime');
    return 'cache hit';
  });

  await check('blobToDataUrl encodes the bytes faithfully', async () => {
    const r = await evaluate(`
      const blob = new Blob([new Uint8Array([1,2,3,250,251,252])], {type:'image/jpeg'});
      const url = await self.__webpSaveAs.blobToDataUrl(blob);
      const back = new Uint8Array(await (await fetch(url)).arrayBuffer());
      return {url, roundTrip: Array.from(back)};`);
    assertEqual(r.url, 'data:image/jpeg;base64,AQID+vv8', 'data URL');
    assert(JSON.stringify(r.roundTrip) === '[1,2,3,250,251,252]', 'round trip: ' + r.roundTrip);
    return 'exact round trip through base64';
  });

  const savedFiles = {};

  await check('the data: URL route converts and saves a real file', async () => {
    const r = await evaluate(`
      const url = '${base}/test/fixtures/lossy-960x856.webp';
      const done = new Promise(res => {
        const l = d => { if (d.state && (d.state.current === 'complete' || d.state.current === 'interrupted')) {
          chrome.downloads.onChanged.removeListener(l); res(d); } };
        chrome.downloads.onChanged.addListener(l);
        setTimeout(() => res({state:{current:'timeout'}}), 20000);
      });
      await self.__webpSaveAs.handleClick({srcUrl: url, frameId: 0}, {id: -1},
        self.__webpSaveAs.TARGETS['webp-save-as-jpg']);
      const delta = await done;
      const [item] = await chrome.downloads.search({id: delta.id});
      return {state: delta.state.current, path: item && item.filename, bytes: item && item.fileSize};`);
    assertEqual(r.state, 'complete', 'download state');
    assert(r.path && r.path.endsWith('lossy-960x856.jpg'), 'filename: ' + r.path);
    savedFiles.dataUrl = { path: r.path, bytes: r.bytes, signature: 'ffd8ff' };
    return r.path + ' (' + r.bytes + ' bytes)';
  });

  await check('the offscreen route mints a blob URL and saves a real file', async () => {
    const r = await evaluate(`
      const url = '${base}/test/fixtures/lossy-960x856.webp';
      const converted = await self.__webpSaveAs.askOffscreen({
        op:'convert', url, format:'png', quality:0.92, background:'#ffffff',
        passthrough:false, mime:'image/png'});
      const done = new Promise(res => {
        const l = d => { if (d.state && (d.state.current === 'complete' || d.state.current === 'interrupted')) {
          chrome.downloads.onChanged.removeListener(l); res(d); } };
        chrome.downloads.onChanged.addListener(l);
        setTimeout(() => res({state:{current:'timeout'}}), 20000);
      });
      const id = await chrome.downloads.download({url: converted.objectUrl,
        filename:'offscreen-route.png', conflictAction:'overwrite'});
      const delta = await done;
      const [item] = await chrome.downloads.search({id});
      const hasDoc = await chrome.offscreen.hasDocument();
      return {isBlob: converted.objectUrl.startsWith('blob:'), size: converted.size,
              width: converted.width, height: converted.height, hasDoc,
              state: delta.state.current, path: item && item.filename, bytes: item && item.fileSize};`);
    assertEqual(r.isBlob, true, 'the offscreen document returned a blob: URL');
    assertEqual(r.hasDoc, true, 'the offscreen document is alive');
    assertEqual(r.width, 960, 'converted width');
    assertEqual(r.state, 'complete', 'download state');
    assertEqual(r.bytes, r.size, 'bytes on disk vs bytes the document encoded');
    savedFiles.offscreen = { path: r.path, bytes: r.bytes, signature: '89504e' };
    return r.path + ' (' + r.bytes + ' bytes, ' + r.width + '×' + r.height + ')';
  });

  await check('a non-image is refused rather than saved as a broken file', async () => {
    const r = await evaluate(`
      const blob = new Blob(['<!doctype html><title>not an image</title>'], {type:'text/html'});
      const format = await ImageIdentify.formatOfBlob(blob);
      let threw = null;
      try { await ImageConvert.convertImage(blob, {format:'png'}); }
      catch (err) { threw = err.message; }
      return {isImage: format && format.isImage, threw};`);
    assert(!r.isImage, 'HTML was treated as an image');
    assert(r.threw, 'converting HTML did not throw');
    return 'refused';
  });

  await check('the options page reads and writes settings in Chrome', async () => {
    // The options page was previously the one surface with no Chrome coverage at all. It is
    // driven here end to end: seed a value from the worker, open the real page, and check it
    // both renders that value and writes a change back to chrome.storage.local.
    await evaluate("await ExtSettings.set({jpegQuality: 0.61, askWhereToSave: true}); return true;");

    const page = await openPage(`chrome-extension://${extensionId}/src/options/options.html`);
    try {
      const shown = await page.evaluate(`
        const deadline = Date.now() + 8000;
        const slider = () => document.getElementById('jpegQuality');
        while ((!slider() || slider().value !== '61') && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 100));
        }
        return {
          hasBrowser: typeof browser,
          quality: slider() && slider().value,
          readout: document.getElementById('jpegQualityValue').textContent,
          askWhereToSave: document.getElementById('askWhereToSave').checked,
          kofi: (document.getElementById('kofi') || {}).dataset
                 ? document.getElementById('kofi').dataset.url : null,
        };`);
      assertEqual(shown.hasBrowser, 'object', 'the shim must give the options page a browser namespace');
      assertEqual(shown.quality, '61', 'the page must show the stored quality, not the default');
      assertEqual(shown.readout, '61%', 'the readout');
      assertEqual(shown.askWhereToSave, true, 'the stored checkbox state');
      assertEqual(shown.kofi, 'https://ko-fi.com/irp_hongkong', 'the Ko-fi button URL');

      // Now act like a user and confirm the change actually reaches chrome.storage.local.
      await page.evaluate(`
        const box = document.getElementById('notifyOnSuccess');
        box.checked = true;
        box.dispatchEvent(new Event('change', {bubbles: true}));
        return true;`);
      const stored = await evaluate(`
        const deadline = Date.now() + 6000;
        let v;
        while (Date.now() < deadline) {
          v = (await chrome.storage.local.get('notifyOnSuccess')).notifyOnSuccess;
          if (v === true) break;
          await new Promise(r => setTimeout(r, 100));
        }
        return v;`);
      assertEqual(stored, true, 'the tick never reached chrome.storage.local');
      await evaluate('await ExtSettings.reset(); return true;');
      return 'stored values render, and a tick reaches chrome.storage.local';
    } finally {
      await page.close();
    }
  });

  /* ---------------------------------------------------- independent disk check */

  for (const [route, info] of Object.entries(savedFiles)) {
    await check(`the ${route} file is really on disk with the right bytes`, async () => {
      const stats = await stat(info.path);
      const bytes = await readFile(info.path);
      const signature = bytes.subarray(0, 3).toString('hex');
      assertEqual(stats.size, info.bytes, 'size on disk');
      assertEqual(signature, info.signature, 'magic bytes');
      return info.path + '\n          ' + stats.size + ' bytes, starts with ' + signature;
    });
  }

  const extensionErrors = browserLog.join('').split('\n').filter((l) => l.includes('[Save WebP as]'));
  if (extensionErrors.length) {
    console.log('\nextension console output:');
    for (const line of extensionErrors.slice(0, 20)) console.log('  ' + line.trim());
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  try { workerWs.close(); browserWs.close(); } catch { /* closing anyway */ }
  await cleanup(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
