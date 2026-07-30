'use strict';
/**
 * Turns an image URL into a download filename that Windows, macOS and Linux all accept.
 *
 * downloads.download() rejects absolute paths, "..", and (on Windows) a set of characters and
 * reserved device names, so we normalise here rather than letting the call fail.
 * Loadable as a classic extension script (`globalThis.ImageFilename`) or a CommonJS module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
  else root.ImageFilename = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /** Extensions we are willing to drop from the source name before appending our own. */
  const IMAGE_EXTENSIONS = [
    'webp', 'png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp',
    'gif', 'avif', 'avifs', 'bmp', 'dib', 'ico', 'cur', 'svg',
    'tif', 'tiff', 'jxl', 'heic', 'heif',
  ];
  const IMAGE_EXTENSION_SET = IMAGE_EXTENSIONS.reduce(function (acc, e) { acc[e] = true; return acc; }, {});

  /* eslint-disable-next-line no-control-regex */
  const INVALID_CHARS = /[\u0000-\u001f\u007f<>:"\/\\|?*]/g;
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
  const MAX_BASE_LENGTH = 100;

  /**
   * Last path segment of a URL, percent-decoded. Returns '' for URLs that carry no useful
   * name (data:, blob:, or a path that is all slashes) so the caller can fall back.
   */
  function basenameFromUrl(url) {
    const raw = String(url == null ? '' : url);
    let path;
    try {
      const parsed = new URL(raw);
      // blob:https://host/uuid and data:... have nothing human-readable to salvage.
      if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return '';
      path = parsed.pathname || '';
    } catch (err) {
      path = raw.split('#')[0].split('?')[0];
    }
    // Split on both separators: a Windows path reaches us as an opaque "C:\..." URL whose
    // pathname keeps its backslashes.
    const segments = path.split(/[/\\]/);
    let last = '';
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i]) { last = segments[i]; break; }
    }
    try {
      last = decodeURIComponent(last);
    } catch (err) {
      /* malformed %-escape: keep the raw segment */
    }
    return last;
  }

  /**
   * Drop a trailing image extension so "photo.webp" -> "photo" rather than "photo.webp.jpg".
   * Runs at most twice to catch "photo.jpeg.webp", and never on a leading-dot-only name.
   */
  function stripImageExtension(name) {
    let out = String(name == null ? '' : name);
    for (let i = 0; i < 2; i++) {
      const m = /^(.+)\.([A-Za-z0-9]{1,5})$/.exec(out);
      if (!m) break;
      if (!IMAGE_EXTENSION_SET[m[2].toLowerCase()]) break;
      out = m[1];
    }
    return out;
  }

  /** Strip characters no filesystem wants, collapse whitespace, and cap the length. */
  function sanitizeBase(name) {
    let out = String(name == null ? '' : name);
    // Space rather than '' so "a/b" becomes "a b" instead of "ab".
    out = out.replace(INVALID_CHARS, ' ');
    out = out.replace(/\s+/g, ' ').trim();
    // Leading dots hide the file on unix; trailing dots and spaces are silently dropped by Windows.
    out = out.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    if (out.length > MAX_BASE_LENGTH) {
      out = out.slice(0, MAX_BASE_LENGTH).replace(/[.\s]+$/, '');
    }
    if (WINDOWS_RESERVED.test(out)) out = '_' + out;
    return out;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Fallback name for sources with no filename, e.g. "image-20260729-143012". */
  function timestampBase(prefix, now) {
    const d = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
    return String(prefix || 'image') + '-' +
      d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  /**
   * @param {string} url source image URL
   * @param {string} ext target extension without a dot, e.g. 'jpg'
   * @param {{fallbackPrefix?: string, now?: Date}} [options]
   * @returns {string} a relative filename safe to hand to downloads.download()
   */
  function deriveFilename(url, ext, options) {
    const opts = options || {};
    const safeExt = /^[A-Za-z0-9]{1,5}$/.test(String(ext || '')) ? String(ext).toLowerCase() : 'bin';
    let base = sanitizeBase(stripImageExtension(basenameFromUrl(url)));
    if (!base) base = sanitizeBase(timestampBase(opts.fallbackPrefix || 'image', opts.now));
    if (!base) base = 'image';
    return base + '.' + safeExt;
  }

  return {
    IMAGE_EXTENSIONS: IMAGE_EXTENSIONS,
    MAX_BASE_LENGTH: MAX_BASE_LENGTH,
    basenameFromUrl: basenameFromUrl,
    stripImageExtension: stripImageExtension,
    sanitizeBase: sanitizeBase,
    timestampBase: timestampBase,
    deriveFilename: deriveFilename,
  };
});
