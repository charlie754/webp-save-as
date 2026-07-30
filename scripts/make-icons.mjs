/**
 * Rasterises icons/icon.svg into the PNG sizes Chrome needs.
 *
 * Firefox accepts an SVG straight from the manifest; Chrome does not, so the Chrome build needs
 * real bitmaps. Rather than keep a second, hand-drawn copy of the icon in sync, this renders the
 * one SVG through a browser and writes the PNGs beside it.
 *
 *   node scripts/make-icons.mjs [--firefox <exe>]
 *
 * The output is committed, so this only needs re-running when the SVG changes.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];
const PORT = 34569;

const CANDIDATES = [
  'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  '/usr/bin/firefox',
];

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : process.argv[i + 1];
}

const binary = arg('firefox') || CANDIDATES.find((c) => existsSync(c));
if (!binary || !existsSync(binary)) {
  console.error('Could not find Firefox. Pass --firefox <path>.');
  process.exit(1);
}

const PAGE = `<!DOCTYPE html><meta charset="utf-8"><body><script>
(async function () {
  const sizes = ${JSON.stringify(SIZES)};
  const out = {};
  const img = new Image();
  await new Promise(function (resolve, reject) {
    img.onload = resolve;
    img.onerror = function () { reject(new Error('the SVG did not load')); };
    img.src = '/icon.svg';
  });
  for (const size of sizes) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    out[size] = canvas.toDataURL('image/png').split(',')[1];
  }
  await fetch('/results', { method: 'POST', body: JSON.stringify(out) });
})().catch(function (err) {
  fetch('/results', { method: 'POST', body: JSON.stringify({ error: String(err.message) }) });
});
</script></body>`;

let resolveResults;
const reported = new Promise((r) => { resolveResults = r; });

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/results') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.writeHead(204).end();
    resolveResults(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return;
  }
  if (req.url === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
      .end(await readFile(join(ROOT, 'icons', 'icon.svg')));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const profile = await mkdtemp(join(tmpdir(), 'icon-render-'));
await writeFile(join(profile, 'user.js'), [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.enabled", false);',
].join('\n'));

const child = spawn(binary, [
  '--headless', '--no-remote', '--new-instance', '--profile', profile,
  `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' });

const result = await Promise.race([reported, new Promise((r) => setTimeout(() => r(null), 60000))]);
child.kill();
server.close();

if (!result || result.error) {
  console.error('rendering failed: ' + (result ? result.error : 'timed out'));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}

for (const size of SIZES) {
  const bytes = Buffer.from(result[size], 'base64');
  const path = join(ROOT, 'icons', `icon-${size}.png`);
  await writeFile(path, bytes);
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  console.log(`  icon-${size}.png`.padEnd(22) + String(bytes.length).padStart(6) + ' bytes' +
    (isPng ? '' : '   NOT A PNG'));
  if (!isPng) process.exitCode = 1;
}

setTimeout(async () => {
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(process.exitCode || 0);
}, 1000);
