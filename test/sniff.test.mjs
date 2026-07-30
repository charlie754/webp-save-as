import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const Sniff = require('../src/lib/sniff.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name));

/* --------------------------------------------------------------- byte helpers */

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const u32le = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const u24le = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** RIFF/WEBP container around a first chunk. */
function webpContainer(fourcc, payload, trailing = []) {
  const body = [
    ...ascii('WEBP'),
    ...ascii(fourcc), ...u32le(payload.length),
    ...payload,
    ...trailing,
  ];
  return Uint8Array.from([...ascii('RIFF'), ...u32le(body.length), ...body]);
}

/** Lossless WebP header: 0x2f then width-1 (14b) | height-1 (14b) | alpha (1b) | version (3b). */
function vp8lHeader(width, height, alpha) {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
  return webpContainer('VP8L', [0x2f, ...u32le(bits >>> 0)]);
}

/** Extended WebP header: flags byte, 3 reserved, canvas width-1 and height-1 as 24-bit LE. */
function vp8xHeader(width, height, flags, trailingChunk = 'ANMF') {
  return webpContainer(
    'VP8X',
    [flags, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)],
    ascii(trailingChunk),
  );
}

function pngHeader(width, height, colorType, nextChunk = 'IDAT') {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), ...ascii('IHDR'),
    ...u32be(width), ...u32be(height),
    8, colorType, 0, 0, 0,
    ...u32be(0),          // IHDR CRC (not validated)
    ...u32be(0), ...ascii(nextChunk),
  ]);
}

/* ------------------------------------------------------------- real WebP file */

test('identifies a real lossy WebP file, including its dimensions', () => {
  const bytes = fixture('lossy-960x856.webp');
  const format = Sniff.detectFormat(bytes.subarray(0, Sniff.SNIFF_BYTES));

  assert.equal(format.mime, 'image/webp');
  assert.equal(format.ext, 'webp');
  assert.equal(format.variant, 'lossy');
  assert.equal(format.animated, false);
  assert.equal(format.hasAlpha, false);
  assert.equal(format.decodable, true);
  assert.equal(format.isImage, true);
  // Cross-checked against the VP8 frame header of the file on disk.
  assert.equal(format.width, 960);
  assert.equal(format.height, 856);
});

test('a 64-byte prefix is enough - the full file gives the same answer', () => {
  const bytes = fixture('lossy-960x856.webp');
  const fromPrefix = Sniff.detectFormat(bytes.subarray(0, Sniff.SNIFF_BYTES));
  const fromWhole = Sniff.detectFormat(bytes);
  assert.deepEqual(fromPrefix, fromWhole);
});

test('accepts Uint8Array, ArrayBuffer, Buffer and plain arrays alike', () => {
  const bytes = fixture('lossy-960x856.webp').subarray(0, 64);
  const asArrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const expected = 'image/webp';
  assert.equal(Sniff.detectFormat(bytes).mime, expected);
  assert.equal(Sniff.detectFormat(new Uint8Array(asArrayBuffer)).mime, expected);
  assert.equal(Sniff.detectFormat(asArrayBuffer).mime, expected);
  assert.equal(Sniff.detectFormat(Array.from(bytes)).mime, expected);
});

test('parses the real WebP variants Gecko itself produced', () => {
  // Written by test/browser/run-firefox.mjs from a 40x24 canvas whose left half was
  // rgba(255,0,0,0.5) over transparent - so the dimensions and the alpha flag below are
  // ground truth from the drawing, not from this parser. Byte layout cross-checked by hand:
  // lossy   -> RIFF/WEBP/VP8X, flags 0x10, canvas 0x27+1 x 0x17+1, next chunk ALPH
  // lossless-> RIFF/WEBP/VP8L, payload 0x2f, bitfield 0x1005c027
  const extended = Sniff.detectFormat(fixture('gecko-alpha-lossy.webp'));
  assert.equal(extended.mime, 'image/webp');
  assert.equal(extended.variant, 'extended');
  assert.equal(extended.width, 40);
  assert.equal(extended.height, 24);
  assert.equal(extended.hasAlpha, true);
  assert.equal(extended.animated, false, 'transparency must not be read as animation');

  const lossless = Sniff.detectFormat(fixture('gecko-alpha-max.webp'));
  assert.equal(lossless.mime, 'image/webp');
  assert.equal(lossless.variant, 'lossless');
  assert.equal(lossless.width, 40);
  assert.equal(lossless.height, 24);
  assert.equal(lossless.hasAlpha, true);
  assert.equal(lossless.animated, false);
});

/* ------------------------------------------------------------- WebP variants */

test('reads lossless WebP dimensions and its alpha flag', () => {
  const opaque = Sniff.detectFormat(vp8lHeader(32, 16, false));
  assert.equal(opaque.variant, 'lossless');
  assert.equal(opaque.width, 32);
  assert.equal(opaque.height, 16);
  assert.equal(opaque.hasAlpha, false);
  assert.equal(opaque.animated, false);

  const transparent = Sniff.detectFormat(vp8lHeader(1920, 1080, true));
  assert.equal(transparent.width, 1920);
  assert.equal(transparent.height, 1080);
  assert.equal(transparent.hasAlpha, true);
});

test('the VP8X feature flags match the WebP container spec', () => {
  // Hard-coded from the spec (byte 20, read MSB->LSB: Rsv Rsv ICC Alpha Exif XMP Anim Rsv).
  // Every other test below uses these literals rather than the exported constants, so a wrong
  // constant cannot quietly rewrite its own test input.
  assert.equal(Sniff.WEBP_FLAG_ALPHA, 0x10);
  assert.equal(Sniff.WEBP_FLAG_ANIMATION, 0x02);
});

test('detects animated WebP from the VP8X animation flag', () => {
  const animated = Sniff.detectFormat(vp8xHeader(100, 50, 0x02));
  assert.equal(animated.mime, 'image/webp');
  assert.equal(animated.variant, 'extended');
  assert.equal(animated.animated, true);
  assert.equal(animated.width, 100);
  assert.equal(animated.height, 50);
  assert.match(animated.label, /animated/i);
});

test('detects animated WebP from a trailing ANIM chunk even if the flag is clear', () => {
  // Some encoders have shipped this inconsistency; the chunk is the stronger statement.
  const format = Sniff.detectFormat(vp8xHeader(8, 8, 0x00, 'ANIM'));
  assert.equal(format.animated, true);
});

test('reads the VP8X alpha flag without claiming animation', () => {
  const format = Sniff.detectFormat(vp8xHeader(640, 480, 0x10, 'ALPH'));
  assert.equal(format.hasAlpha, true);
  assert.equal(format.animated, false);
  assert.match(format.label, /transparency/i);
});

test('still reports WebP for an unrecognised first chunk', () => {
  const format = Sniff.detectFormat(webpContainer('XYZW', [0, 0, 0, 0]));
  assert.equal(format.mime, 'image/webp');
  assert.equal(format.variant, 'unknown');
  assert.equal(format.animated, null, 'must not guess when the container is unfamiliar');
});

/* ------------------------------------------------------------ not-WebP checks */

test('does not mistake other RIFF files for WebP', () => {
  const wav = Uint8Array.from([...ascii('RIFF'), ...u32le(36), ...ascii('WAVEfmt ')]);
  assert.equal(Sniff.detectFormat(wav), null);
  const avi = Uint8Array.from([...ascii('RIFF'), ...u32le(36), ...ascii('AVI LIST')]);
  assert.equal(Sniff.detectFormat(avi), null);
});

test('returns null for a truncated or empty prefix', () => {
  assert.equal(Sniff.detectFormat(new Uint8Array(0)), null);
  assert.equal(Sniff.detectFormat(ascii('RI')), null);
  assert.equal(Sniff.detectFormat(ascii('RIFF')), null, 'RIFF alone is not a WebP');
  assert.equal(Sniff.detectFormat(null), null);
  assert.equal(Sniff.detectFormat(undefined), null);
});

test('returns null for arbitrary non-image bytes', () => {
  assert.equal(Sniff.detectFormat(ascii('{"json": true}')), null);
  assert.equal(Sniff.detectFormat(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00])), null); // gzip
});

/* ------------------------------------------------------------- other formats */

test('reads PNG dimensions, alpha and the absence of animation', () => {
  const rgba = Sniff.detectFormat(pngHeader(300, 200, 6));
  assert.equal(rgba.mime, 'image/png');
  assert.equal(rgba.width, 300);
  assert.equal(rgba.height, 200);
  assert.equal(rgba.hasAlpha, true);
  assert.equal(rgba.animated, false);

  const rgb = Sniff.detectFormat(pngHeader(1, 1, 2));
  assert.equal(rgb.hasAlpha, false);
});

test('recognises APNG by the acTL chunk that precedes IDAT', () => {
  const format = Sniff.detectFormat(pngHeader(64, 64, 6, 'acTL'));
  assert.equal(format.animated, true);
  assert.equal(format.mime, 'image/apng');
  assert.equal(format.ext, 'png');
});

test('recognises JPEG, GIF, AVIF, ICO, BMP, TIFF and SVG', () => {
  assert.equal(Sniff.detectFormat([0xff, 0xd8, 0xff, 0xe0]).mime, 'image/jpeg');
  assert.equal(Sniff.detectFormat([0xff, 0xd8, 0xff, 0xe0]).ext, 'jpg');

  const gif = Sniff.detectFormat([...ascii('GIF89a'), 0x20, 0x00, 0x10, 0x00]);
  assert.equal(gif.mime, 'image/gif');
  assert.equal(gif.width, 32);
  assert.equal(gif.height, 16);
  assert.equal(gif.animated, null, 'GIF89a needs a full parse to know');
  assert.equal(Sniff.detectFormat([...ascii('GIF87a'), 1, 0, 1, 0]).animated, false);

  const avif = Sniff.detectFormat([0, 0, 0, 0x20, ...ascii('ftypavif')]);
  assert.equal(avif.mime, 'image/avif');
  assert.equal(avif.animated, false);
  assert.equal(Sniff.detectFormat([0, 0, 0, 0x20, ...ascii('ftypavis')]).animated, true);
  assert.equal(Sniff.detectFormat([0, 0, 0, 0x20, ...ascii('ftypisom')]), null, 'plain mp4 is not an image');

  assert.equal(Sniff.detectFormat([0, 0, 1, 0, 1, 0]).mime, 'image/x-icon');
  assert.equal(Sniff.detectFormat([...ascii('BM'), ...u32le(1000), 0, 0, 0, 0, 54, 0, 0, 0]).mime, 'image/bmp');
  assert.equal(Sniff.detectFormat([0x49, 0x49, 0x2a, 0x00]).mime, 'image/tiff');
  assert.equal(Sniff.detectFormat(ascii('<svg xmlns="http://www.w3.org/2000/svg">')).mime, 'image/svg+xml');
  assert.equal(Sniff.detectFormat(ascii('  \n<?xml version="1.0"?><svg>')).mime, 'image/svg+xml');
});

test('marks formats a canvas cannot re-encode as not decodable', () => {
  assert.equal(Sniff.detectFormat(ascii('<svg>')).decodable, false);
  assert.equal(Sniff.detectFormat([0x49, 0x49, 0x2a, 0x00]).decodable, false);
  assert.equal(Sniff.detectFormat([0xff, 0x0a]).decodable, false, 'JPEG XL');
  assert.equal(Sniff.detectFormat([0xff, 0xd8, 0xff]).decodable, true);
});

/* ----------------------------------------------------------------- data URLs */

test('identifies a data: URL from its payload, not its label', () => {
  const bytes = fixture('lossy-960x856.webp');
  const base64 = bytes.toString('base64');

  const honest = Sniff.fromDataUrl('data:image/webp;base64,' + base64);
  assert.equal(honest.mime, 'image/webp');
  assert.equal(honest.width, 960);
  assert.equal(honest.source, 'data-url');

  // Mislabelled as JPEG: the bytes win.
  const lying = Sniff.fromDataUrl('data:image/jpeg;base64,' + base64);
  assert.equal(lying.mime, 'image/webp');
});

test('falls back to the declared type when a data: URL payload is unreadable', () => {
  const format = Sniff.fromDataUrl('data:image/webp;base64,!!!not-base64!!!');
  assert.equal(format.mime, 'image/webp');
  assert.equal(format.source, 'data-url');
});

test('handles non-base64 data: URLs (inline SVG)', () => {
  const format = Sniff.fromDataUrl('data:image/svg+xml,%3Csvg%20xmlns%3D%22x%22%3E%3C%2Fsvg%3E');
  assert.equal(format.mime, 'image/svg+xml');
});

test('parses data: URL metadata', () => {
  assert.deepEqual(Sniff.parseDataUrl('data:image/webp;base64,AAAA'), {
    mime: 'image/webp', base64: true, payload: 'AAAA',
  });
  assert.deepEqual(Sniff.parseDataUrl('data:,hello'), {
    mime: 'text/plain', base64: false, payload: 'hello',
  });
  assert.equal(Sniff.parseDataUrl('https://example.com/x.webp'), null);
});

test('rejects non-image data: URLs', () => {
  assert.equal(Sniff.fromDataUrl('data:text/html;base64,PGh0bWw+'), null);
  assert.equal(Sniff.fromDataUrl('not a url'), null);
});

/* ------------------------------------------------------------------- hints */

test('maps Content-Type headers, parameters and all', () => {
  assert.equal(Sniff.fromContentType('image/webp').mime, 'image/webp');
  assert.equal(Sniff.fromContentType('IMAGE/WEBP; charset=binary').mime, 'image/webp');
  assert.equal(Sniff.fromContentType('image/jpg').mime, 'image/jpeg', 'the non-standard spelling');
  assert.equal(Sniff.fromContentType('image/vnd.microsoft.icon').mime, 'image/x-icon');
  assert.equal(Sniff.fromContentType('image/x-experimental').ext, 'xexperimental');
  assert.equal(Sniff.fromContentType('image/x-experimental').decodable, null, 'unknown, not "no"');
  assert.equal(Sniff.fromContentType('text/html'), null);
  assert.equal(Sniff.fromContentType(''), null);
  assert.equal(Sniff.fromContentType(null), null);
  assert.equal(Sniff.fromContentType('image/webp').source, 'content-type');
});

test('guesses from a URL extension, ignoring query and fragment', () => {
  assert.equal(Sniff.guessFromUrl('https://example.com/a/b/photo.webp').mime, 'image/webp');
  assert.equal(Sniff.guessFromUrl('https://example.com/photo.WEBP?w=800&h=600').mime, 'image/webp');
  assert.equal(Sniff.guessFromUrl('https://example.com/photo.jpeg#frag').mime, 'image/jpeg');
  assert.equal(Sniff.guessFromUrl('https://example.com/image?format=webp'), null,
    'a query parameter is not a file extension');
  assert.equal(Sniff.guessFromUrl('https://example.com/'), null);
  assert.equal(Sniff.guessFromUrl('blob:https://example.com/uuid.webp'), null,
    'blob URLs carry no meaningful path');
  assert.equal(Sniff.guessFromUrl('data:image/webp;base64,AAAA'), null);
  assert.equal(Sniff.guessFromUrl('https://example.com/archive.tar.gz'), null);
});

test('pathExtension is case-folded and query-free', () => {
  assert.equal(Sniff.pathExtension('https://x.test/A.WeBp?q=1'), 'webp');
  assert.equal(Sniff.pathExtension('/local/path/file.png'), 'png');
  assert.equal(Sniff.pathExtension('https://x.test/no-extension'), '');
});

test('isWebp and describe', () => {
  const bytes = fixture('lossy-960x856.webp');
  const format = Sniff.detectFormat(bytes);
  assert.equal(Sniff.isWebp(format), true);
  assert.equal(Sniff.isWebp(Sniff.detectFormat([0xff, 0xd8, 0xff])), false);
  assert.equal(Sniff.isWebp(null), false);
  assert.equal(Sniff.describe(format), 'WebP (lossy) 960×856');
  assert.equal(Sniff.describe(null), 'unknown format');
});
