'use strict';
/**
 * Offscreen document: the only place in the Chrome build with URL.createObjectURL.
 *
 * The service worker can decode and encode perfectly well on its own (createImageBitmap and
 * OffscreenCanvas both exist there), but it cannot mint a blob: URL, and handing a very large
 * image to downloads.download() as a base64 data: URL means holding a ~33% inflated copy of it
 * in a single string. So for large outputs the worker sends the source URL here and this
 * document redoes the fetch — which costs nothing, the HTTP cache already holds the bytes — and
 * returns a blob: URL the worker can download.
 */
(function () {
  const CHANNEL = 'webp-save-as/offscreen';

  /** Blob URLs stay alive until the download that uses them finishes. */
  const live = new Set();

  async function convert(request) {
    const response = await fetch(request.url, { credentials: 'include', cache: 'force-cache' });
    if (!response.ok) throw new Error('the server replied ' + response.status);
    const source = await response.blob();
    if (!source.size) throw new Error('the image was empty');

    let out = source;
    let width = null;
    let height = null;
    let reencoded = false;

    if (!(request.passthrough && source.type === request.mime)) {
      const result = await ImageConvert.convertImage(source, {
        format: request.format,
        quality: request.quality,
        background: request.background,
      });
      out = result.blob;
      width = result.width;
      height = result.height;
      reencoded = true;
    }

    const objectUrl = URL.createObjectURL(out);
    live.add(objectUrl);
    return {
      objectUrl: objectUrl,
      size: out.size,
      width: width,
      height: height,
      reencoded: reencoded,
      sourceSize: source.size,
    };
  }

  function revoke(objectUrl) {
    if (!live.has(objectUrl)) return false;
    URL.revokeObjectURL(objectUrl);
    live.delete(objectUrl);
    return true;
  }

  browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.channel !== CHANNEL) return undefined;

    if (message.op === 'revoke') {
      sendResponse({ revoked: revoke(message.objectUrl) });
      return undefined;
    }

    if (message.op === 'convert') {
      convert(message).then(
        function (result) { sendResponse(result); },
        function (err) { sendResponse({ error: String((err && err.message) || err) }); },
      );
      return true; // keep the channel open for the async reply
    }

    if (message.op === 'ping') {
      sendResponse({ ok: true, hasCreateObjectURL: typeof URL.createObjectURL === 'function' });
      return undefined;
    }

    return undefined;
  });
})();
