# Save WebP as JPG / PNG

A browser extension — **Firefox and Chrome** — that adds **“Save as JPG”** and **“Save as PNG”**
to the image right-click menu. Picking one decodes the image, re-encodes it, and drops the
converted file straight into your downloads folder. Everything happens locally; the image is
never uploaded.

Both builds share one codebase: the format sniffer, the converter, the filename logic and the
settings all live in `src/lib/` and are byte-for-byte the same in each package. Only the
background layer differs, because Manifest V3 forces it to (see [Two builds](#two-builds)).

Out of the box the menu appears on any image, and it works out what each one actually is by
reading the first 64 bytes rather than trusting the address — a real WebP is named explicitly
(**Save WebP as JPG**), anything else reads **Save Image as JPG**. That distinction matters
because plenty of sites serve WebP from a `.jpg` URL with an `image/jpeg` header. Narrow it to
WebP only in the settings if you prefer.

---

## Install

### Chrome

```bash
npm run package:chrome
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select
`dist/chrome`. That is the whole procedure — Chrome grants `<all_urls>` at install time, so the
extension works immediately.

`dist/webp-save-as-chrome.zip` is the same thing packaged for the Chrome Web Store.

Note that `--load-extension` on the command line no longer works in Chrome 137 and later; the
supported automation route is the DevTools Protocol command `Extensions.loadUnpacked`, which is
what `npm run test:chrome` uses.

### Firefox

The build is unsigned, so pick whichever fits your Firefox.

**Any Firefox — temporary (survives until you quit):**

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Select `manifest.json` in this folder (or `dist/webp-save-as.xpi`)

**Developer Edition / Nightly — permanent:**

1. Open `about:config`, set `xpinstall.signatures.required` to `false`
2. Open `about:addons` → gear icon → **Install Add-on From File…**
3. Select `dist/webp-save-as.xpi`

Rebuild the package after any edit:

```bash
npm run package
```

Release and ESR Firefox refuse unsigned add-ons outright; those need a signed build from
[addons.mozilla.org](https://addons.mozilla.org/developers/). The manifest already passes
`web-ext lint` with zero findings, so it is submission-ready.

---

## Using it

Right-click an image → **Save WebP as JPG / PNG** for a WebP, **Save Image as JPG / PNG** for
anything else.

It also works on a link that points at an image, and on an image opened directly in a tab.

Settings live in `about:addons` → **Save WebP as JPG / PNG** → **Preferences**:

| Setting | Default | What it does |
| --- | --- | --- |
| Offer “Save as JPG” / “Save as PNG” | both on | Which menu items exist |
| Show the menu for every image | **on** | Also converts AVIF, GIF, BMP, PNG… Turn off to restrict the menu to WebP |
| Identify images by reading their first bytes | on | Off = trust the file extension only, never touch the network |
| Hide the menu when the format can’t be identified | off | On = strict; the menu only ever appears for a confirmed WebP |
| Quality | 92% | JPG encoder quality |
| Colour behind transparency | white | Painted under transparent pixels when writing JPG |
| Ask where to save each file | off | On = open the file picker |
| Never re-encode an image already in the chosen format | on | Saving a real JPG as JPG copies the bytes instead of re-compressing |
| Notify on failure / on success / on first-frame-only | on / off / on | Desktop notifications |

---

## How it works

```
right-click ──▶ menus.onShown ──▶ identify the image ──▶ show/hide + retitle ──▶ menus.refresh()
click ────────▶ read the bytes ──▶ createImageBitmap ──▶ canvas ──▶ encode ──▶ downloads.download
```

| File | Role |
| --- | --- |
| `src/background.js` | Menu lifecycle, the show/hide decision, fetch → convert → download |
| `src/lib/sniff.js` | Format detection from magic bytes: WebP lossy/lossless/extended, animation and alpha flags, plus PNG/APNG/JPEG/GIF/AVIF/ICO/BMP/TIFF/SVG/JXL |
| `src/lib/convert.js` | `createImageBitmap` → `OffscreenCanvas` → `convertToBlob`, with `<img>`/DOM-canvas fallbacks |
| `src/lib/filename.js` | Output filename: strips the old extension, percent-decodes, removes characters Windows forbids, escapes reserved device names, caps the length |
| `src/lib/settings.js` | Defaults and a validated, cached read of `storage.local` |
| `src/lib/pagefetch.js` | Reads `blob:` images by injecting a fetch into the page — the background page cannot read another origin's blob URLs |
| `src/options/` | Settings UI |

Design notes worth knowing:

- **Bytes beat names.** A `.webp` address is trusted as a shortcut, but anything else is sniffed.
  Results are cached (200 entries, 5 minutes) so a second right-click is free.
- **Sniffing is nearly free.** The request uses `cache: "force-cache"`, so the copy the page
  already loaded normally answers it, and the response stream is cancelled after 64 bytes.
- **Unidentified images still get the menu.** Detection can fail for reasons unrelated to the
  format; offering the menu and reporting a real error beats silently doing nothing. Flip
  *Hide the menu when the format can’t be identified* if you disagree.
- **JPG gets a background.** Transparent pixels would otherwise come out black. Only `#rgb` /
  `#rrggbb` is accepted, because assigning an invalid colour to `fillStyle` fails silently.
- **A .jpg that really is a JPG is copied, not re-encoded**, so “Save as JPG” never quietly
  degrades an image.

---

## Tests

```bash
npm test               # 65 unit tests, no browser needed
npm run test:firefox   # 12 conversion checks inside real Firefox (headless)
npm run test:extension # 14 checks inside the installed Firefox add-on (headless)
npm run test:chrome    # 16 checks inside the installed Chrome extension (headless)
npm run test:all       # all 107
npm run lint:ext       # official AMO linter
```

`test:firefox` serves `test/browser/harness.html` over HTTP, runs it in a throwaway Firefox
profile and collects the verdict — so the WebP decode and the JPEG/PNG encoders are exercised in
Gecko, not in a stand-in.

`test:extension` packages the add-on with `-IncludeTests`, sideloads it into a throwaway profile,
and runs `test/selftest.js` **inside the extension**. That covers the parts only a real install
can reach: permissions actually granted, the menus API accepting our item definitions, the
show/hide decision matrix, a WebP disguised as `image/jpeg` behind a `.jpg` address, the `blob:`
fallback, the options page round-tripping through `storage.local`, and a converted JPEG landing on
disk — which the runner then re-opens and checks byte for byte.

`test:chrome` packages the Chrome build, loads it into a throwaway profile via
`Extensions.loadUnpacked`, then **attaches to the MV3 service worker over the DevTools Protocol
and calls its real code**. That is how the Chrome side is tested without shipping a single line
of test scaffolding inside the extension. It covers both download routes, and re-opens each
saved file from disk to check its size and magic bytes.

The runners look in the usual install locations, or pass `--firefox` / `--chrome` with a path.
Add `--headed` to watch either one happen.

### Checking the right-click menu by hand

```bash
npm run demo
```

That installs the add-on into a throwaway profile, runs the self-test, then leaves Firefox open on
a page with six cases to right-click: a plain `.webp`, a WebP disguised as `image/jpeg` behind a
`.jpg` name, a real PNG (should show nothing by default), a transparent WebP, a link to a WebP, and
a WebP behind a `blob:` URL. Downloads go to the temporary profile. Ctrl+C cleans everything up.

Verified on Firefox Developer Edition 154 (Windows 11), Node 24.

---

## Limitations

- **The right-click menu appearing has not been automated.** Nothing can script Firefox's native
  context menu. What *is* verified: Firefox accepts the exact item definitions, `menus.onShown`
  and `menus.refresh` exist, and the show/hide/retitle decision is tested across 12 cases. The
  one thing left to confirm by eye is that the item renders where you expect.
- **Animated WebP loses its animation.** JPG and PNG hold one frame; you get the first, and a
  notification saying so.
- **SVG, TIFF, JPEG XL and HEIC are not offered.** Firefox cannot re-encode them through a
  canvas, so the menu stays hidden rather than failing after the click.
- **Very large images are refused** above 32767 px on a side or ~124 megapixels, which is where
  Gecko's canvas gives up.
- **CSS background images have no menu.** Firefox only reports an image context for real `<img>`
  elements, image documents and links.
- **`blob:` images need their page open**, since only that page can read the URL.
- Byte sniffing can issue one request for an image that is not in the cache. Turn it off in the
  settings if you would rather it never did.
- **Chrome only:** the menu label cannot change per image, and WebP-only mode filters by address
  rather than by content — see [Two builds](#two-builds). The Chrome package is also unsigned, so
  it installs through **Load unpacked** until it goes through the Web Store.

---

## Two builds

| | Firefox | Chrome |
| --- | --- | --- |
| Manifest | `manifest.json` (V2) | `manifest.chrome.json` (V3) |
| Background | persistent page | service worker |
| Menu | decided per right-click | static, rebuilt when settings change |
| Blob URLs | available | **not in a worker** → data: URL, or the offscreen document |
| Icons | SVG | PNG (`npm run icons` rasterises the SVG) |
| Menu item icons | yes | rejected outright by the API |

Everything in `src/lib/` is identical in both. `src/background.js` and
`src/chrome/service-worker.js` are the only two files that know which browser they are in.

**Why Firefox stays on V2.** Firefox MV3 does not grant host permissions at install time, and
this extension cannot read image bytes without them — every conversion would fail until the user
went and granted access. Chrome MV3 *does* grant them at install, so there the tradeoff does not
exist. `manifest.v3.json` is a working Firefox V3 variant if you want it; expect to add an
onboarding step calling `permissions.request()` from a user gesture.

**What Chrome genuinely cannot do.** There is no `contextMenus.onShown` and no `refresh()`, so
the menu cannot be decided per right-click. With the default "every image" scope that costs
nothing. In WebP-only mode the best available approximation is `targetUrlPatterns` matching
`*.webp` addresses — which means a WebP served from a `.jpg` URL will not show the menu there,
even though the Firefox build would catch it. The bytes still decide the actual conversion once
an item is clicked.

`strict_min_version` is 140 because `data_collection_permissions` — which AMO now requires — was
introduced there. Drop that key and you can lower the floor to 115.
`minimum_chrome_version` is 116, set by the offscreen API.

---

## Support

Free and open source, and staying that way. If it saved you time, there is a
**Support me on Ko-fi** button at the bottom of the extension's Preferences —
or go straight to [ko-fi.com/irp_hongkong](https://ko-fi.com/irp_hongkong).

Nothing in the extension changes either way: no nagging, no reminders, no
feature held back.

## Licence

MIT — see [LICENSE](LICENSE). Copyright © 2026 IRP_HongKong.
