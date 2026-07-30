/**
 * Installs the packaged extension into a throwaway Firefox profile and runs test/selftest.js
 * inside it, so the menus, storage, fetch, conversion and download paths are exercised by the
 * real add-on rather than by a stand-in.
 *
 *   node test/browser/run-extension.mjs [--firefox <exe>] [--port 34567] [--headed]
 *
 * Exits non-zero if any self-test check fails, if the add-on never starts, or if the file the
 * extension claims to have written is not actually on disk with the right bytes.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, stat } from 'node:fs/promises';
import { shutdownFirefox } from './profile.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
/** Read from the manifest rather than pinned here, so changing the add-on's id cannot
 *  silently leave this harness installing to one id and looking for another. */
const EXTENSION_ID = JSON.parse(
  await readFile(join(ROOT, 'manifest.json'), 'utf8'),
).browser_specific_settings.gecko.id;
/** Fixed so the self-test page can be reached at a known moz-extension:// origin. */
const INTERNAL_UUID = '3f2a91c4-7b6d-4e18-9c05-8ad2e6f10b77';
const DEFAULT_PORT = 34567;
const TIMEOUT_MS = 150000;

const CANDIDATES = [
  'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
  'C:\\Program Files\\Firefox Nightly\\firefox.exe',
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  '/usr/bin/firefox',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webp': 'image/webp',
  // Deliberate: fixtures/mislabelled-as.jpg is WebP served as JPEG, which is the case the
  // extension has to get right.
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** Leaves the browser and server up afterwards so the context menu can be checked by hand. */
const KEEP_OPEN = process.argv.includes('--keep-open');

function findFirefox() {
  const explicit = arg('firefox');
  if (explicit) {
    if (!existsSync(explicit)) throw new Error('No Firefox at ' + explicit);
    return explicit;
  }
  for (const candidate of CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error('Could not find Firefox. Pass --firefox <path>.');
}

function buildTestXpi() {
  const xpi = join(ROOT, 'dist', 'webp-save-as-test.xpi');
  if (process.platform !== 'win32') {
    if (!existsSync(xpi)) {
      throw new Error('Build ' + xpi + ' first (scripts/package.ps1 -IncludeTests, or zip it by hand).');
    }
    return xpi;
  }
  const result = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', join(ROOT, 'scripts', 'package.ps1'), '-IncludeTests',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('packaging failed:\n' + (result.stdout || '') + (result.stderr || ''));
  }
  process.stdout.write(result.stdout.split('\n').filter((l) => !l.startsWith('    ')).join('\n'));
  if (!existsSync(xpi)) throw new Error('packaging reported success but ' + xpi + ' is missing');
  return xpi;
}

async function main() {
  const binary = findFirefox();
  const port = Number(arg('port', DEFAULT_PORT));
  const xpi = buildTestXpi();

  let resolveReport;
  const reported = new Promise((r) => { resolveReport = r; });

  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/results') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }).end();
      try {
        resolveReport(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        resolveReport({ fatal: 'unparseable report: ' + err.message, results: [], failed: 1 });
      }
      return;
    }
    const requested = decodeURIComponent((req.url || '/').split('?')[0]);
    const target = resolve(ROOT, '.' + requested);
    if (!target.startsWith(ROOT + sep)) {
      res.writeHead(403).end('outside the project');
      return;
    }
    try {
      const body = await readFile(target);
      res.writeHead(200, {
        'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      }).end(body);
    } catch {
      res.writeHead(404).end('not found: ' + requested);
    }
  });

  await new Promise((resolve_, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve_);
  });

  const profile = await mkdtemp(join(tmpdir(), 'webp-saveas-ext-'));
  const downloads = join(profile, 'downloads');
  await mkdir(downloads, { recursive: true });
  const extensionsDir = join(profile, 'extensions');
  await mkdir(extensionsDir, { recursive: true });
  await writeFile(join(extensionsDir, EXTENSION_ID + '.xpi'), await readFile(xpi));

  const uuids = JSON.stringify({ [EXTENSION_ID]: INTERNAL_UUID });
  await writeFile(join(profile, 'user.js'), [
    // Dev Edition lets us run an unsigned build.
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("extensions.autoDisableScopes", 0);',
    'user_pref("extensions.startupScanScopes", 15);',
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(uuids)});`,
    // Downloads must land somewhere predictable and never prompt.
    'user_pref("browser.download.folderList", 2);',
    `user_pref("browser.download.dir", ${JSON.stringify(downloads)});`,
    'user_pref("browser.download.useDownloadDir", true);',
    'user_pref("browser.download.alwaysOpenPanel", false);',
    // Quiet startup.
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("app.update.auto", false);',
    'user_pref("browser.sessionstore.resume_from_crash", false);',
    // Surface extension console output on stdout.
    'user_pref("devtools.console.stdout.content", true);',
  ].join('\n'));

  console.log('firefox   : ' + binary);
  console.log('profile   : ' + profile);
  console.log('downloads : ' + downloads);
  console.log('server    : http://127.0.0.1:' + port);
  console.log('');

  // --keep-open implies a visible window: its whole point is a human right-clicking things.
  const startUrl = KEEP_OPEN ? `http://127.0.0.1:${port}/test/browser/demo.html` : 'about:blank';
  const flags = ['--no-remote', '--new-instance', '--profile', profile, startUrl];
  if (!KEEP_OPEN && !process.argv.includes('--headed')) flags.unshift('--headless');
  const child = spawn(binary, flags, { stdio: ['ignore', 'pipe', 'pipe'] });
  const browserLog = [];
  child.stdout.on('data', (d) => browserLog.push(String(d)));
  child.stderr.on('data', (d) => browserLog.push(String(d)));

  const report = await Promise.race([reported, new Promise((r) => setTimeout(() => r(null), TIMEOUT_MS))]);

  let addonState = 'unknown';
  try {
    const db = JSON.parse(await readFile(join(profile, 'extensions.json'), 'utf8'));
    const addon = (db.addons || []).find((a) => a.id === EXTENSION_ID);
    addonState = addon ? `installed, active=${addon.active}, location=${addon.location}` : 'NOT INSTALLED';
  } catch (err) {
    addonState = 'extensions.json unreadable: ' + err.message;
  }

  // The browser stays up until the very end: the file it downloaded lives inside the profile,
  // and the disk check below has to read it before the profile is deleted.
  if (!KEEP_OPEN) server.close();

  console.log('add-on    : ' + addonState);

  if (!report) {
    console.error('\nThe self-test never reported back within ' + TIMEOUT_MS / 1000 + 's.');
    const noise = browserLog.join('').split('\n')
      .filter((l) => /Save WebP|extension|error|Error|warn/i.test(l)).slice(0, 40);
    if (noise.length) console.error('browser output:\n' + noise.join('\n'));
    server.close();
    await shutdownFirefox(child, profile);
    process.exit(1);
  }

  console.log('engine    : ' + (report.userAgent || '?'));
  console.log('manifest  : v' + report.manifestVersion + ', extension version ' + report.version);
  console.log('');
  for (const r of report.results || []) {
    console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '\n          ' + r.detail : ''));
  }
  if (report.fatal) console.error('\nfatal: ' + report.fatal);

  // Independent check: the extension said it wrote a file, so look at the file.
  let diskFailures = 0;
  if (report.download && report.download.path) {
    try {
      const info = await stat(report.download.path);
      const bytes = await readFile(report.download.path);
      const signature = Array.from(bytes.subarray(0, 3))
        .map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const ok = info.size === report.download.expected && signature === 'ff d8 ff';
      console.log('\n  ' + (ok ? 'PASS' : 'FAIL') + '  the saved file is a real JPEG on disk');
      console.log('          ' + report.download.path);
      console.log('          ' + info.size + ' bytes (encoder produced ' + report.download.expected +
        '), starts with ' + signature);
      if (!ok) diskFailures++;
    } catch (err) {
      console.log('\n  FAIL  the saved file is missing: ' + err.message);
      diskFailures++;
    }
  } else {
    console.log('\n  FAIL  the self-test never reported a saved file');
    diskFailures++;
  }

  const extensionErrors = browserLog.join('').split('\n')
    .filter((l) => l.includes('[Save WebP as]'));
  if (extensionErrors.length) {
    console.log('\nextension console output:');
    for (const line of extensionErrors.slice(0, 20)) console.log('  ' + line.trim());
  }

  const failed = (report.failed || 0) + diskFailures;
  console.log('\n' + ((report.passed || 0) + (diskFailures ? 0 : 1)) + ' passed, ' + failed + ' failed');

  // The one thing no test can do is open Firefox's own context menu. --keep-open leaves the
  // browser and the server running so a human can right-click the cases in demo.html.
  if (KEEP_OPEN) {
    console.log('\nFirefox is open on the manual-check page:');
    console.log('  ' + startUrl);
    console.log('  right-click each image; downloads land in ' + downloads);
    console.log('\nPress Ctrl+C when done (the temporary profile is deleted on exit).');
    let cleaning = false;
    const cleanup = async () => {
      if (cleaning) return;
      cleaning = true;
      server.close();
      await shutdownFirefox(child, profile);
      process.exit(failed > 0 ? 1 : 0);
    };
    process.on('SIGINT', cleanup);
    child.on('exit', cleanup);
    return;
  }

  await shutdownFirefox(child, profile);
  process.exit(failed > 0 || report.fatal ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
