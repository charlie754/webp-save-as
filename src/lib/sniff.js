'use strict';
/**
 * Image format detection from magic bytes, with URL / Content-Type / data-URL fallbacks.
 *
 * File extensions lie constantly (CDNs serve WebP from `.jpg` paths and vice versa), so the
 * byte sniffer is the source of truth and everything else is a hint. Loadable both as a
 * classic extension script (exposes `globalThis.ImageSniff`) and as a CommonJS module (tests).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
  else root.ImageSniff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * Bytes to read before deciding. 64 covers the longest thing we look at:
   * a RIFF/WEBP header (12) + VP8X chunk (18) + the following chunk's FourCC (4) = 34,
   * and a PNG signature (8) + IHDR chunk (25) + the next chunk's type (8) = 41.
   */
  const SNIFF_BYTES = 64;

  /** VP8X feature flags (WebP container spec, byte 20 of the file). */
  const WEBP_FLAG_ALPHA = 0x10;
  const WEBP_FLAG_ANIMATION = 0x02;

  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const VP8_START_CODE = [0x9d, 0x01, 0x2a];

  /** Extension -> MIME, used only as a hint when we have no bytes. */
  const EXT_TO_MIME = {
    webp: 'image/webp',
    png: 'image/png',
    apng: 'image/apng',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jpe: 'image/jpeg',
    jfif: 'image/jpeg',
    pjpeg: 'image/jpeg',
    pjp: 'image/jpeg',
    gif: 'image/gif',
    avif: 'image/avif',
    avifs: 'image/avif',
    bmp: 'image/bmp',
    dib: 'image/bmp',
    ico: 'image/x-icon',
    cur: 'image/x-icon',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    jxl: 'image/jxl',
    heic: 'image/heic',
    heif: 'image/heic',
  };

  /** MIME -> descriptor. `decodable` = can a <canvas> pipeline in Firefox actually re-encode it. */
  const MIME_INFO = {
    'image/webp': { ext: 'webp', label: 'WebP', decodable: true },
    'image/png': { ext: 'png', label: 'PNG', decodable: true },
    'image/apng': { ext: 'png', label: 'APNG', decodable: true },
    'image/jpeg': { ext: 'jpg', label: 'JPEG', decodable: true },
    'image/gif': { ext: 'gif', label: 'GIF', decodable: true },
    'image/avif': { ext: 'avif', label: 'AVIF', decodable: true },
    'image/bmp': { ext: 'bmp', label: 'BMP', decodable: true },
    'image/x-icon': { ext: 'ico', label: 'Icon', decodable: true },
    'image/heic': { ext: 'heic', label: 'HEIC', decodable: false },
    'image/svg+xml': { ext: 'svg', label: 'SVG', decodable: false },
    'image/tiff': { ext: 'tiff', label: 'TIFF', decodable: false },
    'image/jxl': { ext: 'jxl', label: 'JPEG XL', decodable: false },
  };

  function toBytes(input) {
    if (input == null) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (Array.isArray(input)) return Uint8Array.from(input);
    if (input.buffer instanceof ArrayBuffer) {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    }
    return new Uint8Array(0);
  }

  /** FourCC / ASCII tag read. Returns a short string if the range runs past the end. */
  function ascii(bytes, offset, length) {
    let out = '';
    for (let i = offset; i < offset + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function matches(bytes, signature, offset) {
    const at = offset || 0;
    if (bytes.length < at + signature.length) return false;
    for (let i = 0; i < signature.length; i++) {
      if (bytes[at + i] !== signature[i]) return false;
    }
    return true;
  }

  function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
  function u24le(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }
  function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

  function make(mime, extra) {
    const info = MIME_INFO[mime] || {};
    return Object.assign({
      mime: mime,
      ext: info.ext || 'bin',
      label: info.label || mime,
      isImage: /^image\//.test(mime),
      decodable: info.decodable === undefined ? null : info.decodable,
      /** true / false / null when it cannot be determined from the sniffed prefix. */
      animated: null,
      hasAlpha: null,
      width: null,
      height: null,
      variant: null,
      source: 'bytes',
    }, extra || {});
  }

  /* ------------------------------------------------------------------ WebP */

  /**
   * WebP is a RIFF container: "RIFF" <u32 size> "WEBP" then chunks.
   * The first chunk's FourCC tells us the flavour: VP8 (lossy), VP8L (lossless), VP8X (extended).
   */
  function detectWebp(b) {
    if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
    const fourcc = ascii(b, 12, 4);

    if (fourcc === 'VP8 ') {
      const f = make('image/webp', { variant: 'lossy', label: 'WebP (lossy)', animated: false, hasAlpha: false });
      // Frame header: 3-byte tag, 3-byte start code, then 14-bit width and height.
      if (matches(b, VP8_START_CODE, 23) && b.length >= 30) {
        f.width = u16le(b, 26) & 0x3fff;
        f.height = u16le(b, 28) & 0x3fff;
      }
      return f;
    }

    if (fourcc === 'VP8L') {
      const f = make('image/webp', { variant: 'lossless', label: 'WebP (lossless)', animated: false });
      // Payload: 0x2f signature, then bitfields packed LSB-first:
      // width-1 (14) | height-1 (14) | alpha_is_used (1) | version (3).
      if (b.length >= 25 && b[20] === 0x2f) {
        const v = u32le(b, 21);
        f.width = (v & 0x3fff) + 1;
        f.height = ((v >>> 14) & 0x3fff) + 1;
        f.hasAlpha = ((v >>> 28) & 1) === 1;
      }
      return f;
    }

    if (fourcc === 'VP8X') {
      const f = make('image/webp', { variant: 'extended', label: 'WebP (extended)' });
      if (b.length >= 30) {
        const flags = b[20];
        f.hasAlpha = (flags & WEBP_FLAG_ALPHA) !== 0;
        // Trust the flag, but an explicit ANIM chunk right after VP8X is the same statement.
        f.animated = (flags & WEBP_FLAG_ANIMATION) !== 0 || ascii(b, 30, 4) === 'ANIM';
        f.width = u24le(b, 24) + 1;
        f.height = u24le(b, 27) + 1;
        if (f.animated) f.label = 'WebP (animated)';
        else if (f.hasAlpha) f.label = 'WebP (with transparency)';
      }
      return f;
    }

    // A RIFF/WEBP container we do not recognise the first chunk of. Still a WebP.
    return make('image/webp', { variant: 'unknown' });
  }

  /* ------------------------------------------------------------ everything else */

  function detectPng(b) {
    if (!matches(b, PNG_SIGNATURE, 0)) return null;
    const f = make('image/png');
    if (ascii(b, 12, 4) === 'IHDR' && b.length >= 26) {
      f.width = u32be(b, 16);
      f.height = u32be(b, 20);
      const colorType = b[25];
      f.hasAlpha = colorType === 4 || colorType === 6;
    }
    // APNG puts an acTL chunk before the first IDAT; IHDR is always first, so look right after it.
    if (b.length >= 41) {
      const next = ascii(b, 37, 4);
      if (next === 'acTL') {
        f.animated = true;
        f.mime = 'image/apng';
        f.label = 'APNG (animated)';
      } else if (next === 'IDAT') {
        f.animated = false;
      }
    }
    return f;
  }

  function detectIsoBmff(b) {
    if (ascii(b, 4, 4) !== 'ftyp') return null;
    const brand = ascii(b, 8, 4);
    if (brand === 'avif') return make('image/avif', { animated: false, label: 'AVIF' });
    if (brand === 'avis') return make('image/avif', { animated: true, label: 'AVIF (animated)' });
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx' ||
        brand === 'mif1' || brand === 'msf1') {
      return make('image/heic', { animated: brand === 'msf1' || brand === 'hevc' });
    }
    return null; // some other ISO-BMFF file (mp4, mov, ...) - not an image we handle
  }

  function detectSvg(b) {
    // Skip a UTF-8 BOM and leading whitespace, then look for an XML or <svg> opening.
    let i = 0;
    if (matches(b, [0xef, 0xbb, 0xbf], 0)) i = 3;
    while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
    if (b[i] !== 0x3c /* '<' */) return null;
    const head = ascii(b, i, b.length - i).toLowerCase();
    if (head.indexOf('<svg') === 0 || head.indexOf('<?xml') === 0 || head.indexOf('<!doctype svg') === 0) {
      return make('image/svg+xml');
    }
    return null;
  }

  /**
   * Identify an image from its leading bytes.
   * @param {Uint8Array|ArrayBuffer|number[]} input first bytes of the file (SNIFF_BYTES is plenty)
   * @returns {object|null} format descriptor, or null when nothing matched
   */
  function detectFormat(input) {
    const b = toBytes(input);
    // Two bytes is the shortest complete signature we know (a raw JPEG XL codestream).
    if (b.length < 2) return null;

    const webp = detectWebp(b);
    if (webp) return webp;

    const png = detectPng(b);
    if (png) return png;

    if (matches(b, [0xff, 0xd8, 0xff], 0)) {
      return make('image/jpeg', { animated: false, hasAlpha: false });
    }

    if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') {
      const f = make('image/gif');
      if (b.length >= 10) { f.width = u16le(b, 6); f.height = u16le(b, 8); }
      // GIF87a predates the animation extension; GIF89a needs a full parse to know.
      if (ascii(b, 0, 6) === 'GIF87a') f.animated = false;
      return f;
    }

    const iso = detectIsoBmff(b);
    if (iso) return iso;

    if (matches(b, [0x00, 0x00, 0x01, 0x00], 0) || matches(b, [0x00, 0x00, 0x02, 0x00], 0)) {
      return make('image/x-icon', { animated: false });
    }

    if (matches(b, [0x49, 0x49, 0x2a, 0x00], 0) || matches(b, [0x4d, 0x4d, 0x00, 0x2a], 0)) {
      return make('image/tiff', { animated: false });
    }

    // JPEG XL: raw codestream (FF 0A) or ISO-BMFF-wrapped container.
    if (matches(b, [0xff, 0x0a], 0) ||
        matches(b, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a], 0)) {
      return make('image/jxl', { animated: null });
    }

    if (ascii(b, 0, 2) === 'BM' && b.length >= 14) {
      return make('image/bmp', { animated: false });
    }

    const svg = detectSvg(b);
    if (svg) return svg;

    return null;
  }

  /* ------------------------------------------------------------------ hints */

  /**
   * Build a descriptor from a Content-Type header or Blob.type. Weaker than bytes: servers
   * mislabel images routinely, so only use this when the bytes are unavailable.
   */
  function fromContentType(contentType, source) {
    if (!contentType) return null;
    const mime = String(contentType).split(';')[0].trim().toLowerCase();
    if (!mime) return null;
    if (MIME_INFO[mime]) return make(mime, { source: source || 'content-type' });
    if (mime === 'image/jpg') return make('image/jpeg', { source: source || 'content-type' });
    if (mime === 'image/vnd.microsoft.icon') return make('image/x-icon', { source: source || 'content-type' });
    if (mime.indexOf('image/') === 0) {
      return {
        mime: mime,
        ext: mime.slice(6).replace(/[^a-z0-9]/g, '') || 'img',
        label: mime,
        isImage: true,
        decodable: null,
        animated: null,
        hasAlpha: null,
        width: null,
        height: null,
        variant: null,
        source: source || 'content-type',
      };
    }
    return null;
  }

  function pathExtension(url) {
    let path = String(url == null ? '' : url);
    try {
      const parsed = new URL(path);
      if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return '';
      path = parsed.pathname || '';
    } catch (err) {
      path = path.split('#')[0].split('?')[0];
    }
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(path);
    return m ? m[1].toLowerCase() : '';
  }

  /** Guess from the URL's file extension. Cheap, offline, and wrong often enough to be a hint only. */
  function guessFromUrl(url) {
    const ext = pathExtension(url);
    if (!ext) return null;
    const mime = EXT_TO_MIME[ext];
    if (!mime) return null;
    return make(mime, { source: 'url' });
  }

  /** Split a data: URL without decoding the whole payload. */
  function parseDataUrl(url) {
    const s = String(url == null ? '' : url);
    const m = /^data:([^,]*),/.exec(s);
    if (!m) return null;
    const parts = (m[1] || '').split(';');
    const params = parts.slice(1).map(function (p) { return p.trim().toLowerCase(); });
    return {
      mime: (parts[0] || '').trim().toLowerCase() || 'text/plain',
      base64: params.indexOf('base64') !== -1,
      payload: s.slice(m[0].length),
    };
  }

  function base64Head(payload, chars) {
    const clean = payload.replace(/\s+/g, '').slice(0, chars);
    // atob rejects a partial 4-char group, so trim to a whole number of groups.
    const trimmed = clean.slice(0, Math.floor(clean.length / 4) * 4);
    if (!trimmed) return new Uint8Array(0);
    const bin = atob(trimmed);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Identify a data: URL, preferring its decoded bytes over its declared MIME type. */
  function fromDataUrl(url) {
    const parsed = parseDataUrl(url);
    if (!parsed) return null;
    if (parsed.base64) {
      try {
        const f = detectFormat(base64Head(parsed.payload, 128));
        if (f) { f.source = 'data-url'; return f; }
      } catch (err) { /* malformed base64 - fall through to the declared type */ }
    } else {
      try {
        const text = decodeURIComponent(parsed.payload.slice(0, 512));
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
        const f = detectFormat(bytes);
        if (f) { f.source = 'data-url'; return f; }
      } catch (err) { /* not decodable - fall through */ }
    }
    return fromContentType(parsed.mime, 'data-url');
  }

  function isWebp(format) {
    return !!format && format.mime === 'image/webp';
  }

  /** Short human string for notifications, e.g. "WebP (animated) 480x270". */
  function describe(format) {
    if (!format) return 'unknown format';
    const dims = format.width && format.height ? ' ' + format.width + '×' + format.height : '';
    return format.label + dims;
  }

  return {
    SNIFF_BYTES: SNIFF_BYTES,
    WEBP_FLAG_ALPHA: WEBP_FLAG_ALPHA,
    WEBP_FLAG_ANIMATION: WEBP_FLAG_ANIMATION,
    detectFormat: detectFormat,
    fromContentType: fromContentType,
    fromDataUrl: fromDataUrl,
    parseDataUrl: parseDataUrl,
    guessFromUrl: guessFromUrl,
    pathExtension: pathExtension,
    isWebp: isWebp,
    describe: describe,
  };
});
