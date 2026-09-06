# Local layout detection

The app uses bundled PDF.js, Tesseract.js/WASM, pixel geometry, and pdf-lib in the browser. There is no model call, document-processing server, or runtime template lookup. Tests contain manually annotated coordinates solely as an independent scoring oracle; the application never loads those fixtures.

## Evidence and rules

- Read native PDF widgets and embedded text first. OCR scanned pages locally, one page/worker at a time, with a 2,200-pixel width and 6.5-million-pixel render cap.
- Keep photo borders separate from thin rules. Reconstruct adjacent cells from intersections and repeated open edges; short upright segments can establish open-top amount boxes.
- Require physical vertical-edge evidence before turning aligned underlines into cells; otherwise keep the individual blanks. Associate distant left labels without jumping over another blank.
- Read captioned boxes below their printed labels. Combine compact table column headings with row labels. Recombine subdivided identifier rows into logical fields using adjacent table columns.
- Recognize externally captioned response boxes, including tall notes areas, and reread apparently empty caption cells in small local OCR crops.
- Associate separate date boxes with MM/DD/YY/YYYY captions above or below them. Follow the printed order, preserve outside captions and separators, and verify repeated year letters against their pixel stems.
- Combine contiguous equal character boxes under ID/code/account labels into one answer with one character per box. Preserve letters and leading zeroes; report excessive input without silently discarding it.
- Distinguish independent square controls, circular choices, and explicit “check only one” groups. Validate fallback boxes against their outlines and reject circles inside OCR words.
- Detect regular dashed blanks separately from widely spaced dot leaders. Reject headings, table borders, and printed instruction panels as answer areas.
- For dense ruled grids, remove measured rules from the OCR copy and reread small occupied cells sequentially. The original document image is preserved.
- Use a shared font size for the page's regular rows, capped at 10 pt. Dense pages can use a smaller shared size; long answers may shrink further to 6.75 pt before reporting overflow. Preserve that base size with each answer so reopening cannot enlarge it accidentally.

`form-layout.mjs` contains geometry and text fitting. `app.js` coordinates OCR, the editor, persistence, and export. No form name, document hash, sample answers, tax-year coordinates, or downloaded form schema participates in detection.

## Verification

Run `npm test`, `npm run test:browser`, `npm run test:dense`, `npm run test:formats`, and `npm run test:patterns`. Windows can select installed Edge with `BROWSER_CHANNEL=msedge`. CI runs Chromium on Linux. Set `TEST_BASE_URL` to the deployed site to test production; all browser suites first verify that the deployed source matches the checkout exactly.

The employment test scores every original target and exercises filling, exclusive choices, tab navigation, uniform typography, native PDF controls, signing, export, saved corrections, and an offline rescan. Unit tests cover black photo margins, square outlines, segmented identifier rows, and twelve generated arrangements of caption boxes and compact tables.

The dense test independently annotates 121 visible targets, measures recall and false positives, fills the actual detected fields through the UI, checks text fitting and uniform size, and exports with the application's own PDF path. It blocks and records off-site requests. Its fictional values deliberately exercise placement; they are not a valid tax return.

The pattern suite scores the mixed-layout sample (21 logical questions, including six physical choice controls) and three independently drawn layouts (10 questions each). The generated layouts vary label wording and gaps, date order, four/six/eight character boxes, and notes-box dimensions. It checks independent blank bounds, printed component order, overflow handling, exclusive choices, signatures, offline filling/export, and segment coordinates in the exported PDF. The fixture generator is test-only, requires Python/Pillow and Arial or Liberation Sans, and is not shipped as part of the processing code. Further units vary geometry across dozens of arrangements and reject false cells/controls. These fixtures are regression coverage, not a population-wide accuracy estimate.

This is a heuristic detector, not universal visual comprehension. OCR labels may contain errors. Faint date placeholders, unusual inline blanks, and ambiguous glyphs can require manual adjustment. The result must be reviewed before signing or sending. Test reports list misses rather than quietly supplying their coordinates to the application. Desktop JavaScript heap and timing measurements do not establish total process memory or speed on a 4 GB device.
