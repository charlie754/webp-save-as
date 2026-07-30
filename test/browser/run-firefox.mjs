/**
 * Runs test/browser/harness.html in a real Firefox (headless, throwaway profile) and reports the
 * verdict, so the decode/encode path is verified in the engine the extension actually ships to.
 *
 *   node test/browser/run-firefox.mjs [--firefox "C:\path\to\firefox.exe"] [--keep-fixtures]
 *
 * Exits non-zero if any harness check fails or the browser never reports back.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { shutdownFirefox } from './profile.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const TIMEOUT_MS = 120000;

const CANDIDATES = [
  'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
  'C:\\Program Files\\Firefox Nightly\\firefox.exe',
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/usr/bin/firefox',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : process.argv[i + 1];
}

function findFirefox() {
  const explicit = arg('firefox');
  if (explicit) {
    if (!existsSync(explicit)) throw new Error('No Firefox at ' + explicit);
    return explicit;
  }
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find Firefox. Pass --firefox <path to firefox executable>.');
}

async function main() {
  const binary = findFirefox();
  let resolveResults;
  const reported = new Promise((r) => { resolveResults = r; });

  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/results') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(204).end();
      try {
        resolveResults(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        resolveResults({ fatal: 'unparseable report: ' + err.message, results: [], failed: 1 });
      }
      return;
    }
    // Static files, restricted to the project directory.
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
        'Cache-Control': 'no-store',
      }).end(body);
    } catch (err) {
      res.writeHead(404).end('not found: ' + requested);
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/test/browser/harness.html`;

  const profile = await mkdtemp(join(tmpdir(), 'webp-saveas-profile-'));
  await writeFile(join(profile, 'user.js'), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("datareporting.healthreport.uploadEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("app.update.auto", false);',
    'user_pref("browser.sessionstore.resume_from_crash", false);',
  ].join('\n'));

  console.log('firefox : ' + binary);
  console.log('harness : ' + url);

  const child = spawn(binary, ['--headless', '--no-remote', '--new-instance', '--profile', profile, url], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const browserLog = [];
  child.stdout.on('data', (d) => browserLog.push(String(d)));
  child.stderr.on('data', (d) => browserLog.push(String(d)));

  const timeout = new Promise((r) => setTimeout(() => r(null), TIMEOUT_MS));
  const report = await Promise.race([reported, timeout]);

  server.close();
  await shutdownFirefox(child, profile);

  if (!report) {
    console.error('\nThe harness never reported back within ' + TIMEOUT_MS / 1000 + 's.');
    if (browserLog.length) console.error('browser output:\n' + browserLog.join(''));
    process.exit(1);
  }

  console.log('\nengine  : ' + (report.userAgent || 'unknown'));
  if (report.capabilities) {
    console.log('features: ' + Object.entries(report.capabilities)
      .map(([k, v]) => k + '=' + v).join(' '));
  }
  console.log('');
  for (const r of report.results || []) {
    console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '\n          ' + r.detail : ''));
  }
  if (report.fatal) console.error('\nfatal: ' + report.fatal);

  // Save the WebP variants this engine produced, so the unit tests can parse real files.
  if (report.fixtures && !process.argv.includes('--no-fixtures')) {
    const dir = join(ROOT, 'test', 'fixtures');
    await mkdir(dir, { recursive: true });
    for (const [name, data] of Object.entries(report.fixtures)) {
      if (!data || !data.base64) continue;
      const file = join(dir, 'gecko-' + name + '.webp');
      await writeFile(file, Buffer.from(data.base64, 'base64'));
      console.log('\nwrote fixture ' + file + ' (' + data.size + ' bytes, ' +
        (data.format ? data.format.label + (data.format.hasAlpha ? ' +alpha' : '') : 'unrecognised') + ')');
    }
  }

  const failed = report.failed || 0;
  console.log('\n' + (report.passed || 0) + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 || report.fatal ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
