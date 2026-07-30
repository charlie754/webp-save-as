'use strict';
/**
 * Settings: defaults, validation, and a cached read from browser.storage.local.
 *
 * Stored as flat keys so storage.onChanged deltas are easy to apply. Every read is validated,
 * because storage can hold anything a previous version (or a hand edit) put there.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
  else root.ExtSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULTS = {
    /** Show the "Save Image as JPG" menu item. */
    showJpg: true,
    /** Show the "Save Image as PNG" menu item. */
    showPng: true,
    /** false = only offer the menu for WebP images; true = offer it for any image. */
    showForAllImages: false,
    /** Read the first bytes of the image to identify it (a cache hit costs no network request). */
    sniffBytes: true,
    /** Hide the menu when the format could not be identified, instead of offering it anyway. */
    hideWhenUnknown: false,
    /** JPEG quality, 0.05-1. */
    jpegQuality: 0.92,
    /** Colour painted under transparent pixels when writing JPEG. */
    jpegBackground: '#ffffff',
    /** Open the file picker instead of saving straight to the downloads folder. */
    askWhereToSave: false,
    /** If the image is already the requested format, save the original bytes untouched. */
    passthroughSameFormat: true,
    /** Notify when a conversion fails. */
    notifyOnError: true,
    /** Notify on every successful save. */
    notifyOnSuccess: false,
    /** Notify when only the first frame of an animated image was saved. */
    warnAnimated: true,
  };

  const BOOLEAN_KEYS = [
    'showJpg', 'showPng', 'showForAllImages', 'sniffBytes', 'hideWhenUnknown',
    'askWhereToSave', 'passthroughSameFormat', 'notifyOnError', 'notifyOnSuccess', 'warnAnimated',
  ];

  const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  /** Coerce a raw storage object into a complete, valid settings object. */
  function normalize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (let i = 0; i < BOOLEAN_KEYS.length; i++) {
      const key = BOOLEAN_KEYS[i];
      out[key] = typeof src[key] === 'boolean' ? src[key] : DEFAULTS[key];
    }
    const q = typeof src.jpegQuality === 'string' ? parseFloat(src.jpegQuality) : src.jpegQuality;
    out.jpegQuality = typeof q === 'number' && isFinite(q)
      ? Math.min(1, Math.max(0.05, q > 1 ? q / 100 : q))
      : DEFAULTS.jpegQuality;
    const bg = typeof src.jpegBackground === 'string' ? src.jpegBackground.trim() : '';
    out.jpegBackground = HEX_COLOR.test(bg) ? bg.toLowerCase() : DEFAULTS.jpegBackground;
    // At least one menu item has to exist or the extension does nothing at all.
    if (!out.showJpg && !out.showPng) {
      out.showJpg = true;
      out.showPng = true;
    }
    return out;
  }

  let cache = null;

  function storageArea() {
    if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) return browser.storage.local;
    return null;
  }

  async function get() {
    if (cache) return cache;
    const area = storageArea();
    if (!area) {
      cache = normalize(null);
      return cache;
    }
    let raw = null;
    try {
      raw = await area.get(Object.keys(DEFAULTS));
    } catch (err) {
      raw = null;
    }
    cache = normalize(raw);
    return cache;
  }

  async function set(patch) {
    const area = storageArea();
    const merged = normalize(Object.assign({}, await get(), patch || {}));
    cache = merged;
    if (area) await area.set(merged);
    return merged;
  }

  async function reset() {
    const area = storageArea();
    cache = normalize(null);
    if (area) await area.set(cache);
    return cache;
  }

  function invalidate() { cache = null; }

  /** Keep the cache honest when another context (the options page) writes. */
  if (typeof browser !== 'undefined' && browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName === 'local') invalidate();
    });
  }

  return {
    DEFAULTS: DEFAULTS,
    BOOLEAN_KEYS: BOOLEAN_KEYS,
    normalize: normalize,
    get: get,
    set: set,
    reset: reset,
    invalidate: invalidate,
  };
});
