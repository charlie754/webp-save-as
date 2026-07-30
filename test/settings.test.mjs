import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Settings = require('../src/lib/settings.js');
const Convert = require('../src/lib/convert.js');

test('normalize() fills in every default', () => {
  const out = Settings.normalize(null);
  assert.deepEqual(out, Settings.DEFAULTS);
  assert.deepEqual(Settings.normalize(undefined), Settings.DEFAULTS);
  assert.deepEqual(Settings.normalize('garbage'), Settings.DEFAULTS);
  assert.deepEqual(Settings.normalize({}), Settings.DEFAULTS);
});

test('normalize() ignores non-boolean values for flags', () => {
  const out = Settings.normalize({ askWhereToSave: 'yes', notifyOnSuccess: 1, warnAnimated: null });
  assert.equal(out.askWhereToSave, Settings.DEFAULTS.askWhereToSave);
  assert.equal(out.notifyOnSuccess, Settings.DEFAULTS.notifyOnSuccess);
  assert.equal(out.warnAnimated, Settings.DEFAULTS.warnAnimated);
});

test('normalize() keeps real boolean choices', () => {
  const out = Settings.normalize({ askWhereToSave: true, notifyOnError: false, showForAllImages: true });
  assert.equal(out.askWhereToSave, true);
  assert.equal(out.notifyOnError, false);
  assert.equal(out.showForAllImages, true);
});

test('normalize() accepts quality as a fraction or a percentage and clamps it', () => {
  assert.equal(Settings.normalize({ jpegQuality: 0.5 }).jpegQuality, 0.5);
  assert.equal(Settings.normalize({ jpegQuality: 75 }).jpegQuality, 0.75);
  assert.equal(Settings.normalize({ jpegQuality: '0.6' }).jpegQuality, 0.6);
  assert.equal(Settings.normalize({ jpegQuality: 1 }).jpegQuality, 1, '1 means maximum, not 1%');
  assert.equal(Settings.normalize({ jpegQuality: 5000 }).jpegQuality, 1);
  assert.equal(Settings.normalize({ jpegQuality: 0 }).jpegQuality, 0.05);
  assert.equal(Settings.normalize({ jpegQuality: -3 }).jpegQuality, 0.05);
  assert.equal(Settings.normalize({ jpegQuality: 'high' }).jpegQuality, Settings.DEFAULTS.jpegQuality);
  assert.equal(Settings.normalize({ jpegQuality: NaN }).jpegQuality, Settings.DEFAULTS.jpegQuality);
  assert.equal(Settings.normalize({ jpegQuality: Infinity }).jpegQuality, Settings.DEFAULTS.jpegQuality);
});

test('normalize() only accepts hex colours', () => {
  assert.equal(Settings.normalize({ jpegBackground: '#000000' }).jpegBackground, '#000000');
  assert.equal(Settings.normalize({ jpegBackground: '#ABC' }).jpegBackground, '#abc');
  assert.equal(Settings.normalize({ jpegBackground: '  #1c1b22  ' }).jpegBackground, '#1c1b22');
  // A named colour would be accepted by fillStyle but not by <input type=color>; reject it so the
  // UI and the encoder cannot disagree about what the background is.
  assert.equal(Settings.normalize({ jpegBackground: 'white' }).jpegBackground, '#ffffff');
  assert.equal(Settings.normalize({ jpegBackground: '#gggggg' }).jpegBackground, '#ffffff');
  assert.equal(Settings.normalize({ jpegBackground: 'rgb(0,0,0)' }).jpegBackground, '#ffffff');
  assert.equal(Settings.normalize({ jpegBackground: 42 }).jpegBackground, '#ffffff');
});

test('normalize() refuses to leave the extension with no menu items', () => {
  const out = Settings.normalize({ showJpg: false, showPng: false });
  assert.equal(out.showJpg, true);
  assert.equal(out.showPng, true);

  const onlyPng = Settings.normalize({ showJpg: false, showPng: true });
  assert.equal(onlyPng.showJpg, false);
  assert.equal(onlyPng.showPng, true);
});

test('normalize() drops unknown keys', () => {
  const out = Settings.normalize({ nonsense: true, jpegQuality: 0.8 });
  assert.equal('nonsense' in out, false);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(Settings.DEFAULTS).sort());
});

test('BOOLEAN_KEYS covers exactly the boolean defaults', () => {
  const actual = Object.keys(Settings.DEFAULTS)
    .filter((k) => typeof Settings.DEFAULTS[k] === 'boolean')
    .sort();
  assert.deepEqual([...Settings.BOOLEAN_KEYS].sort(), actual);
});

test('the settings and encoder defaults agree', () => {
  assert.equal(Settings.DEFAULTS.jpegQuality, Convert.DEFAULT_QUALITY);
  assert.equal(Settings.DEFAULTS.jpegBackground, Convert.DEFAULT_BACKGROUND);
});
