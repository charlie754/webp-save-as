# Save WebP as JPG / PNG

A Firefox extension that adds **“Save WebP as JPG”** and **“Save WebP as PNG”** to the image
right-click menu. Picking one decodes the WebP, re-encodes it, and drops the converted file
straight into your downloads folder. Everything happens locally — the image is never uploaded.

The menu only appears for images that really are WebP, and it works out which ones those are by
reading the first 64 bytes of the file rather than trusting the address. Plenty of sites serve
WebP from a `.jpg` URL with an `image/jpeg` header; those still get the menu.

---

## Install

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

Right-click any WebP image → **Save WebP as JPG** or **Save WebP as PNG**.

It also works on a link that points at a WebP, and on a WebP opened directly in a tab.

Settings live in `about:addons` → **Save WebP as JPG / PNG** → **Preferences**:

| Setting | Default | What it does |
| --- | --- | --- |
| Offer “Save as JPG” / “Save as PNG” | both on | Which menu items exist |
| Show the menu for every image | off | Also convert AVIF, GIF, BMP… not just WebP |
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
npm test              # 64 unit tests, no browser needed
npm run test:firefox  # 12 conversion checks inside real Firefox (headless)
npm run test:extension # 14 checks inside the installed extension (headless)
npm run test:all
npm run lint:ext      # official AMO linter
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

Both browser runners need Firefox; they look in the usual install locations, or pass
`--firefox "C:\path\to\firefox.exe"`. Add `--headed` to `run-extension.mjs` to watch it happen.

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

---

## Manifest V3

`manifest.json` is V2 deliberately: Firefox grants `<all_urls>` at install time, and the
extension is useless without it — it cannot read image bytes to convert them. Under Firefox's
MV3, host permissions are **not** granted at install; the user has to grant them afterwards, and
until they do every conversion fails.

`manifest.v3.json` is a working V3 variant if you want it — copy it over `manifest.json`. The code
already handles both (`scripting.executeScript` when present, `tabs.executeScript` otherwise).
Expect to add an onboarding step that calls `permissions.request()` from a user gesture.

`strict_min_version` is 140 because `data_collection_permissions` — which AMO now requires — was
introduced there. Drop that key and you can lower the floor to 115.

---

## Licence

MIT
