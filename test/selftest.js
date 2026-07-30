'use strict';
/**
 * Runs inside the installed extension, so it can reach the real background page, the real
 * menus API and the real downloads API. Driven by test/browser/run-extension.mjs, which serves
 * the fixtures over HTTP and collects the report.
 *
 * Not part of the shipped package - scripts/package.ps1 only includes it with -IncludeTests.
 */
(function () {
  const results = [];
  const list = document.getElementById('out');
  const server = new URLSearchParams(location.search).get('server') || '';

  function record(name, ok, detail) {
    results.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
    const li = document.createElement('li');
    li.className = ok ? 'ok' : 'bad';
    li.textContent = (ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : '');
    list.appendChild(li);
  }

  async function check(name, fn) {
    try {
      record(name, true, await fn());
    } catch (err) {
      record(name, false, (err && err.message) || String(err));
    }
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function assertEqual(actual, expected, label) {
    if (actual !== expected) throw new Error(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }

  async function run() {
    const manifest = browser.runtime.getManifest();
    document.getElementById('meta').textContent =
      manifest.name + ' ' + manifest.version + ' (manifest v' + manifest.manifest_version + ') — ' + navigator.userAgent;

    let background = null;

    await check('the extension loaded with the manifest we shipped', function () {
      assertEqual(manifest.manifest_version, 2, 'manifest_version');
      assertEqual(manifest.name, 'Save WebP as JPG / PNG', 'name');
      return 'v' + manifest.version;
    });

    await check('every permission we asked for was granted', async function () {
      const wanted = ['menus', 'downloads', 'storage', 'notifications'];
      const granted = await browser.permissions.getAll();
      for (const name of wanted) {
        assert(granted.permissions.includes(name), 'missing API permission: ' + name);
      }
      assert(granted.origins.includes('<all_urls>'), 'missing <all_urls>; origins=' + JSON.stringify(granted.origins));
      return granted.permissions.join(', ') + ' + ' + granted.origins.join(', ');
    });

    await check('the background page is running and exposes its logic', async function () {
      background = await browser.runtime.getBackgroundPage();
      assert(background, 'no background page');
      assert(background.ImageIdentify, 'the background page did not load src/lib/identify.js');
      for (const fn of ['decideVisibility', 'quickFormat', 'identify', 'formatOfBlob']) {
        assert(typeof background.ImageIdentify[fn] === 'function',
          'background.ImageIdentify.' + fn + ' is not a function');
      }
      assert(typeof background.applyMenuState === 'function', 'background.applyMenuState is missing');
      return 'background page alive';
    });

    await check('the menus API accepts our item definition, icons and all', async function () {
      assert(browser.menus, 'no menus API');
      assert(typeof browser.menus.onShown === 'object' || typeof browser.menus.onShown === 'function',
        'menus.onShown is unavailable, so the WebP-only filtering cannot work');
      assert(typeof browser.menus.refresh === 'function', 'menus.refresh is unavailable');
      const id = await new Promise(function (resolve, reject) {
        const created = browser.menus.create({
          id: 'selftest-item',
          title: 'Self test',
          contexts: ['image', 'link'],
          icons: { 16: 'icons/jpg.svg' },
          visible: false,
        }, function () {
          const err = browser.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(created);
        });
      });
      await browser.menus.update(id, { visible: true, title: 'Self test renamed' });
      await browser.menus.remove(id);
      return 'create/update/remove all accepted';
    });

    await check('settings survive a write and read through storage', async function () {
      const before = await ExtSettings.get();
      // showForAllImages is deliberately set to the opposite of its default, so that the reset
      // check below proves reset() restored a default rather than keeping what we just wrote.
      await ExtSettings.set({ jpegQuality: 0.37, jpegBackground: '#123456', showForAllImages: false });
      ExtSettings.invalidate();
      const after = await ExtSettings.get();
      assertEqual(after.jpegQuality, 0.37, 'jpegQuality');
      assertEqual(after.jpegBackground, '#123456', 'jpegBackground');
      assertEqual(after.showForAllImages, false, 'showForAllImages');
      const raw = await browser.storage.local.get('jpegQuality');
      assertEqual(raw.jpegQuality, 0.37, 'value actually in storage.local');
      await ExtSettings.reset();
      ExtSettings.invalidate();
      const reset = await ExtSettings.get();
      assertEqual(reset.jpegQuality, ExtSettings.DEFAULTS.jpegQuality, 'quality after reset');
      assertEqual(reset.showForAllImages, ExtSettings.DEFAULTS.showForAllImages, 'scope after reset');
      assertEqual(reset.showForAllImages, true, 'and the shipped default is "every image"');
      return 'wrote 0.37/#123456, read it back, reset cleanly (was ' + before.jpegQuality + ')';
    });

    await check('the menu decision matrix behaves as designed', function () {
      const decide = background.ImageIdentify.decideVisibility;
      const webp = ImageSniff.fromContentType('image/webp');
      const jpeg = ImageSniff.fromContentType('image/jpeg');
      const svg = ImageSniff.fromContentType('image/svg+xml');
      const html = { mime: 'text/html', isImage: false };
      // Both scopes are spelled out rather than derived from DEFAULTS, so changing the shipped
      // default cannot quietly rewrite what these cases are testing.
      const strict = Object.assign({}, ExtSettings.DEFAULTS, { showForAllImages: false });
      const loose = Object.assign({}, ExtSettings.DEFAULTS, { showForAllImages: true });
      const hideUnknown = Object.assign({}, ExtSettings.DEFAULTS, { hideWhenUnknown: true });
      const image = ['image'];
      const link = ['link'];

      assertEqual(decide(webp, strict, image).visible, true, 'WebP is always offered');
      assertEqual(decide(webp, strict, image).webp, true, 'WebP is labelled as WebP');
      assertEqual(decide(webp, loose, image).webp, true, 'and still labelled WebP in the wider scope');
      assertEqual(decide(webp, strict, link).visible, true, 'a link to a WebP is offered too');
      assertEqual(decide(jpeg, strict, image).visible, false, 'a JPEG is hidden in WebP-only mode');
      assertEqual(decide(jpeg, loose, image).visible, true, 'a JPEG shows when all images are allowed');
      assertEqual(decide(jpeg, loose, image).webp, false, 'a JPEG is not labelled WebP');
      assertEqual(decide(svg, loose, image).visible, false, 'SVG cannot be converted, so never offer it');
      assertEqual(decide(html, loose, image).visible, false, 'a non-image is never offered');
      assertEqual(decide(null, strict, image).visible, true, 'an unidentified image is still offered');
      assertEqual(decide(null, hideUnknown, image).visible, false, 'unless hideWhenUnknown is set');
      assertEqual(decide(null, strict, link).visible, false, 'an unidentified link is not offered');

      // And the shipped default really is the wider scope.
      assertEqual(decide(jpeg, ExtSettings.DEFAULTS, image).visible, true,
        'out of the box, a JPEG must offer the menu');
      return '14 cases';
    });

    await check('a .webp address is recognised without any network request', async function () {
      const format = await background.ImageIdentify.identify('https://example.invalid/photo.webp', ExtSettings.DEFAULTS);
      assertEqual(format.mime, 'image/webp', 'mime');
      assertEqual(format.source, 'url', 'must come from the address, not a fetch');
      return 'source=url';
    });

    // The headline case: a WebP served from a .jpg address with a lying Content-Type. Only the
    // bytes reveal the truth, and only the real fetch path can read them.
    await check('a WebP disguised as image/jpeg at a .jpg address is still identified as WebP', async function () {
      assert(server, 'no test server address was passed in');
      const url = server + '/test/fixtures/mislabelled-as.jpg';
      const probe = await fetch(url, { method: 'GET' });
      assertEqual(probe.headers.get('content-type'), 'image/jpeg', 'the server really does lie');
      assertEqual(ImageSniff.guessFromUrl(url).mime, 'image/jpeg', 'the address really does lie');

      const format = await background.ImageIdentify.identify(url, ExtSettings.DEFAULTS);
      assertEqual(format.mime, 'image/webp', 'identified mime');
      assertEqual(format.source, 'bytes', 'must have come from the bytes');
      assertEqual(format.width, 960, 'width read from the VP8 header');
      const decision = background.ImageIdentify.decideVisibility(format, ExtSettings.DEFAULTS, ['image']);
      assertEqual(decision.visible, true, 'the menu must appear for it');
      assertEqual(decision.webp, true, 'and be labelled "Save WebP as ..."');
      return 'sniffed 960×856 WebP behind a .jpg name and an image/jpeg header';
    });

    await check('the sniff result is cached, so a second right-click costs nothing', async function () {
      const url = server + '/test/fixtures/mislabelled-as.jpg';
      const quick = background.ImageIdentify.quickFormat(url);
      assertEqual(quick.final, true, 'the second look must be answered from cache');
      assertEqual(quick.format.mime, 'image/webp', 'cached mime');
      return 'cache hit';
    });

    await check('a real HTTP image is fetched, converted and written to disk by the extension', async function () {
      const url = server + '/test/fixtures/lossy-960x856.webp';
      const response = await fetch(url, { credentials: 'include', cache: 'force-cache' });
      assert(response.ok, 'HTTP ' + response.status);
      const source = await response.blob();
      assertEqual(source.size, 2358, 'source size');

      const format = await background.ImageIdentify.formatOfBlob(source);
      assertEqual(format.mime, 'image/webp', 'format of the downloaded blob');

      const converted = await ImageConvert.convertImage(source, {
        format: 'jpeg',
        quality: ExtSettings.DEFAULTS.jpegQuality,
        background: ExtSettings.DEFAULTS.jpegBackground,
      });
      assertEqual(converted.mime, 'image/jpeg', 'converted mime');
      assertEqual(converted.width, 960, 'converted width');

      const filename = ImageFilename.deriveFilename(url, 'jpg', { fallbackPrefix: 'image' });
      assertEqual(filename, 'lossy-960x856.jpg', 'derived filename');

      const objectUrl = URL.createObjectURL(converted.blob);
      const id = await browser.downloads.download({
        url: objectUrl,
        filename: filename,
        saveAs: false,
        conflictAction: 'overwrite',
      });
      const finished = await new Promise(function (resolve) {
        const listener = function (delta) {
          if (delta.id !== id || !delta.state) return;
          if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
            browser.downloads.onChanged.removeListener(listener);
            resolve(delta.state.current);
          }
        };
        browser.downloads.onChanged.addListener(listener);
        setTimeout(function () {
          browser.downloads.onChanged.removeListener(listener);
          resolve('timeout');
        }, 15000);
      });
      URL.revokeObjectURL(objectUrl);
      assertEqual(finished, 'complete', 'download state');

      const [item] = await browser.downloads.search({ id: id });
      assert(item, 'the download vanished from the list');
      window.__selftestDownload = { path: item.filename, bytes: item.fileSize, expected: converted.blob.size };
      assertEqual(item.fileSize, converted.blob.size, 'bytes on disk vs bytes encoded');
      return item.filename + ' (' + item.fileSize + ' bytes)';
    });

    await check('the options page reflects stored settings and writes back to storage', async function () {
      await ExtSettings.set({ jpegQuality: 0.55, askWhereToSave: true, jpegBackground: '#0a0b0c' });

      const frame = document.createElement('iframe');
      frame.style.cssText = 'width:720px;height:420px;border:1px solid #ccc';
      frame.src = browser.runtime.getURL('src/options/options.html');
      document.body.appendChild(frame);
      await new Promise(function (resolve, reject) {
        frame.onload = resolve;
        frame.onerror = function () { reject(new Error('the options page failed to load')); };
      });
      const doc = frame.contentDocument;

      // Every id options.js reaches for must exist, or a control silently does nothing.
      const ids = ExtSettings.BOOLEAN_KEYS.concat([
        'jpegQuality', 'jpegQualityValue', 'jpegBackground', 'jpegBackgroundHex', 'status', 'reset',
      ]);
      const missing = ids.filter(function (id) { return !doc.getElementById(id); });
      assert(missing.length === 0, 'controls missing from options.html: ' + missing.join(', '));

      // It loads its values asynchronously; wait for the render rather than guessing a delay.
      const slider = doc.getElementById('jpegQuality');
      const deadline = Date.now() + 4000;
      while (slider.value !== '55' && Date.now() < deadline) {
        await new Promise(function (r) { setTimeout(r, 50); });
      }
      assertEqual(slider.value, '55', 'quality slider');
      assertEqual(doc.getElementById('jpegQualityValue').textContent, '55%', 'quality readout');
      assertEqual(doc.getElementById('askWhereToSave').checked, true, 'askWhereToSave checkbox');
      assertEqual(doc.getElementById('jpegBackground').value, '#0a0b0c', 'colour input');
      assertEqual(doc.getElementById('jpegBackgroundHex').value, '#0a0b0c', 'hex field');

      // Now act like a user: tick a box and confirm it lands in storage.
      const box = doc.getElementById('notifyOnSuccess');
      assertEqual(box.checked, false, 'notifyOnSuccess starts off');
      box.checked = true;
      box.dispatchEvent(new frame.contentWindow.Event('change', { bubbles: true }));
      const written = Date.now() + 4000;
      let stored = null;
      while (Date.now() < written) {
        stored = await browser.storage.local.get('notifyOnSuccess');
        if (stored.notifyOnSuccess === true) break;
        await new Promise(function (r) { setTimeout(r, 50); });
      }
      assertEqual(stored.notifyOnSuccess, true, 'the tick reached storage.local');

      frame.remove();
      await ExtSettings.reset();
      ExtSettings.invalidate();
      return ids.length + ' controls present, values round-tripped';
    });

    await check('an image behind a blob: URL is read through the page', async function () {
      assert(typeof background.PageFetchClient === 'object', 'PageFetchClient is not on the background page');
      const tab = await browser.tabs.create({ url: server + '/test/browser/blobpage.html', active: false });
      try {
        // The page publishes its blob URL as the document title.
        let blobUrl = '';
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const current = await browser.tabs.get(tab.id);
          if (current.title && current.title.indexOf('blob:') === 0) { blobUrl = current.title; break; }
          if (current.title && current.title.indexOf('error:') === 0) throw new Error(current.title);
          await new Promise(function (r) { setTimeout(r, 100); });
        }
        assert(blobUrl, 'the page never produced a blob URL');

        // Proof that the background page genuinely cannot read it itself.
        let backgroundCanFetch = true;
        try {
          await fetch(blobUrl);
        } catch (err) {
          backgroundCanFetch = false;
        }
        assertEqual(backgroundCanFetch, false, 'a blob URL from another origin must not be fetchable here');

        const blob = await background.PageFetchClient.fetchViaPage(tab.id, 0, blobUrl);
        assertEqual(blob.size, 2358, 'bytes handed back by the page');
        const format = await background.ImageIdentify.formatOfBlob(blob);
        assertEqual(format.mime, 'image/webp', 'format of the recovered blob');
        assertEqual(format.width, 960, 'width of the recovered blob');

        const converted = await ImageConvert.convertImage(blob, { format: 'png' });
        assertEqual(converted.mime, 'image/png', 'and it converts');
        return 'recovered 2358 bytes of WebP from ' + blobUrl.slice(0, 24) + '…';
      } finally {
        await browser.tabs.remove(tab.id).catch(function () {});
      }
    });

    await check('a non-image is refused rather than saved as a broken file', async function () {
      const blob = new Blob(['<!doctype html><title>not an image</title>'], { type: 'text/html' });
      const format = await background.ImageIdentify.formatOfBlob(blob);
      assert(!format || !format.isImage, 'HTML was treated as an image: ' + JSON.stringify(format));
      let threw = false;
      try {
        await ImageConvert.convertImage(blob, { format: 'png' });
      } catch (err) {
        threw = true;
      }
      assert(threw, 'converting HTML did not throw');
      return 'refused';
    });

    const payload = {
      userAgent: navigator.userAgent,
      manifestVersion: manifest.manifest_version,
      version: manifest.version,
      download: window.__selftestDownload || null,
      results: results,
      passed: results.filter(function (r) { return r.ok; }).length,
      failed: results.filter(function (r) { return !r.ok; }).length,
    };

    if (server) {
      await fetch(server + '/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () {});
    }
  }

  run().catch(function (err) {
    record('self-test harness', false, (err && err.stack) || String(err));
    if (!server) return;
    fetch(server + '/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: results, passed: 0, failed: results.length, fatal: String(err) }),
    }).catch(function () {});
  });
})();
