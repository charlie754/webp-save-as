import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Convert = require('../src/lib/convert.js');

/**
 * The encode/decode path needs a real browser engine and is covered by
 * test/browser/harness.html (run with `npm run test:firefox`). These tests cover the pure
 * parameter handling, which is where a silent wrong answer would be easiest to ship.
 */

test('normalizeQuality accepts fractions and percentages', () => {
  assert.equal(Convert.normalizeQuality(0.8), 0.8);
  assert.equal(Convert.normalizeQuality(80), 0.8);
  assert.equal(Convert.normalizeQuality('0.35'), 0.35);
  assert.equal(Convert.normalizeQuality('90'), 0.9);
  assert.equal(Convert.normalizeQuality(1), 1, '1 is maximum quality, not 1%');
});

test('normalizeQuality clamps and rejects nonsense', () => {
  assert.equal(Convert.normalizeQuality(0), 0.05);
  assert.equal(Convert.normalizeQuality(-1), 0.05);
  assert.equal(Convert.normalizeQuality(101), 1);
  assert.equal(Convert.normalizeQuality(1e9), 1);
  assert.equal(Convert.normalizeQuality(NaN), Convert.DEFAULT_QUALITY);
  assert.equal(Convert.normalizeQuality(Infinity), Convert.DEFAULT_QUALITY);
  assert.equal(Convert.normalizeQuality('lots'), Convert.DEFAULT_QUALITY);
  assert.equal(Convert.normalizeQuality(null), Convert.DEFAULT_QUALITY);
  assert.equal(Convert.normalizeQuality(undefined), Convert.DEFAULT_QUALITY);
  assert.equal(Convert.normalizeQuality({}), Convert.DEFAULT_QUALITY);
});

test('normalizeBackground only trusts hex, because fillStyle fails silently', () => {
  assert.equal(Convert.normalizeBackground('#000'), '#000');
  assert.equal(Convert.normalizeBackground('#0a0b0c'), '#0a0b0c');
  assert.equal(Convert.normalizeBackground('  #ffffff '), '#ffffff');
  assert.equal(Convert.normalizeBackground('white'), Convert.DEFAULT_BACKGROUND);
  assert.equal(Convert.normalizeBackground('#12345'), Convert.DEFAULT_BACKGROUND);
  assert.equal(Convert.normalizeBackground('javascript:alert(1)'), Convert.DEFAULT_BACKGROUND);
  assert.equal(Convert.normalizeBackground(''), Convert.DEFAULT_BACKGROUND);
  assert.equal(Convert.normalizeBackground(null), Convert.DEFAULT_BACKGROUND);
});

test('resolveFormat maps the names the menu uses', () => {
  assert.equal(Convert.resolveFormat('jpeg').mime, 'image/jpeg');
  assert.equal(Convert.resolveFormat('jpg').mime, 'image/jpeg');
  assert.equal(Convert.resolveFormat('JPEG').ext, 'jpg');
  assert.equal(Convert.resolveFormat('png').mime, 'image/png');
  assert.equal(Convert.resolveFormat('PNG').ext, 'png');
});

test('resolveFormat refuses formats a canvas cannot write', () => {
  assert.throws(() => Convert.resolveFormat('webp'), /Unsupported target format/);
  assert.throws(() => Convert.resolveFormat('gif'), /Unsupported target format/);
  assert.throws(() => Convert.resolveFormat(''), /Unsupported target format/);
  assert.throws(() => Convert.resolveFormat(undefined), /Unsupported target format/);
});

test('only JPEG carries a quality setting, and only PNG keeps alpha', () => {
  assert.equal(Convert.FORMATS.jpeg.usesQuality, true);
  assert.equal(Convert.FORMATS.jpeg.keepsAlpha, false);
  assert.equal(Convert.FORMATS.png.usesQuality, false);
  assert.equal(Convert.FORMATS.png.keepsAlpha, true);
});

test('convertImage rejects a missing or empty source before touching a canvas', async () => {
  await assert.rejects(() => Convert.convertImage(null, { format: 'png' }), /needs a Blob/);
  await assert.rejects(() => Convert.convertImage({}, { format: 'png' }), /needs a Blob/);
  await assert.rejects(() => Convert.convertImage({ size: 0 }, { format: 'png' }), /empty/);
});

test('convertImage validates the target format before decoding', async () => {
  await assert.rejects(
    () => Convert.convertImage({ size: 10 }, { format: 'tiff' }),
    /Unsupported target format/,
  );
});

test('the canvas limits match what Gecko actually enforces', () => {
  assert.equal(Convert.MAX_SIDE, 32767);
  assert.equal(Convert.MAX_PIXELS, 124000000);
});
