# Fill &amp; Sign

**The free PDF tool that lets you finish your document and leave.**

Someone sends you a PDF. You need to fill in a few blank lines, sign it, and send it
back. That is the whole job, and that is the whole app.

No account. No upload. No trial. No watermark. No surprise paywall.

---

## What it does

- **Real form fields** — if the PDF actually declares fillable fields, they light up
  and you just tap one and type. Text boxes, multi-line boxes, checkboxes, radio
  groups and dropdowns. On export the values go back through the document's own
  form and it is flattened, so the recipient gets a finished page, not a form they
  can type over.
- **Snap to blank lines** — for the far more common case of a PDF with no fields
  at all: tap near an underscore run or a drawn rule and the text
  lands *on* it, left-aligned to its start and sized to match the label beside it.
  No dragging or resizing needed for the common case. Signatures snap the same way.
- **Text** — tap anywhere to drop a text box; drag it around before or after typing,
  resize, recolour (black / blue / red)
- **Signature** — draw it, type it in a handwriting face, or photograph one on paper
  (the light background is removed automatically). A thickness slider sets the pen
  weight, before placing or afterwards on a signature already on the page.
  Saved locally for reuse.
- **Signature timestamp** — the local date and time go under the signature
  automatically. The two behave as one object: drag either and both move.
  Switch to date-only or turn it off.
- **Date** — standalone date object in `08/05/2026`, `August 5, 2026`, or `5 August 2026`
- **Checkmark / X** — sized for a normal checkbox; the tool stays armed so you can
  tick a whole column in one go, and turns off when you tap it again
- **Tick boxes the PDF only *drew*** — an empty square on the page is found from the
  pixels and treated as a control. Click straight into one with no tool armed and it
  gets a checkmark; click again for an X; again to clear it.
- **Tab through the whole document** — on a keyboard, Tab walks every place you could
  need to write, in reading order: declared form fields, blank lines (a text box is
  created on the line and focused, ready to type), and empty tick boxes. `Enter` on a
  highlighted tick box stamps an X, then a checkmark, then clears it. `Esc` jumps to
  Finish. Everything the scan finds stays in memory in that tab.
- **Blackout** — press and drag; the box grows under your finger so you can see
  exactly what you are covering. On export, any page containing a
  blackout is **flattened to an image**, so the hidden text is genuinely destroyed rather
  than merely covered.
- **Rotate** — 90° / 180° / 270° / original, per page or all pages. Objects rotate with
  the page, and objects added to an already-sideways page land upright.
- **Undo / redo**, duplicate, bring forward, send backward
- **Save or Share** — download the PDF, or hand it to the device share sheet (Gmail,
  Outlook, Messages, Drive, Files, …)
- **Installable PWA** — add to home screen, works fully offline
- **Android share target** — share a PDF *into* Fill &amp; Sign from any app
- **Desktop file handler** — set as the default opener for `.pdf`

## Privacy

There is no server and no database. `pdf.js` renders the document and `pdf-lib` writes the
new one, both inside your browser. Nothing is transmitted anywhere. An unfinished draft is
kept in IndexedDB **on your device only**, expires after 7 days, and can be wiped at any
time from the *Delete local document data* link on the home screen.

## Running it

It is a static site. There is no build step, no bundler, and no dependencies to install.

```bash
# any static server works
python3 -m http.server 8000
# then open http://localhost:8000
```

A service worker is required for offline mode and the Android share target, so it must be
served over `http://localhost` or HTTPS — opening `index.html` from the file system will
work for basic editing but not for those two features.

### Deploying

Push to GitHub and turn on **Settings → Pages → Deploy from a branch → `main` / root**.
That is the whole deployment. GitHub Pages serves it over HTTPS for free, and because the
app does all its work client-side, hosting cost stays flat no matter how many people use it.

Any static host works the same way — Netlify, Cloudflare Pages, S3.

## Project layout

```
index.html            Fill & Sign — markup, SEO metadata, JSON-LD
app.css               Fill & Sign styles, light + dark
app.js                the whole Fill & Sign application (ES module)
tools.html            the index of tools
shrink.html           Shrink — the image compressor
shrink.css            Shrink's own colour and its UI
shrink.js             the compressor (canvas encode + target-size search)
site.css              shared shell: tokens, controls, header, footer
sw.js                 service worker: offline cache + share-target intake
manifest.webmanifest  PWA manifest, share_target, file_handlers
sitemap.xml           the three public pages
icons/                app icons and the Open Graph image
vendor/
  pdf.min.mjs         Mozilla pdf.js — rendering          (Apache-2.0)
  pdf.worker.min.mjs
  pdf-lib.min.js      pdf-lib — writing the output PDF    (MIT)
  caveat.woff2        Caveat — typed signatures           (OFL-1.1)
  dancing.woff2       Dancing Script — typed signatures   (OFL-1.1)
```

Everything is vendored on purpose: no CDN, no third-party request at runtime, and the
whole app keeps working offline.

## Two different jobs, deliberately

There is an important distinction inside this app. If a PDF *declares* a fillable
field, that is not a guess — the document is telling you where to type, so
`readFields()` reads the widget annotations, overlays a real `<input>` on each one,
and `flattenForm()` writes the values back through pdf-lib's form API. Nothing is
inferred.

If the PDF declares nothing — which is most of them — the app falls back to
snapping to visible rules, described below. That is a guess, so it only ever
positions what you were already placing; it never invents a field.

## How tick boxes are found

`scanBoxes()` works on the same one-byte ink mask as the line scan. It looks for a
short horizontal run, a matching run one box-width below at the same x range, solid
sides joining the two, and a clear middle. The clear middle is doing real work: a box
that is *already* ticked fails it, so only empty boxes are ever offered.

The interesting false positive is a bold lowercase **o**. It has a long run across the
top of the bowl, a matching one across the bottom, solid sides and a hollow centre — it
passes every test above. What separates it from a drawn box is border thickness: two
rows into an "o" you are still inside the stroke, whereas two rows into a rectangle
there is nothing but the two sides. That single check removes the glyphs and keeps the
boxes.

Scanning does not read the on-screen canvas. It renders its own 1000px-wide copy of the
page and throws the bitmap away, so the answer is identical whether you are zoomed out
on a phone or at 6× on a desktop — and a deep zoom never means scanning a 12000px
bitmap.

## How blank-line snapping works

There is no form-field parsing here, and no PDF operator archaeology. The page is
already rendered to a canvas, so `scanLines()` reads it back and looks for long,
*thin*, nearly-solid bands of dark pixels with white space directly above and below.
An underscore run or a drawn rule passes all four tests; a row of type fails at
least two of them (letters leave gaps, and a text row is tall and crowded).
`inkHeightLeft()` then walks up from the rule to the nearest ink cluster on its
left — the field's label — and derives a font size from its height. That is why a
snapped text box comes out the same size as "Tenant name:" beside it.

The whole scan is cached per page render and only runs the first time you place
something on that page.

## How the coordinate system works

Worth knowing before changing anything in `app.js`:

Every object stores its position and size **normalised (0–1) against the page as it looked
when the object was placed**, together with that page rotation in `it.rot`. Rendering maps
that frame onto the un-rotated page with `unrotXY()`; export does the same and hands the
residual angle to `pdf-lib` as `rotate:`. That is what keeps a mark upright when it is
added to a sideways scan, while still letting it turn with the page if the page is rotated
later. Zoom is pure layout — no coordinates change — so nothing drifts as you pinch.

Text is exported as real, selectable text. A page is only rasterised when it must be:
it contains a blackout, or it contains characters Helvetica's WinAnsi encoding cannot
represent.

## Not included, deliberately

Accounts, subscriptions, watermarks, ads, AI, OCR, editing the original PDF text,
converting Word files, merging, splitting, page reordering, cloud storage, collaboration,
digital certificates. Each one left out is what keeps this fast, private, and free.

---

## Shrink — the second tool

`shrink.html` is a separate, self-contained image compressor sharing the same shell and
the same promise: it runs entirely in the browser, so it costs nothing to host.

Three one-tap levels, or an exact target in MB. The target search spends its budget on
quality first and only reduces dimensions when quality alone cannot get there; because
file size tracks pixel count, the measured overshoot tells it roughly how far to drop, so
it converges in a couple of passes rather than grinding. Images with real transparency are
written as WebP so it survives; everything else becomes a JPEG. If a file is already
within a tenth of its floor, Shrink hands back the original untouched and says so, rather
than trading visible quality for a few percent.

`tools.html` is the index that ties the two together.

---

Built by **Eli Otterholt** — [otterholteli@gmail.com](mailto:otterholteli@gmail.com)

I build practical software that removes repetitive work, unnecessary steps, and everyday
business headaches. If your business has a process that should be easier, get in touch.

Licensed under the [MIT License](LICENSE).
