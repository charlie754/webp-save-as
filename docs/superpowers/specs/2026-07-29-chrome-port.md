# Turn report — Chrome (MV3) port

**Date:** 2026-07-29
**Request:** "let's create a chrome version as well"

---

## Approach

Rather than fork the extension, the shared logic was pulled into `src/lib/identify.js` — format
identification, the sniff cache, and the menu-visibility decision — so both browsers run the same
implementation. Everything in `src/lib/` is now byte-for-byte identical in both packages; the only
browser-aware files are `src/background.js` (Firefox) and `src/chrome/service-worker.js` (Chrome).

The UMD wrapper the modules already used turned out to be exactly right for this: the same file
loads as a classic `<script>` in the Firefox background page, via `importScripts()` in an MV3
service worker, and as a CommonJS module in the Node tests. No build step, no bundler.

## Facts established by probing, not by recollection

Before writing any of it, a throwaway MV3 extension was loaded into Chrome 150 to answer the
questions the design turned on. The answers:

| Question | Answer |
| --- | --- |
| `URL.createObjectURL` in a service worker | **absent** — "not a function" |
| `document` / `Image` in a service worker | absent |
| `createImageBitmap`, `OffscreenCanvas`, `convertToBlob` | all present, and conversion works |
| `contextMenus.onShown` / `refresh()` | **absent** (Firefox-only) |
| Menu item `icons` property | **throws** "Unexpected property: 'icons'" |
| `targetUrlPatterns`, `visible`, `update` | accepted |
| `downloads.download()` with a data: URL | **works** — 11,724 bytes on disk |
| Offscreen document blob URL → download | also works |
| `notifications.create` with a data: `iconUrl` | throws; without an icon it is fine |

Two of these changed the design outright: no `onShown` means the Chrome menu has to be static, and
no `createObjectURL` means the download needs a different route.

A third discovery came from the harness rather than the probe: **`--load-extension` no longer
loads anything in Chrome 137+**. The working route is the CDP command `Extensions.loadUnpacked`,
which returns the assigned extension id.

## Design decisions

**Downloads take the cheap route first.** Outputs at or under 4 MB are handed to
`downloads.download()` as a base64 data: URL — no extra document, no lifecycle. Above that, or if
the inline route refuses, the service worker asks the offscreen document to redo the fetch and
conversion and hand back a `blob:` URL. Re-fetching costs nothing because the bytes are already in
the HTTP cache, and it avoids holding a ~33% inflated copy of a large image in one string. Both
legs are tested explicitly.

**The Chrome menu is static and honest about it.** It is rebuilt whenever `showJpg`, `showPng` or
`showForAllImages` changes. In WebP-only mode it falls back to `targetUrlPatterns` on `*.webp`
addresses, which cannot catch a WebP served from a `.jpg` URL — the one capability the Firefox
build has and Chrome cannot match. That is documented in the README rather than papered over.

**`browser` → `chrome` is a nine-line alias, not a polyfill.** Chrome MV3 already returns promises
when no callback is passed, so `globalThis.browser = chrome` plus aliasing `menus` to
`contextMenus` is genuinely sufficient. The Firefox-only extras on that API are feature-detected
at their call sites.

## Verification

107 checks across four tiers, all green.

| Tier | Checks |
| --- | --- |
| Pure logic (`node --test`) | 65 |
| Conversion in headless Firefox | 12 |
| Installed Firefox add-on | 14 |
| Installed Chrome extension | 16 |

The Chrome tier attaches to the **real MV3 service worker over the DevTools Protocol** and
evaluates against its live globals, so not one line of test scaffolding ships in the Chrome
package. It covers the module wiring, the environment assumptions themselves (asserting
`createObjectURL` and `onShown` really are absent, so the port's reasoning stays true), the
12-case visibility matrix, a WebP disguised as `image/jpeg` behind a `.jpg` address, both download
routes, and a byte-for-byte re-read of each saved file from disk.

### Mutation testing

Three Chrome-specific mutations were injected; all three were caught:

- dropping the `menus` → `contextMenus` alias → module-wiring check fails
- a wrong MIME type in `blobToDataUrl` → round-trip check fails
- removing the `offscreen` permission from the manifest → offscreen route check fails

The Firefox suites were re-run after the `identify.js` extraction and stayed at 14/14 and 12/12,
confirming the refactor was behaviour-preserving.

## Bugs found during the work

1. **The injected page-fetch worker used `browser.runtime`**, which is undefined in a Chrome
   content script — the function is serialised before any polyfill runs. It now resolves the
   namespace itself.
2. The first Chrome harness silently loaded nothing, because `--load-extension` is ignored in
   Chrome 137+. Diagnosing it needed CDP; killing the browser to inspect its profile was useless
   because Chrome only flushes `Preferences` on a clean exit.

## Known gaps

- As on Firefox, the context menu **appearing** is not automated — nothing can script Chrome's
  native menu. What is verified: the items register (proved via the duplicate-id error, the only
  observable signal Chrome offers), and the visibility decision is covered across 12 cases.
- The Chrome options page is not exercised by the harness the way the Firefox one is; it is the
  same file, and its Firefox coverage coincidentally covers its markup and wiring.
- Animated WebP, SVG/TIFF refusal, and the large-image guard behave identically in both builds but
  are only asserted on the Firefox side plus the shared unit tests.
