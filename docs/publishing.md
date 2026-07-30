# Publishing

Everything here is ready to submit. What is left needs an account holder, because each channel
requires signing in, accepting a developer agreement, and — for Chrome — paying a fee. Those are
steps only you can take.

Both packages currently build at **1.1.0** and `web-ext lint` reports 0 errors, 0 warnings and
0 notices.

```bash
npm run test:all       # 107 checks
npm run lint:ext       # AMO linter
npm run package        # dist/webp-save-as.xpi
npm run package:chrome # dist/chrome/ and dist/webp-save-as-chrome.zip
```

---

## Decide these first

| Thing | Now | Why it matters |
| --- | --- | --- |
| Extension ID | `webp-save-as@charlie754.github.io` | Permanent on AMO once submitted. Change it *before* the first upload if you want a different one. |
| `homepage_url` | the GitHub repo | Shown on both stores. |
| Author | not set | Optional; shown on both stores. Add `"author"` to the manifests if you want a display name. |
| Privacy policy | none | Neither store requires one when nothing is collected, but a one-line statement in the listing helps review go faster. |

The ID lives in `manifest.json` and `manifest.v3.json` under
`browser_specific_settings.gecko.id`. Chrome ignores it and assigns its own on first upload.
`test/browser/run-extension.mjs` reads it from the manifest, so changing it needs no test edits.

---

## GitHub — done

<https://github.com/charlie754/webp-save-as> — public, MIT.

```bash
git push          # subsequent updates
```

Worth knowing: your commit-author email (`tinyiupliskin@gmail.com`) and the contents of `docs/`
are public along with the code.

---

## Firefox — addons.mozilla.org

**What blocks it:** submission needs a Mozilla account, acceptance of the Developer Agreement,
and either the web form or AMO API credentials. Creating accounts, entering passwords and
handling API tokens are all things this assistant will not do.

**Steps for you:**

1. Sign in at <https://addons.mozilla.org/developers/>
2. **Submit a New Add-on** → *On this site* → upload `dist/webp-save-as.xpi`
3. Source code upload: **not required.** Nothing is minified, obfuscated or bundled; the files in
   the package are the files in the repo.
4. Fill in the listing (copy below) and submit for review.

Reviewers usually ask why the add-on needs broad host access. The honest answer:

> The extension converts an image the user right-clicks. To do that it has to read that image's
> bytes, and the user can right-click an image on any site, so access cannot be narrowed to a
> fixed list of hosts. The bytes are decoded and re-encoded locally through a canvas and written
> to the user's downloads folder. Nothing is transmitted anywhere, no content scripts run on page
> load, and no browsing data is collected — the manifest declares
> `data_collection_permissions: { required: ["none"] }`.

A content script is injected in exactly one case: when the chosen image is behind a `blob:` URL,
which only the page itself can read. It is injected on demand after the user clicks the menu
item, never automatically. See `src/lib/pagefetch.js`.

---

## Chrome — Chrome Web Store

**What blocks it:** a Google account, acceptance of the developer agreement, and a **one-time
US$5 registration fee**. This assistant does not make payments or create accounts, so this one
cannot be automated at all.

**Steps for you:**

1. Register at <https://chrome.google.com/webstore/devconsole> (the $5 fee is one-time, per
   account, not per extension)
2. **Add new item** → upload `dist/webp-save-as-chrome.zip`
3. Complete the listing, the privacy tab, and submit for review

Chrome requires a **single purpose** statement and a justification for every permission:

| Field | What to write |
| --- | --- |
| Single purpose | Converts an image the user right-clicks into JPG or PNG and saves it to their downloads folder. |
| `contextMenus` | Adds the two right-click items that are the extension's entire interface. |
| `downloads` | Writes the converted file to the user's downloads folder. |
| `storage` | Stores the user's own settings (quality, background colour, which menu items to show). Local only. |
| `notifications` | Reports a failed conversion, and warns when only the first frame of an animation could be saved. |
| `scripting` | Injected on demand, only when the chosen image is behind a `blob:` URL that the extension cannot read directly. Never on page load. |
| `offscreen` | An MV3 service worker has no `URL.createObjectURL`; a hidden document creates the blob URL for images too large to pass inline. |
| Host permissions | The user can right-click an image on any site, so the extension must be able to read the bytes of an image on any site. Reading is all it does with that access. |
| Data usage | Discloses **no** data collection. Nothing is transmitted; conversion is entirely local. |

You will also need at least one screenshot (1280×800 or 640×400). A capture of the right-click
menu over an image is the obvious one — `npm run demo` puts a suitable page on screen.

---

## Listing copy

**Name:** Save WebP as JPG / PNG

**Summary (under 250 characters):**

> Right-click any image and save it as JPG or PNG. Converts WebP, AVIF and GIF instantly, entirely
> on your own machine — nothing is ever uploaded.

**Description:**

> Sites serve WebP everywhere now, and plenty of tools still will not open it. This adds two items
> to the right-click menu — Save as JPG and Save as PNG — that decode the image and save a
> converted copy straight to your downloads folder.
>
> It identifies images by their actual content rather than by their file name, so a WebP served
> from a .jpg address is still recognised and converted correctly.
>
> - Converts WebP, AVIF, GIF, BMP and more to JPG or PNG
> - Adjustable JPG quality, and a configurable colour behind transparency
> - Saving an image that is already the format you chose copies it rather than re-compressing it
> - Everything happens locally. No servers, no accounts, no tracking, no data collection.
>
> Open source: https://github.com/charlie754/webp-save-as

**Category:** Photos & Images (Chrome) / Photos, Music & Videos (AMO)

---

## After the first release

Version numbers must increase for every upload, in all three of `manifest.json`,
`manifest.chrome.json` and `package.json`. AMO rejects a re-upload of an existing version
outright; Chrome does the same.
