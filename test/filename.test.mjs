import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Names = require('../src/lib/filename.js');

const FIXED = new Date(2026, 6, 29, 14, 30, 12); // 2026-07-29 14:30:12 local

const derive = (url, ext = 'jpg') => Names.deriveFilename(url, ext, { now: FIXED });

test('swaps a .webp extension for the target one', () => {
  assert.equal(derive('https://example.com/photo.webp'), 'photo.jpg');
  assert.equal(derive('https://example.com/photo.webp', 'png'), 'photo.png');
  assert.equal(derive('https://example.com/a/b/c/deep-name.webp'), 'deep-name.jpg');
});

test('ignores query strings and fragments', () => {
  assert.equal(derive('https://cdn.example.com/img/cat.webp?w=800&fm=webp&q=75'), 'cat.jpg');
  assert.equal(derive('https://cdn.example.com/img/cat.webp#top'), 'cat.jpg');
});

test('keeps a name that has no extension', () => {
  assert.equal(derive('https://cdn.example.com/i/AbC123'), 'AbC123.jpg');
  assert.equal(derive('https://images.example.com/render?id=99'), 'render.jpg');
});

test('percent-decodes the name', () => {
  assert.equal(derive('https://example.com/my%20holiday%20photo.webp'), 'my holiday photo.jpg');
  assert.equal(derive('https://example.com/%E6%97%A5%E6%9C%AC.webp'), '日本.jpg');
});

test('survives a malformed percent-escape instead of throwing', () => {
  assert.equal(derive('https://example.com/bad%ZZ.webp'), 'bad%ZZ.jpg');
});

test('strips a doubled image extension but leaves version numbers alone', () => {
  assert.equal(derive('https://example.com/photo.jpeg.webp'), 'photo.jpg');
  assert.equal(derive('https://example.com/logo-v1.2.webp'), 'logo-v1.2.jpg');
  assert.equal(derive('https://example.com/backup.tar.webp'), 'backup.tar.jpg');
});

test('falls back to a timestamp when the URL carries no name', () => {
  const expected = 'image-20260729-143012.jpg';
  assert.equal(derive('https://example.com/'), expected);
  assert.equal(derive('https://example.com'), expected);
  assert.equal(derive('blob:https://example.com/2a8e1f10-0000-4000-8000-abcdefabcdef'), expected);
  assert.equal(derive('data:image/webp;base64,UklGRg=='), expected);
});

test('honours a custom fallback prefix', () => {
  assert.equal(
    Names.deriveFilename('data:image/webp;base64,AAAA', 'png', { fallbackPrefix: 'clipboard', now: FIXED }),
    'clipboard-20260729-143012.png',
  );
});

test('removes characters Windows forbids', () => {
  assert.equal(derive('https://example.com/a%3Ab%2Ac%3Fd.webp'), 'a b c d.jpg');
  assert.equal(Names.sanitizeBase('one<two>three:four"five|six?seven*eight'),
    'one two three four five six seven eight');
});

test('does not glue words together when removing separators', () => {
  assert.equal(Names.sanitizeBase('left|right'), 'left right');
});

test('strips control characters', () => {
  assert.equal(Names.sanitizeBase('bell\u0007tab\u0009del\u007fend'), 'bell tab del end');
});

test('never produces a leading or trailing dot', () => {
  assert.equal(Names.sanitizeBase('  ...name...  '), 'name');
  assert.equal(derive('https://example.com/.webp'), 'webp.jpg');
  assert.equal(derive('https://example.com/...'), 'image-20260729-143012.jpg');
});

test('escapes Windows reserved device names', () => {
  assert.equal(derive('https://example.com/CON.webp'), '_CON.jpg');
  assert.equal(derive('https://example.com/nul.webp'), '_nul.jpg');
  assert.equal(derive('https://example.com/com4.webp'), '_com4.jpg');
  assert.equal(derive('https://example.com/console.webp'), 'console.jpg', 'only exact matches');
});

test('caps the length and does not leave a dangling dot after truncation', () => {
  const long = 'x'.repeat(300);
  const out = derive(`https://example.com/${long}.webp`);
  assert.equal(out.length, Names.MAX_BASE_LENGTH + 4);
  assert.equal(out.slice(-4), '.jpg');

  const dotted = derive(`https://example.com/${'y'.repeat(99)}...tail.webp`);
  assert.ok(!dotted.includes('..'), 'no ".." can reach downloads.download()');
  assert.equal(dotted, 'y'.repeat(99) + '.jpg');
});

test('cannot emit a path, so it cannot escape the download folder', () => {
  for (const url of [
    'https://example.com/../../etc/passwd.webp',
    'https://example.com/a/..%2F..%2Fsecret.webp',
    'https://example.com/%2e%2e%2f%2e%2e%2fboot.webp',
  ]) {
    const out = derive(url);
    assert.ok(!out.includes('/'), `${url} -> ${out} must not contain a slash`);
    assert.ok(!out.includes('\\'), `${url} -> ${out} must not contain a backslash`);
    assert.ok(!out.includes('..'), `${url} -> ${out} must not contain ".."`);
  }
});

test('rejects an implausible target extension rather than writing it', () => {
  assert.equal(Names.deriveFilename('https://e.com/a.webp', 'exe;rm -rf', { now: FIXED }), 'a.bin');
  assert.equal(Names.deriveFilename('https://e.com/a.webp', '', { now: FIXED }), 'a.bin');
  assert.equal(Names.deriveFilename('https://e.com/a.webp', 'PNG', { now: FIXED }), 'a.png');
});

test('accepts a bare path or an unparseable string', () => {
  assert.equal(derive('/images/local.webp'), 'local.jpg');
  assert.equal(derive('images/local.webp?x=1'), 'local.jpg');
  assert.equal(derive('C:\\Users\\me\\pic.webp'), 'pic.jpg');
});

test('basenameFromUrl returns nothing usable for data: and blob: URLs', () => {
  assert.equal(Names.basenameFromUrl('data:image/webp;base64,AAAA'), '');
  assert.equal(Names.basenameFromUrl('blob:https://example.com/uuid'), '');
  assert.equal(Names.basenameFromUrl('https://example.com/a/b/'), 'b');
});

test('stripImageExtension only touches known image extensions', () => {
  assert.equal(Names.stripImageExtension('a.webp'), 'a');
  assert.equal(Names.stripImageExtension('a.WEBP'), 'a');
  assert.equal(Names.stripImageExtension('a.zip'), 'a.zip');
  assert.equal(Names.stripImageExtension('.webp'), '.webp', 'nothing before the dot to keep');
  assert.equal(Names.stripImageExtension(''), '');
});

test('timestampBase pads every field to two digits', () => {
  assert.equal(Names.timestampBase('image', new Date(2026, 0, 2, 3, 4, 5)), 'image-20260102-030405');
  assert.equal(Names.timestampBase('image', new Date('not a date')).length, 'image-20260102-030405'.length,
    'an invalid date falls back to now, not to NaN');
});
