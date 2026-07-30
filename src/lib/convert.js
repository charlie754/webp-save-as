'use strict';
/**
 * Decode an image blob and re-encode it as JPEG or PNG, entirely in-process.
 *
 * Decoding goes through createImageBitmap (which handles WebP, including animated WebP by
 * taking the first frame) and falls back to an <img> element when a bitmap cannot be made.
 * Encoding prefers OffscreenCanvas so this also works from a worker-style background context,
 * and falls back to a DOM <canvas>.
 *
 * No extension APIs are used here, so this file is loadable in a plain page (see test/browser).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
  else root.ImageConvert = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FORMATS = {
    jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPG', usesQuality: true, keepsAlpha: false },
    png: { mime: 'image/png', ext: 'png', label: 'PNG', usesQuality: false, keepsAlpha: true },
  };

  /** Firefox canvas limits: 32767 per side, and ~124M pixels total. */
  const MAX_SIDE = 32767;
  const MAX_PIXELS = 124000000;
  const DEFAULT_QUALITY = 0.92;
  const DEFAULT_BACKGROUND = '#ffffff';
  const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  /** Accepts 0-1 or 1-100; anything unusable becomes the default. 1 means "maximum". */
  function normalizeQuality(value) {
    const n = typeof value === 'string' ? parseFloat(value) : value;
    if (typeof n !== 'number' || !isFinite(n)) return DEFAULT_QUALITY;
    const scaled = n > 1 ? n / 100 : n;
    if (!isFinite(scaled)) return DEFAULT_QUALITY;
    return Math.min(1, Math.max(0.05, scaled));
  }

  /**
   * Only #rgb / #rrggbb is allowed: assigning an invalid value to ctx.fillStyle is a silent
   * no-op, which would leave the JPEG backdrop black instead of the colour the user chose.
   */
  function normalizeBackground(value) {
    const s = String(value == null ? '' : value).trim();
    return HEX_COLOR.test(s) ? s : DEFAULT_BACKGROUND;
  }

  function resolveFormat(format) {
    const key = String(format || '').toLowerCase();
    if (key === 'jpg') return FORMATS.jpeg;
    if (FORMATS[key]) return FORMATS[key];
    throw new Error('Unsupported target format: ' + format);
  }

  /* ----------------------------------------------------------------- decoding */

  function decodeWithImageElement(blob) {
    if (typeof Image !== 'function' || typeof URL === 'undefined' || !URL.createObjectURL) {
      return Promise.reject(new Error('No <img> decoder available in this context'));
    }
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      let settled = false;
      const finish = function (fn, arg) {
        if (settled) return;
        settled = true;
        fn(arg);
      };
      img.onload = function () {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        if (!width || !height) {
          URL.revokeObjectURL(url);
          finish(reject, new Error('Image decoded to zero size'));
          return;
        }
        finish(resolve, {
          source: img,
          width: width,
          height: height,
          release: function () { URL.revokeObjectURL(url); },
        });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        finish(reject, new Error('The browser could not decode this image'));
      };
      img.src = url;
    });
  }

  async function decode(blob) {
    let firstError = null;
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob);
        if (bitmap.width && bitmap.height) {
          return {
            source: bitmap,
            width: bitmap.width,
            height: bitmap.height,
            release: function () { if (bitmap.close) bitmap.close(); },
          };
        }
        if (bitmap.close) bitmap.close();
        firstError = new Error('Image decoded to zero size');
      } catch (err) {
        firstError = err;
      }
    }
    try {
      return await decodeWithImageElement(blob);
    } catch (err) {
      throw firstError || err;
    }
  }

  /* ----------------------------------------------------------------- encoding */

  function createCanvas(width, height, alpha) {
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { alpha: alpha });
      if (ctx && typeof canvas.convertToBlob === 'function') {
        return {
          ctx: ctx,
          kind: 'offscreen',
          toBlob: function (mime, quality) {
            return canvas.convertToBlob({ type: mime, quality: quality });
          },
        };
      }
    }
    if (typeof document !== 'undefined' && document.createElement) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: alpha });
      if (ctx) {
        return {
          ctx: ctx,
          kind: 'dom',
          toBlob: function (mime, quality) {
            return new Promise(function (resolve, reject) {
              canvas.toBlob(function (blob) {
                if (blob) resolve(blob);
                else reject(new Error('canvas.toBlob() produced nothing'));
              }, mime, quality);
            });
          },
        };
      }
    }
    throw new Error('No canvas implementation available in this context');
  }

  /**
   * @param {Blob} blob source image bytes
   * @param {{format: 'jpeg'|'png', quality?: number, background?: string}} options
   * @returns {Promise<{blob: Blob, width: number, height: number, mime: string, ext: string,
   *                    label: string, quality: number|null, encoder: string}>}
   */
  async function convertImage(blob, options) {
    const opts = options || {};
    const target = resolveFormat(opts.format);
    if (!blob || typeof blob.size !== 'number') throw new Error('convertImage() needs a Blob');
    if (blob.size === 0) throw new Error('The image file is empty');

    const decoded = await decode(blob);
    try {
      const width = decoded.width;
      const height = decoded.height;
      if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
        throw new Error('Image is too large to convert (' + width + '×' + height + ')');
      }

      const canvas = createCanvas(width, height, target.keepsAlpha);
      const ctx = canvas.ctx;
      if (!target.keepsAlpha) {
        // JPEG has no alpha channel; without this, transparent pixels turn black.
        ctx.fillStyle = normalizeBackground(opts.background);
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(decoded.source, 0, 0);

      const quality = target.usesQuality ? normalizeQuality(opts.quality) : undefined;
      const out = await canvas.toBlob(target.mime, quality);
      if (!out || !out.size) throw new Error('Encoding produced an empty file');
      // Canvas encoders silently fall back to PNG for a type they do not support - catch that
      // rather than handing the user a .jpg that is really a PNG.
      if (out.type && out.type !== target.mime) {
        throw new Error('This browser encoded ' + out.type + ' instead of ' + target.mime);
      }

      return {
        blob: out,
        width: width,
        height: height,
        mime: target.mime,
        ext: target.ext,
        label: target.label,
        quality: quality === undefined ? null : quality,
        encoder: canvas.kind,
      };
    } finally {
      if (decoded.release) decoded.release();
    }
  }

  return {
    FORMATS: FORMATS,
    MAX_SIDE: MAX_SIDE,
    MAX_PIXELS: MAX_PIXELS,
    DEFAULT_QUALITY: DEFAULT_QUALITY,
    DEFAULT_BACKGROUND: DEFAULT_BACKGROUND,
    normalizeQuality: normalizeQuality,
    normalizeBackground: normalizeBackground,
    resolveFormat: resolveFormat,
    decode: decode,
    convertImage: convertImage,
  };
});
