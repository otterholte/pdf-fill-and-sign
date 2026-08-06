# Fill &amp; Sign

**The free PDF tool that lets you finish your document and leave.**

Someone sends you a PDF. You need to fill in a few blank lines, sign it, and send it
back. That is the whole job, and that is the whole app.

No account. No upload. No trial. No watermark. No surprise paywall.

---

## What it does

- **Scan a paper form** — photograph one with the phone, or pick a photo already on
  it, and it becomes a PDF you can fill in. Several photos become several pages.
  Nothing is uploaded: the camera goes straight into a canvas on the device.
- **Real form fields** — if the PDF actually declares fillable fields, they light up
  and you just tap one and type. Text boxes, multi-line boxes, checkboxes, radio
  groups and dropdowns. On export the values go back through the document's own
  form and it is flattened, so the recipient gets a finished page, not a form they
  can type over.
- **Blank lines you can just tap** — for the far more common case of a PDF with no
  fields at all, every rule the scan finds gets a faint box drawn on it. Tap one and
  you are typing, left-aligned to the line's start and sized to match its label — no
  reaching for the Text tool first, no dragging or resizing. The Text tool still
  places a box anywhere you like, and signatures snap to lines the same way.
- **Text** — tap anywhere to drop a text box; drag it around before or after typing,
  resize, recolour (black / blue / red)
- **Signature** — draw it, type it in a handwriting face, or photograph one on paper
  (the light background is removed automatically). A thickness slider sets the pen
  weight, before placing or afterwards on a signature already on the page.
  Saved locally for reuse.
- **Signature timestamp** — the local date and time go under the signature
  automatically. The two behave as one object: drag either and both move, and
  either handle resizes the pair. The date is sized from the signature's width
  but stops shrinking at about 6.7pt, because a date you cannot read is worse
  than one that is slightly large. Switch to date-only or turn it off.
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
- **Back / Next bar** — the same walk without a keyboard. A slim bar under the title
  moves blank to blank and says where you are (*Blank line · 4 of 10*). When it lands on
  a tick box the middle of the bar becomes the tick button, so a phone never needs a
  keyboard to fill a form. It stays on screen with the keyboard up.
- **Blackout** — press and drag; the box grows under your finger so you can see
  exactly what you are covering. On export, any page containing a
  blackout is **flattened to an image**, so the hidden text is genuinely destroyed rather
  than merely covered.
- **Rotate** — 90° / 180° / 270° / original, per page or all pages. Objects rotate with
  the page, and objects added to an already-sideways page land upright.
- **Undo / redo**, duplicate, bring forward, send backward
- **Save or Share** — download the PDF, or hand it to the device share sheet (Gmail,
  Outlook, Messages, Drive, Files, …). The finished screen also offers three clear
  exits — start another PDF, the other tools, or home — and a little confetti, which
  is skipped for anyone who asked for reduced motion.
- **Installable PWA** — add to home screen, works fully offline
- **Android share target** — share a PDF *into* Fill &amp; Sign from any app
- **Desktop file handler** — set as the default opener for `.pdf`

## Two ways to fill the same document

Opening a PDF asks how you want to fill it in. Neither is the default, because
which one is better depends on the form and on the person.

**Page view** is the document exactly as it looks — the original app, described above.

**Simple view** lays the same document out as one tall column of questions, full width,
one after another. It suits a phone and a long form: no pinching, no hunting for the next
blank. Each card carries the words the document itself uses, so it reads like a normal
web form.

Nothing is converted between them. A card writes into precisely the object the page view
already draws: a declared field's value, a text item pinned to a blank line, a mark inside
a tick box. *Review* is a change of view, not an export, and `buildPdf()` never learns
this screen exists. You can move between the two as often as you like.

### Where the questions come from

Each blank needs the words that belong to it, and the PDF already carries its text with
positions — so this is measurement, not guesswork. `pageWords()` pulls every text item,
converts it to the same 0–1 display frame everything else uses, and glues neighbouring
words back into the phrases a person would read.

Forms label things in three places and only three, so `labelFor()` looks in that order:

- **beside it**, ending to the left on the same row — `Phone: ______`
- **above it**, overlapping the blank's own width — a heading over a ruled blank
- **to its right**, for a tick box or checkbox — `☐ I agree to the terms`

A row of blanks shares one row of headings, so height alone ties: *State* and *ZIP code*
sit at exactly the same distance above their rules. Horizontal distance is scored too, or
every blank in the row takes the last heading it saw.

A radio group asks one question with several answers, so the group takes the text to its
left while each button takes the text to its right.

On the fixtures: 8/8 on printed lines with headings above, 15/15 on lines plus tick boxes,
9/10 on a declared AcroForm. The misses are blanks with no label anywhere on the page.

OCR does not know a tick box is a control: it sees a small square and reads it as letters,
then runs them into the label beside it, so "Renewal" arrives as "OC Renewal" and "REAL ID"
as "CJ REAL ID". Spelling cannot settle which prefixes are junk without eating real ones —
"Do you…", "ID Number" — but geometry can, so the strip only happens when the captured word
actually overlaps a box the scan found.

### What counts as ink

A PDF drawn by software puts pure black on pure white; a scan of the same form has soft
grey rules. One fixed cutoff cannot serve both — too high and text bleeds together, too
low and the rules register only in patches, shred into fragments, and take whole tables
with them.

Ink is therefore either plainly dark *or* darker than the paper immediately around it.
The second half needs a local mean, which a summed-area table gives from four lookups
per pixel. Taking the union rather than replacing keeps it strictly additive: nothing
that used to register stops registering. On the scanned application it took detected
table cells from 11 to 24, with both tables found rather than one.

Otsu's method was the obvious thing to try first and it is the wrong tool here: a form
with solid black section banners gives it two strong populations to split on, and it
discards the grey rules entirely — 7 cells down to 1. That reasoning is kept in the
source so nobody repeats it.

### Captioned boxes

The blank-line model — a rule with a label beside it — covers most of a printed form and
almost none of a government one. A DMV application is a grid, and the caption is printed
*inside* each box, in the top-left, with the room underneath left for the answer. "Last",
"City", "ZIP", "Eye Color" are all drawn that way.

Treating any box with ink in it as already filled threw that whole pattern away. On a DMV
application it found twenty things to fill in out of about fifty, and because it then had
to guess the labels from whatever text sat nearest, it asked for "ft", "in" and "lbs"
instead of Height and Weight. So the question is not whether a cell has ink but *where*:
the first band of ink, with a clear run under it, is a caption, and the answer goes in
the clear part. That caption is also the field's name — read straight out of the box,
with nothing to infer.

Three failures had to be fixed before that paid off, and each cost a whole class of field:

- **A section banner is drawn as two rules six pixels apart.** Each one saw the other,
  called it a row of text, and both were thrown away — along with every cell on that row.
  Nearly-solid across the same width is the tell; type never is.
- **`findCells` stopped at the first neighbour it found for each upright.** But "nearest
  neighbour" is a property of an upright *on a given row*: the left border of a form
  meets a different divider in every band it passes through. Breaking after the first
  match lost the leftmost cell of every other row.
- **The outer border is the upright most likely to be missing.** It runs the whole page,
  so any fold or soft edge in a scan breaks it into pieces too short to register. The
  rules crossing it all stop at the same place, though, and enough of them agreeing is
  better evidence of an edge than one faint column of pixels — so the border the rows
  imply is used where the real one is absent. Only on a page that is already plainly a
  grid: guessing an edge on a page of plain blank lines would turn the blanks into
  borders.

A rule with an upright at each end is a border, not a blank — it is drawn to divide the
page. Offering those as blanks put a text box through the middle of the grid.

On the DMV application: 20 fields found before, 58 after, and the ones that carry a
printed caption now carry its exact words.

### Tables

A ruled table is the one place on a form where the blank is a box rather than a line,
and where the answer belongs in the middle of it. Finding them needs the vertical rules
the line scan ignores; with both sets, a cell is the gap between two neighbouring
uprights, closed off by two of the horizontals that span it. Cells that already have
something in them are the headings, so only the empty ones are offered.

Text typed into a cell is centred in the box on screen and centred again on export,
where pdf-lib measures the string and places it. Tab walks a grid the way you would
read it — across the row, then down — because grid order and reading order are the same
thing, and the ordering code already did that.

Rules spent on a table are no longer offered as blanks to write on. That ordering
matters: an earlier heuristic discarded the edges of any written-in rectangle, and faced
with a whole table it removed every rule in it, leaving nothing to build cells from. Grid
detection now runs on the full set of rules and the blunt rejection only sees what is
left over.

### Scans and skew

A photographed or scanned page is never perfectly square, and a rule that drifts a
couple of pixels across the width comes back as a row of overlapping fragments — on a
real employment application, one "Full Name:" line arrived as five, and the page went
from ~20 blanks to 78. Collinear neighbours are stitched back together, and the black
edge of the scan itself is discarded. That one change took the same page from 78 lines
to 27, which is what is actually on it. Tick boxes never had the problem: all 32 on
that form, including every cell of the 3×7 availability grid, were found from the
start.

### Scans

A scanned page has no text layer, so there is nothing to read. Detection still works —
lines and tick boxes come from pixels, not text — so the blanks are all there and all
fillable; they are simply numbered rather than named, and the chooser says so. Reading
them properly needs OCR, which is the next piece of work.

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

## Turning a photograph into a scan

Away from a desk the choice is otherwise between filling a form in by hand and not
filling it in at all, and handwriting is the thing people apologise for. So: take a
photo of the paper, and fill it in here instead.

Draining the colour is most of what makes a photo look like a scan, and it is not
enough on its own. A phone photo of paper is grey rather than white, lit unevenly, and
— on anything printed double-sided — carries a ghost of the other side showing through.
Left alone the ghost survives into the PDF and reads as dirt.

The fix is to pin the white point just under the paper itself: whatever is lighter than
paper-minus-a-margin becomes plain white, so the grey, the shadow and the ghost all go
at once while the ink stays. But *one* white point for the whole photograph cannot work,
and that was the first attempt: a hand holding a phone puts a shadow across one corner,
and a level set from the lit side turns the shadowed side into a black smear.

So the paper is measured where it is. On a coarse grid, each cell reports the level its
brightest tenth sits at — the paper there, not the ink — and the grid is smoothed twice
so the lighting reads as the gradient it actually is, then sampled bilinearly so no cell
edges show. Every pixel is then judged against the paper beside it. Three settings vary
only how hard that judgement is: **Photo** does none of it, **Scan** is the default, and
**Strong** pushes the white point further down for a page with a heavy shadow.

The page keeps the photo's own shape — nothing is stretched to a paper size it was never
on — scaled so the long edge is eleven inches, which lands a photo of a Letter page on
very nearly Letter. From there it is an ordinary PDF, and everything else in this file
applies to it: on the test photograph, a hand-filled property form shot on a phone, the
scan finds 23 blank lines and 41 tick boxes.

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
Two details matter more than they look.

**Every rule on a row, not just the widest.** A row like `City ______  State ____
ZIP ______` is three separate rules at the same height. Keeping one run per row —
the obvious implementation — silently drops the other two, and the short middle one
is exactly the blank a person then finds "doesn't register". Rows therefore collect
all qualifying runs, and bands grow downwards by matching each run to the band it
actually overlaps, so neighbouring rules never merge into one.

**Labels sit beside a blank or above it.** `inkHeightLeft()` walks up from the rule to
the nearest ink cluster on its left — the label in `Tenant name: ______` — and derives
a font size from its height. When there is nothing to the left, which is the case for
any rule starting at the page margin, it looks directly above the rule within the
rule's own width instead. If neither finds a label, the size falls back to the default
rather than to the bottom of the clamp; that fallback is the difference between a
sensible box and a 6pt one.

The whole scan is cached per page and only runs once per rotation.

## Making the guesses visible

A declared form field shows you where to type; a blank line does not. So the app draws
one. Each line the scan finds gets a faint box sitting on it — which makes the guess
visible *and* gives you something to aim at. Tapping it starts a text box on that line,
the same object Tab and the Next button create.

The boxes are decoration only, `pointer-events: none`: the page already owns the
gesture, and letting an overlay take it would break scrolling. The page's own handler
hit-tests them, and a press only counts as a tap if the finger stayed within 8px — so a
scroll that happens to start on a blank is still a scroll.

One consequence of drawing the guesses is that bad ones become obvious. That surfaced a
real false positive: the borders of a table cell are long, thin, isolated rules and pass
every line test, so the cell was being offered as somewhere to write — with the box drawn
over the text already in it. Two rules of the same width joined down both sides are the
edges of a rectangle rather than two blanks, and if that rectangle already has ink in it,
it is a table cell and neither edge is offered. An *empty* bordered box still is, because
that is a real place to write.

### When the boxes landed in the wrong place

On a dense scanned form the boxes came out badly wrong, and for two separate reasons
worth keeping apart.

**A box grew upwards into whatever was printed above it.** The box has to be about a
line tall so there is somewhere to write; drawing that height blindly upwards from the
rule works on an airy form and lands squarely on a section banner on a crowded one.
`clearAbove()` now measures the gap from each rule to the nearest ink over its own
width, and both the box and the text size stop just short of it. Throwing the rule away
instead was tried first and was worse: "Full Name" on a scanned application sits
directly under a solid black banner, and a rule is not disqualified from being a blank
by what happens to be printed above it — that experiment deleted 13 of 23 real blanks.

**A whole word was being read as a rule.** In a heavy label like `Phone Number:` the
letters nearly touch across the word's x-height, so every row of it reads as a solid
run and the word arrives as one eight-pixel band. It passed the existing tests because
the checks three and five pixels out are clear — the stems are thin there. The tell is
that a real rule is *drawn* solid: six or more dense rows with gaps still in them is a
word, not a rule.

That second one did more damage than it looked. The phantom sat within stitching
distance of the genuine rule beside it, so the two merged and dragged the blank's left
edge back across the label — the hint then struck through the very words naming the
field. Fixing the phantom fixed the misplacement with it. On the scanned application:
23 bands down to 18, every one of them a real blank, each starting after its label.

## Reading order

Tab and the Back / Next bar walk one ordered list per page, built from all three kinds
of spot at once. Two things make that order come out right.

Every spot reports `cy` — the middle of *where you would write* — rather than whatever
edge each kind happens to know about. A field's rect gives its top, a rule gives its
baseline with the text sitting above it, a tick box gives its outline. Sorting those
raw values put things that share a visual row a whole line-height apart and the order
jumped around. Each kind now converts to the same anchor first.

Rows are then grown top to bottom, joining a spot to the current row when its middle
is within about a line of the row's, and each row is read left to right. Row height
comes from the spots themselves, so a row of tick boxes and a row of tall multi-line
fields both group correctly without a magic constant.

The cursor only moves when you actually do something: typing in a field, snapping text
or a signature to a line, ticking a box, or grabbing something already placed. A bare
tap on the page leaves it where it was, so Next carries on from the field you had open
rather than from wherever your thumb landed.

## Why the page sometimes came back black

A canvas created with `alpha: false` has no transparent state to fall back on: once
the browser reclaims its backing store — which Android does routinely to a
backgrounded tab — reading it gives solid black. The app kept a `renderKey` saying
"already drawn at this size", so it never redrew, and `pageBg()` then sampled that
black as the page colour and painted it behind every form field.

Two defences. Coming back into view (`visibilitychange`, `pageshow`) or getting a
`contextrestored` event throws away everything the app believes about a page's pixels
and redraws whatever is on screen. And `pageBg()` samples three corners rather than
one, keeps the lightest, and refuses an essentially-black result outright — a form
field's backing fill is never legitimately black, so white is the safer answer.

Nothing you typed is affected either way: text, marks and field values live in state
and the DOM, not on the canvas.

## Shipping a fix that actually arrives

The service worker was cache-first for everything, which is the standard recipe and the
wrong one here. It served the stored copy and refreshed in the background, so every visit
showed the *previous* build and a fix only appeared the visit after — a bug could be
fixed, deployed, and still be there the next morning. The libraries and icons stay
cache-first, since they never change without changing their name. The app itself now asks
the network first and falls back to the cache, so it still works offline and a plain
refresh is enough to be on the current version.

## Zooming in must not make the page smaller

The keyboard handling below works by sizing the editor to `visualViewport`, which is
right for a keyboard and wrong for everything else that shrinks it — and pinch to zoom
shrinks it too. At 2.6× the visual viewport reports roughly a third of the height, so the
editor collapsed to a third of the screen, the stage collapsed with it, and zooming in to
read a line squeezed the whole document into a strip. While the page is scaled the layout
is left alone and the browser pans over it, which is what zoom is for.

Two smaller things fed the same problem. Re-fitting the page width on every resize meant a
keyboard — which changes only the height — could still re-fit and throw away your zoom;
the width is only recomputed when the width actually changed. And `maximum-scale=1` in the
viewport tag is redundant next to `user-scalable=no` while also telling the browser the
ideal scale is 1, which is how focusing a text box could snap you straight back out of the
zoom you had set.

## Two fingers is a pinch, never a drag

The first finger of a pinch has to land somewhere, and on a form you have been filling in
that is quite often on a text box. A drag started from it rode along with the zoom and
left the box somewhere nobody put it — and the further you pinched the further it went.

So the fingers are counted. A drag or a resize never starts once a second one is down, and
one already under way gives back everything it moved the moment the second finger arrives,
taking its undo step off the stack with it: a pinch should leave no trace, not something
to undo. The same guard covers tapping a blank, which would otherwise open a text box in
the middle of a zoom.

## A name has to survive the journey

Downloading a file here is forgiving: the browser writes whatever name it is given. But a
name goes on a journey after that — an Android share hands it to a mail app, which puts it
in a MIME header, which travels — and something along that road quietly drops the
attachment, so the first sign of trouble is "couldn't download attachment" for whoever
opens the mail. Em dashes, smart quotes and accents arrive in the name from the original
document without anyone typing them, so the trip can start broken.

The name is now reduced to characters nobody can argue about: accents flattened, dashes of
every width folded to a hyphen, smart quotes dropped, anything else replaced by a space,
and the whole thing capped at sixty characters. The share also hands over the bytes read
back out in full rather than the blob, because a blob is a promise of bytes and an app that
fails to collect them attaches an empty file instead — which, again, only shows up as a
failed download at the far end.

## A tick grows around itself

Objects are stored by their top-left corner, so changing a mark's size alone grows it down
and to the right — and a tick you enlarged because it was too small for its box has now
walked out of the box. Every resize cost a drag to put it back, which is most of the value
of resizing gone. A mark now keeps its middle where it is and grows around it, whether you
use the size buttons or drag the corner handle.

Two things surfaced while proving it. `setPointerCapture` was called unguarded when a
resize starts, so a refused capture threw and the resize silently did nothing. And the
resize listened on the element rather than the window, which only works *while* capture
holds — the first drag past the edge of a small tick would otherwise leave the element
behind and stop. A drag belongs to the gesture, not to whatever it happens to be over.

## Who is allowed to move the page

Only Back / Next and Tab. They centre what you land on, because asking to be taken
somewhere and being taken there is the whole point of pressing them.

Nothing else scrolls on purpose. Tapping a blank used to re-centre it, which reads as the
page lurching under your finger just as you start typing — you lose your place mid-word,
and it happens on every field. A tap already put the thing in front of you; there is
nothing to fix. The one real exception is a keyboard opening over what you just tapped,
so a tap scrolls only when the spot is genuinely out of sight, and then by the least that
brings it back rather than re-centring the page.

## Double tap puts a box where you want it

The scan is a guess. It misses things — a blank drawn in some way nothing accounts for, a
box the grid logic could not close. The answer is not to make you go up to the toolbar,
arm the Text tool, and come back: the second tap drops a text box exactly where your
finger is, already selected, so the next thing you type goes in it. Browsers spend that
gesture on zoom; this page has no use for it, the viewport is fixed.

It never overrules something the scan *did* find. A tick box or a marked blank under your
finger does its own thing, and a quick double tap on one of those is just an impatient
single tap.

Two things owned that gesture and both had to give it up. The app had its own double-tap
zoom, which ran on `pointerup` at the stage and got there first — so on a phone the tap
did nothing but zoom, and no amount of work further down the page could be reached. And
`user-scalable=no` in the viewport tag stops the browser's double-tap zoom on Android but
not on iOS, which has ignored it since iOS 10; `touch-action: manipulation` is what
actually says *pan and pinch, but no double-tap zoom*. Two fingers still zoom, which is
how people zoom anyway, and ctrl with the wheel still does it on a desktop.

An empty box shows a placeholder, which is what makes it draggable — an empty box with
nothing in it is invisible, and you cannot take hold of something you cannot see. The
placeholder is drawn by CSS from `data-ph`, so it is never content: typing does not have
to delete it first, and it can never reach the exported PDF. Drag the box and the caret
comes back when you let go, because you moved it to write in it. Tap somewhere else
without typing and it is gone.

## Keeping the bars on screen

An on-screen keyboard is two different problems. Chrome honours
`interactive-widget=resizes-content` and shrinks the *layout* viewport, so the editor's
flex column simply gets shorter and every bar stays where it was. Safari ignores that:
it leaves the layout viewport alone, shrinks the *visual* viewport and scrolls it —
which slides a `position: fixed` element's top edge off the screen, taking Back / Next
with it. So the editor also follows `visualViewport` directly, setting its own `top` and
`height` to whatever is actually visible.

Detecting the keyboard differs for the same reason: on Safari the gap between
`innerHeight` and `visualViewport.height` gives it away, while on Chrome that gap closes,
so focus on an editable element on a touch device is the signal instead. Either way the
tool row hides while typing — you are writing, not placing, and the space is better spent
on the document.

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
