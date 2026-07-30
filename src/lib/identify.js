'use strict';
/**
 * Deciding what an image actually is, and whether to offer the menu for it.
 *
 * Shared by both browsers: Firefox drives this from menus.onShown (which lets it decide per
 * right-click), Chrome from the click handler (MV3 has no onShown, so its menu is static and
 * this runs once the user has already committed). Same answers either way.
 *
 * Loadable as a classic <script>, via importScripts() in an MV3 service worker, or as a
 * CommonJS module for the tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
  else root.ImageIdentify = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const Sniff = (typeof module === 'object' && module !== null && module.exports)
    ? require('./sniff.js')
    : (typeof globalThis !== 'undefined' ? globalThis : this).ImageSniff;

  const SNIFF_TTL_MS = 5 * 60 * 1000;
  const SNIFF_CACHE_MAX = 200;
  const SNIFF_TIMEOUT_MS = 4000;

  /** url -> { at, format }. A cached `null` is a real answer: "looked, recognised nothing". */
  const cache = new Map();

  function cacheGet(url) {
    const hit = cache.get(url);
    if (!hit) return undefined;
    if (Date.now() - hit.at > SNIFF_TTL_MS) {
      cache.delete(url);
      return undefined;
    }
    // Re-insert so Map iteration order doubles as an LRU list.
    cache.delete(url);
    cache.set(url, hit);
    return hit.format;
  }

  function cacheSet(url, format) {
    cache.set(url, { at: Date.now(), format: format || null });
    while (cache.size > SNIFF_CACHE_MAX) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  function cacheClear() { cache.clear(); }
  function cacheSize() { return cache.size; }

  function isImageContext(contexts) {
    return !!contexts && contexts.indexOf('image') !== -1;
  }

  /** blob: cannot be read from an extension context, so there is nothing to sniff there. */
  function canSniffScheme(url) {
    return /^(https?|file):/i.test(url);
  }

  /** Read the leading bytes of a response without downloading the rest of it. */
  async function readPrefix(response, count) {
    if (response.body && response.body.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (total < count) {
          const step = await reader.read();
          if (step.done) break;
          chunks.push(step.value);
          total += step.value.length;
        }
      } finally {
        // Cancelling closes the connection, so a 20 MB image costs us one packet.
        try { await reader.cancel(); } catch (err) { /* already closed */ }
      }
      const out = new Uint8Array(Math.min(total, count));
      let offset = 0;
      for (let i = 0; i < chunks.length && offset < out.length; i++) {
        const take = Math.min(chunks[i].length, out.length - offset);
        out.set(chunks[i].subarray(0, take), offset);
        offset += take;
      }
      return out;
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer.slice(0, count));
  }

  async function sniffPrefix(url) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, SNIFF_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        // The page already loaded this image, so the HTTP cache normally answers with no
        // network request at all.
        cache: 'force-cache',
        redirect: 'follow',
        signal: controller.signal,
      });
      const declared = Sniff.fromContentType(response.headers.get('content-type'));
      if (!response.ok) return declared;
      const prefix = await readPrefix(response, Sniff.SNIFF_BYTES);
      return Sniff.detectFormat(prefix) || declared;
    } catch (err) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * What can we say about this URL without touching the network?
   * @returns {{format: object|null, final: boolean}} `final` means a sniff would add nothing.
   */
  function quickFormat(url) {
    if (/^data:/i.test(url)) return { format: Sniff.fromDataUrl(url), final: true };
    const cached = cacheGet(url);
    if (cached !== undefined) return { format: cached, final: true };
    const guess = Sniff.guessFromUrl(url);
    // A .webp path is a strong enough signal to skip the network entirely.
    if (guess && guess.mime === 'image/webp') return { format: guess, final: true };
    if (!canSniffScheme(url)) return { format: guess, final: true };
    return { format: guess, final: false };
  }

  async function identify(url, settings) {
    if (!url) return null;
    const quick = quickFormat(url);
    if (quick.final) return quick.format;
    if (!settings || !settings.sniffBytes) return quick.format;
    const sniffed = await sniffPrefix(url);
    const result = sniffed || quick.format || null;
    cacheSet(url, result);
    return result;
  }

  /** Identify a blob we already hold, preferring its bytes over its declared type. */
  async function formatOfBlob(blob) {
    const head = new Uint8Array(await blob.slice(0, Sniff.SNIFF_BYTES).arrayBuffer());
    return Sniff.detectFormat(head) || Sniff.fromContentType(blob.type, 'blob-type');
  }

  /**
   * Should the menu items show for this image, and is it a WebP?
   *
   * Unidentified images still get the menu: detection can fail for reasons that have nothing to
   * do with the format, and silently hiding the feature is worse than offering it and reporting
   * a real error. `hideWhenUnknown` inverts that for anyone who prefers the strict behaviour.
   */
  function decideVisibility(format, settings, contexts) {
    if (Sniff.isWebp(format)) return { visible: true, webp: true };
    if (format && format.isImage) {
      return { visible: !!settings.showForAllImages && format.decodable !== false, webp: false };
    }
    if (format) return { visible: false, webp: false };
    return { visible: isImageContext(contexts) && !settings.hideWhenUnknown, webp: false };
  }

  return {
    SNIFF_TTL_MS: SNIFF_TTL_MS,
    SNIFF_CACHE_MAX: SNIFF_CACHE_MAX,
    SNIFF_TIMEOUT_MS: SNIFF_TIMEOUT_MS,
    cacheGet: cacheGet,
    cacheSet: cacheSet,
    cacheClear: cacheClear,
    cacheSize: cacheSize,
    isImageContext: isImageContext,
    canSniffScheme: canSniffScheme,
    readPrefix: readPrefix,
    sniffPrefix: sniffPrefix,
    quickFormat: quickFormat,
    identify: identify,
    formatOfBlob: formatOfBlob,
    decideVisibility: decideVisibility,
  };
});
