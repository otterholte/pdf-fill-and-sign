/* Fill & Sign — open it, fill it out, sign it, send it back.
   Built by Eli Otterholt. There is no server: every byte stays in this browser. */

import * as pdfjsLib from './vendor/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const { PDFDocument, StandardFonts, rgb, LineCapStyle, degrees } = PDFLib;

/* ---------------------------------------------------------------- helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10);

let toastT;
function toast(msg, ms = 2400) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}
function busy(on, text = 'Working…') { $('#busyText').textContent = text; $('#busy').hidden = !on; }
const hex2rgb = h => {
  const n = parseInt(h.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/* ---------------------------------------------------------------- dates */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = n => String(n).padStart(2, '0');
function timeStr(d) {
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${pad2(d.getMinutes())} ${ap}`;
}
const FMTS = [
  { id: 0, label: '08/05/2026', fn: d => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}` },
  { id: 1, label: 'August 5, 2026', fn: d => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` },
  { id: 2, label: '5 August 2026', fn: d => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` },
  { id: 3, label: 'August 5, 2026 at 12:34 AM', fn: d => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${timeStr(d)}` },
  { id: 4, label: '08/05/2026 12:34 AM', fn: d => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()} ${timeStr(d)}` },
];
const DATE_CYCLE = [0, 1, 2];
const STAMP_CYCLE = [3, 4, 1, 0];
const fmtOf = id => FMTS.find(f => f.id === id) || FMTS[0];
const renderDate = it => fmtOf(it.date.fmt).fn(new Date(it.date.at));
const shortLabel = id => (id === 3 || id === 4 ? fmtOf(id).label.split(' at ')[0].split(' ').slice(0, 3).join(' ') + ' + time' : fmtOf(id).label);

/* ------------------------------------------------------------- tiny IndexedDB */
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('fillandsign', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const rq = fn(t.objectStore('kv'));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)),
    set: (k, v) => tx('readwrite', s => s.put(v, k)),
    del: k => tx('readwrite', s => s.delete(k)),
  };
})();

/* --------------------------------------------------------------- state */
const COLORS = ['#0b0f14', '#1b4fd8', '#c8202a'];
const DEF = { fs: 0.0165, stampFs: 0.0105, mark: 0.034, sigW: 0.26, redW: 0.34, redH: 0.032 };

/* ------------------------------------------------------- how big to write

   Sizes are stored as a fraction of the page's height, because that is what
   survives zooming, rotating and exporting. But "a fraction of the height" is
   not what a size *means* to anyone: the same fraction is 12pt on Letter and
   15pt on a Legal page, and the writing quietly grows with the paper.

   So the defaults are decided per page from a fixed physical size. Filling in
   a form by hand lands somewhere around 9–14 CSS pixels whatever the paper
   is, and that is the range these hold to.

   The numbers are in CSS pixels, converted, because that is the ruler people
   actually have a feel for — and a point is not one. A point is 1/72 inch and
   a CSS pixel is 1/96, so 14pt is 18.7px: a "14" ceiling set in points still
   came out looking like a headline.

   The ceiling is the important half. Text snapped to a blank is sized to the
   printed words beside it, which is right for a caption and wrong for a
   heading: a blank under a 30pt title was being offered 30pt writing, which
   is a poster, not an answer. Matching still decides the size inside the
   range; the range decides how far matching is allowed to go. */
const PX = 0.75;                                  // one CSS pixel, in points
const TEXT_PT = { min: 9 * PX, max: 14 * PX, def: 12 * PX };
/* A signature with no rule under it has nothing to match, so it gets a size
   that reads as handwriting rather than a banner: about two lines of ordinary
   text tall, and never more than a fifth of the page wide. Width used to be
   the fixed quantity, which meant a tall narrow scan and a wide flat one came
   out the same *width* and wildly different sizes. Height is the thing the
   eye compares, so height is what is held. */
const SIG_PT = 26 * PX, SIG_W_MAX = 0.20;
/** the page's height in PDF points, as it is currently turned */
const pageHpt = p => (localDims(p.uw, p.uh, totalRot(p))[1] || 792);
/** the same three sizes as fractions of *this* page's height */
function fsRange(p) {
  const H = pageHpt(p);
  return { lo: TEXT_PT.min / H, hi: TEXT_PT.max / H, def: TEXT_PT.def / H };
}
/** How wide a signature of aspect ratio `ar` must be to stand `h` tall,
    `h` being a fraction of the page height. Width follows from height because
    height is the thing that has to look right — it is what a signature shares
    with the writing around it. Sizing by width instead meant a tall narrow
    scan and a wide flat one came out the same width and wildly different
    sizes. */
function sigWidth(p, ar, h) {
  const [Wl, Hl] = localDims(p.lw, p.lh, totalRot(p));
  return clamp((h * Hl) / (Wl * ar), 0.05, SIG_W_MAX);
}
/** …and on a rule, matched to the label beside it and never wider than the
    rule. One function, because there are two ways to land a signature on a
    line — by tapping it and from the simple view — and they had drifted
    apart, so the same rule gave you two different signatures. */
function sigOnLine(p, L, ar) {
  const hWant = clamp(L.fs * 2.2, 0.018, (SIG_PT * 1.4) / pageHpt(p));
  return Math.min(sigWidth(p, ar, hWant), Math.max(0.08, (L.x1 - L.x0) * 0.98));
}

/** what a hand-filled blank should be set in, given the printed words beside
    it (`want`, already a fraction of the page height) — or nothing at all */
const fsFit = (p, want) => {
  const R = fsRange(p);
  return want ? clamp(want, R.lo, R.hi) : R.def;
};

/* A signature timestamp tracks the signature's width so the two look like one
   object — but only down to a point. Past it the date stops shrinking, because
   an unreadable date under a signature is worse than a slightly large one. The
   floor is the same 6.7pt-on-Letter minimum used for snapped text elsewhere;
   the ceiling stops a page-wide signature dragging the date up with it. */
const MIN_STAMP_FS = 0.0085;
const MAX_STAMP_FS = 0.055;
const stampFsFor = w => clamp(DEF.stampFs * (w / DEF.sigW), MIN_STAMP_FS, MAX_STAMP_FS);
/* tools that stay armed so you can tap several in a row */
/* Nothing stays armed. A tool that keeps itself on turns the next scroll, the
   next nudge of something you just placed, into another mark somewhere you
   did not want one — and you only notice later. One tap, one mark. */
const STICKY = new Set();
/* distance from the top of a text line-box down to its baseline, in ems
   (line-height 1.25 on an Arial/Helvetica-metric face). Verified against
   the browser's own rendering — keeps the export pixel-aligned with the editor. */
const BASELINE = 0.972;
const LINEH = 1.25;
const DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 100 * 1024 * 1024;

const S = {
  name: 'Document.pdf', bytes: null, pdf: null,
  pageBox: [], items: [], sel: null, tool: null,
  fields: {},        // real AcroForm values, keyed by field name
  fields0: {},       // whatever the document already had in them
  zoom: 1, baseW: 0, past: [], future: [], renderTok: 0,
};

const pagesEl = $('#pages');
const stageEl = $('#stage');

/* ------------------------------------------------------------------ history */
/* The crop belongs in here with the rest of it. It always should have — but
   while it only showed up at the download you could undo past one and not
   notice; now that the page visibly closes around it, an undo that left it
   cropped would look like the undo had failed. */
const snap = () => JSON.stringify({
  i: S.items, r: S.pageBox.map(p => p.userRot), f: S.fields,
  c: S.pageBox.map(p => p.crop || null),
});
function restore(str) {
  const o = JSON.parse(str);
  S.items = o.i;
  S.fields = o.f || {};
  o.r.forEach((r, i) => { if (S.pageBox[i]) S.pageBox[i].userRot = r; });
  (o.c || []).forEach((c, i) => { if (S.pageBox[i]) S.pageBox[i].crop = c || null; });
  S.sel = null;
  layoutPages(); paintItems(); paintFields(); syncBars(); renderVisible(); saveSoon();
}
function push() {
  S.past.push(snap());
  if (S.past.length > 80) S.past.shift();
  S.future.length = 0;
  syncHistory(); saveSoon();
}
function syncHistory() {
  $('#btnUndo').disabled = !S.past.length;
  $('#btnRedo').disabled = !S.future.length;
}
function undo() { if (!S.past.length) return; S.future.push(snap()); restore(S.past.pop()); syncHistory(); }
function redo() { if (!S.future.length) return; S.past.push(snap()); restore(S.future.pop()); syncHistory(); }
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);

/* ------------------------------------------------------------- autosave */
let saveT;
function saveSoon() {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    if (!S.bytes) return;
    try {
      await DB.set('doc', {
        name: S.name, bytes: S.bytes,
        items: S.items.filter(i => !isText(i) || i.date || i.text.trim()),
        fields: S.fields,
        rots: S.pageBox.map(p => p.userRot),
        crops: S.pageBox.map(p => p.crop || null), ts: Date.now(),
      });
    } catch (_) {}
  }, 700);
}

/* ================================================================= OPENING */
$('#btnOpen').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', e => {
  const f = e.target.files[0]; if (f) openFile(f);
  e.target.value = '';
});

const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => {
  const all = [...(e.dataTransfer?.files || [])];
  const f = all.find(x => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
  if (f) return openFile(f);
  // a photo dropped on the page is a form somebody scanned, not a mistake
  const pics = all.filter(x => /^image\//.test(x.type));
  if (pics.length) { SCAN.shots = []; return void addShots(pics); }
  toast('That file is not a PDF.');
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

/* ======================================================= SCAN A PAPER FORM
   A photograph of a form, turned into the kind of PDF the rest of this app
   already knows how to read. It matters more than it sounds: away from a
   desk, the choice is otherwise between filling a form in by hand and not
   filling it in at all, and handwriting is the thing people apologise for.

   Draining the colour is most of it, but not all of it. A phone photo of
   paper is grey, not white, lit uneven, and — on anything printed
   double-sided — carries a ghost of the other side showing through. Left
   alone that ghost survives into the PDF and reads as dirt. Pinning the
   white point just under the paper itself is what removes it: whatever is
   lighter than paper-minus-a-margin becomes plain white, so the shadow, the
   grey and the ghost all go at once and the ink stays. */

const SCAN_MAX = 2200;                  // ~200dpi across a sheet of Letter
const LOOKS = {
  photo: null,                          // grey, nothing else
  scan:  { lo: 0.34, hi: 0.93, gamma: 1.00 },
  ink:   { lo: 0.52, hi: 0.88, gamma: 1.15 },
};

/* How bright the paper is *here*. One number for the whole photograph cannot
   work: a hand holding a phone puts a shadow across one corner, and a level
   set from the lit side turns the shadowed side into a black smear. So
   estimate the paper on a coarse grid — in each cell, the level the brightest
   tenth of it sits at, which is the paper and not the ink — smooth the grid so
   the lighting reads as the gradient it is, and judge every pixel against the
   paper beside it rather than against the page as a whole. */
function paperGrid(gray, w, h) {
  const cell = clamp(Math.round(Math.min(w, h) / 40), 8, 64);
  const gw = Math.max(1, Math.ceil(w / cell)), gh = Math.max(1, Math.ceil(h / cell));
  const BINS = 32, bins = new Uint32Array(gw * gh * BINS), count = new Uint32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = (y / cell) | 0, row = y * w;
    for (let x = 0; x < w; x++) {
      const g = (gy * gw + ((x / cell) | 0));
      bins[g * BINS + (gray[row + x] >> 3)]++;
      count[g]++;
    }
  }
  let bg = new Float32Array(gw * gh);
  for (let g = 0; g < gw * gh; g++) {
    const need = Math.max(1, count[g] * 0.10);      // the brightest tenth is paper
    let seen = 0, b = BINS - 1;
    for (; b > 0; b--) { seen += bins[g * BINS + b]; if (seen >= need) break; }
    bg[g] = Math.max(40, b * 8 + 4);
  }
  // smooth twice: lighting is a gradient, not a set of tiles
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= gh || xx < 0 || xx >= gw) continue;
        s += bg[yy * gw + xx]; n++;
      }
      out[y * gw + x] = s / n;
    }
    bg = out;
  }
  return { bg, gw, gh, cell };
}

/** grey the image, then judge every pixel against the paper next to it */
function scanCanvas(bm, look) {
  const s = Math.min(1, SCAN_MAX / Math.max(bm.width, bm.height));
  const w = Math.max(1, Math.round(bm.width * s)), h = Math.max(1, Math.round(bm.height * s));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bm, 0, 0, w, h);

  const im = cx.getImageData(0, 0, w, h), d = im.data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, m = 0; m < gray.length; m++, i += 4) {
    gray[m] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  }

  const cfg = LOOKS[look];
  if (!cfg) {
    for (let i = 0, m = 0; m < gray.length; m++, i += 4) d[i] = d[i + 1] = d[i + 2] = gray[m];
    cx.putImageData(im, 0, 0);
    return cv;
  }

  const { bg, gw, gh, cell } = paperGrid(gray, w, h);
  const span = cfg.hi - cfg.lo;
  for (let y = 0; y < h; y++) {
    // bilinear across the coarse grid, so no cell edges show in the result
    const fy = clamp(y / cell - 0.5, 0, gh - 1);
    const y0 = fy | 0, y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = clamp(x / cell - 0.5, 0, gw - 1);
      const x0 = fx | 0, x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      const a = bg[y0 * gw + x0] + (bg[y0 * gw + x1] - bg[y0 * gw + x0]) * tx;
      const b = bg[y1 * gw + x0] + (bg[y1 * gw + x1] - bg[y1 * gw + x0]) * tx;
      const paper = a + (b - a) * ty;
      const t = clamp((gray[y * w + x] / paper - cfg.lo) / span, 0, 1);
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = Math.round(Math.pow(t, cfg.gamma) * 255);
    }
  }
  cx.putImageData(im, 0, 0);
  return cv;
}

const SCAN = { shots: [], look: 'scan', busy: false };

const toBlob = (cv, q) => new Promise(res => cv.toBlob(res, 'image/jpeg', q));

async function addShots(files) {
  const imgs = [...files].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
  if (!imgs.length) return toast('That file is not a photo.');
  busy(true, 'Reading…');
  try {
    for (const f of imgs) {
      try {
        // `from-image` is what keeps a portrait photo portrait; older
        // browsers reject the option rather than ignore it
        let bm;
        try { bm = await createImageBitmap(f, { imageOrientation: 'from-image' }); }
        catch (_) { bm = await createImageBitmap(f); }
        SCAN.shots.push({ bm, name: f.name });
      } catch (_) { toast('One of those photos could not be read.'); }
    }
  } finally { busy(false); }
  if (SCAN.shots.length) { $('#scanPick').hidden = true; await drawShots(); }
}

async function drawShots() {
  const strip = $('#scanStrip');
  strip.innerHTML = '';
  SCAN.shots.forEach((s, i) => {
    const fig = document.createElement('figure');
    fig.className = 'shot';
    const cv = scanCanvas(s.bm, SCAN.look);
    s.cv = cv;
    const view = document.createElement('canvas');
    const k = Math.min(1, 900 / Math.max(cv.width, cv.height));
    view.width = Math.round(cv.width * k); view.height = Math.round(cv.height * k);
    view.getContext('2d').drawImage(cv, 0, 0, view.width, view.height);
    const drop = document.createElement('button');
    drop.className = 'shot-drop';
    drop.setAttribute('aria-label', 'Remove this page');
    drop.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
    drop.addEventListener('click', () => {
      SCAN.shots.splice(i, 1);
      if (!SCAN.shots.length) { $('#scanPrev').hidden = true; return; }
      drawShots();
    });
    const cap = document.createElement('figcaption');
    cap.textContent = `Page ${i + 1}`;
    fig.append(view, drop, cap);
    strip.append(fig);
  });
  $('#scanTitle').textContent = SCAN.shots.length > 1
    ? `Check the scan · ${SCAN.shots.length} pages` : 'Check the scan';
  $('#scanPrev').hidden = false;
}

/** one page per photo, at the size the paper really is */
async function shotsToPdf() {
  const doc = await PDFDocument.create();
  for (const s of SCAN.shots) {
    const cv = s.cv || scanCanvas(s.bm, SCAN.look);
    const blob = await toBlob(cv, 0.82);
    const img = await doc.embedJpg(await blob.arrayBuffer());
    /* Keep the photo's own shape — nothing is stretched to fit a paper size
       it was never on — and scale it so the long edge is eleven inches, which
       lands a photo of a Letter page on very nearly Letter. */
    const long = Math.max(cv.width, cv.height);
    const W = (cv.width / long) * 792, H = (cv.height / long) * 792;
    doc.addPage([W, H]).drawImage(img, { x: 0, y: 0, width: W, height: H });
  }
  return doc.save();
}

$('#btnScan').addEventListener('click', () => { SCAN.shots = []; $('#scanPick').hidden = false; });
$('#btnCam').addEventListener('click', () => $('#camInput').click());
$('#btnPics').addEventListener('click', () => $('#picInput').click());
['#camInput', '#picInput'].forEach(sel => $(sel).addEventListener('change', e => {
  const fs = [...e.target.files]; e.target.value = '';
  if (fs.length) addShots(fs);
}));
$('#btnScanMore').addEventListener('click', () => { $('#scanPick').hidden = false; });
$('#lookRow').addEventListener('click', e => {
  const b = e.target.closest('.look'); if (!b || SCAN.busy) return;
  SCAN.look = b.dataset.look;
  $$('#lookRow .look').forEach(x => x.classList.toggle('is-on', x === b));
  drawShots();
});
$('#btnScanGo').addEventListener('click', async () => {
  if (SCAN.busy || !SCAN.shots.length) return;
  SCAN.busy = true;
  busy(true, 'Making the PDF…');
  try {
    const bytes = await shotsToPdf();
    const name = SCAN.shots.length > 1 ? 'Scan.pdf' : (SCAN.shots[0].name || 'Scan').replace(/\.[^.]+$/, '') + '.pdf';
    $('#scanPrev').hidden = true;
    SCAN.shots.forEach(s => s.bm.close?.());
    SCAN.shots = [];
    await loadDoc(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), name, [], null);
    askView(name);
  } catch (err) {
    console.error(err);
    toast('That photo could not be turned into a PDF.', 5000);
  } finally { SCAN.busy = false; busy(false); }
});

async function openFile(file) {
  if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) return toast('That file is not a PDF.');
  if (file.size > MAX_BYTES) {
    return toast('This document is too large to complete on this device. Try using a smaller PDF or another device.', 6000);
  }
  busy(true, 'Opening…');
  try {
    const buf = await file.arrayBuffer();
    await loadDoc(buf, file.name || 'Document.pdf', [], null);
    askView(file.name || 'Document.pdf');
  } catch (err) {
    console.error(err);
    const locked = err?.name === 'PasswordException' || /password/i.test(err?.message || '');
    toast(locked
      ? 'This PDF is locked. Ask the sender for an unlocked copy and try again.'
      : 'This PDF could not be opened. Please ask the sender for a new copy.', 6000);
  } finally { busy(false); }
}

async function loadDoc(buf, name, items, rots, fields, crops) {
  S.bytes = buf.slice(0);
  S.name = name;
  S.items = items || [];
  S.sel = null; S.tool = null; S.past = []; S.future = []; S.zoom = 1;
  S.fields = fields ? { ...fields } : {};
  S.fields0 = {};
  syncHistory();

  S.pdf = await pdfjsLib.getDocument({ data: buf.slice(0), isEvalSupported: false }).promise;

  $('#docName').textContent = name;
  $('#simName').textContent = name;
  $('#docPages').textContent = `${S.pdf.numPages} page${S.pdf.numPages > 1 ? 's' : ''} · stays on this device`;
  $('#home').hidden = true;
  $('#done').hidden = true;
  $('#pick').hidden = true;
  $('#simple').hidden = true;
  $('#editor').hidden = false;
  SIM = { qs: [], scanned: false, built: false };

  armBack();
  await buildPages(rots);
  parkTools();
  (crops || []).forEach((c, i) => { if (S.pageBox[i]) S.pageBox[i].crop = c || null; });
  if (crops?.some(Boolean)) layoutPages();
  syncBars();
  clearBoxCursor();
  KB.pi = 0; KB.key = null; KB.cur = null; KB.at = 0; KB.of = 0;
  syncJump();
  fitViewport();
  focusStage();
  saveSoon();
}

function closeDoc() {
  stopConfetti();
  $('#editor').hidden = true;
  fitViewport();
  $('#done').hidden = true;
  $('#home').hidden = false;
  pagesEl.innerHTML = '';
  try { S.pdf?.destroy?.(); } catch (_) {}
  S.pdf = null; S.bytes = null; S.items = []; S.sel = null; S.tool = null; lastBlob = null;
  S.fields = {}; S.fields0 = {}; formToldOnce = false;
  S.pageBox = [];
  SIM = { qs: [], scanned: false, built: false };
  simSignTarget = null;
  $('#simple').hidden = true;
  $('#pick').hidden = true;
  clearTimeout(hintsT);
  clearBoxCursor();
  KB.pi = 0; KB.key = null; KB.cur = null; KB.at = 0; KB.of = 0;
  checkResume();
}
$('#btnBack').addEventListener('click', () => {
  const touched = S.items.length || allFields().some(f => fieldChanged(f.name));
  if (touched) toast('Draft kept on this device — pick it up any time.');
  closeDoc();
});

/* ================================================================ RENDERING */
const fitWidth = () => Math.min(stageEl.clientWidth - 20, 980);
const totalRot = p => (((p.baseRot + p.userRot) % 360) + 360) % 360;

async function buildPages(rots) {
  pagesEl.innerHTML = '';
  S.pageBox = [];
  S.baseW = lastFitW = fitWidth();

  for (let i = 1; i <= S.pdf.numPages; i++) {
    const page = await S.pdf.getPage(i);
    const un = page.getViewport({ scale: 1, rotation: 0 });
    const el = document.createElement('div');
    el.className = 'page'; el.dataset.i = i - 1;
    const cv = document.createElement('canvas');
    const layer = document.createElement('div');
    layer.className = 'layer';
    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'fields';
    layer.append(fieldWrap);
    const num = document.createElement('div');
    num.className = 'page-num'; num.textContent = `${i}/${S.pdf.numPages}`;
    el.append(cv, num, layer);
    pagesEl.append(el);
    const box = {
      page, el, cv, layer, fieldWrap,
      uw: un.width, uh: un.height,
      baseRot: ((page.rotate || 0) % 360 + 360) % 360,
      userRot: (rots && rots[i - 1]) || 0,
      fields: await readFields(page),
    };
    /* Browsers may throw a canvas's pixels away under memory pressure and
       hand it back blank. Say we want it back rather than letting it stay
       lost, and redraw when it returns. */
    cv.addEventListener('contextlost', e => { e.preventDefault(); forget(box); });
    cv.addEventListener('contextrestored', () => { forget(box); renderSoon(); });
    S.pageBox.push(box);
  }
  seedFieldValues();
  layoutPages();
  paintItems();
  paintFields();
  renderVisible();
  announceForm();
}

/* ============================================== REAL FORM FIELDS (AcroForm)
   Some PDFs genuinely declare where you are meant to type. That is not a
   guess, so honour it: put a real input over each widget and let the keyboard
   do its job. On export the values go back through the document's own form
   and get flattened, which is what a recipient expects. */

async function readFields(page) {
  let anns = [];
  try { anns = await page.getAnnotations({ intent: 'display' }); } catch (_) { return []; }
  const out = [];
  for (const a of anns) {
    if (a.subtype !== 'Widget' || a.readOnly || a.hidden || a.pushButton) continue;
    const type = a.fieldType === 'Tx' ? 'text'
      : a.fieldType === 'Ch' ? 'choice'
      : a.fieldType === 'Btn' ? (a.radioButton ? 'radio' : a.checkBox ? 'check' : null)
      : null;
    if (!type || !a.fieldName) continue;
    out.push({
      name: a.fieldName, type, rect: a.rect,
      fs: a.defaultAppearanceData?.fontSize || 0,
      color: daColor(a.defaultAppearanceData?.fontColor),
      bg: rgbOf(a.backgroundColor),
      align: a.textAlignment || 0,
      multiline: !!a.multiLine,
      maxLen: a.maxLen || 0,
      options: (a.options || []).map(o => (typeof o === 'string' ? o : (o.displayValue ?? o.exportValue ?? ''))),
      optionValues: (a.options || []).map(o => (typeof o === 'string' ? o : (o.exportValue ?? o.displayValue ?? ''))),
      on: a.exportValue ?? a.buttonValue ?? 'Yes',
      was: a.fieldValue,
    });
  }
  return out;
}
const rgbOf = c => {
  if (!c) return null;
  const v = [c[0], c[1], c[2]];
  if (v.some(x => typeof x !== 'number')) return null;
  return `rgb(${v.map(x => Math.round(x <= 1 ? x * 255 : x)).join(',')})`;
};
const daColor = c => rgbOf(c) || '#0b0f14';

const allFields = () => S.pageBox.flatMap(p => p.fields || []);
const hasFields = () => allFields().length > 0;

function seedFieldValues() {
  S.fields0 = {};
  for (const f of allFields()) {
    let v;
    if (f.type === 'text' || f.type === 'choice') v = typeof f.was === 'string' ? f.was : '';
    else if (f.type === 'check') v = f.was != null && f.was !== 'Off' && f.was !== false;
    else v = (typeof f.was === 'string' && f.was !== 'Off') ? f.was : '';
    if (!(f.name in S.fields0)) S.fields0[f.name] = v;
    if (!(f.name in S.fields)) S.fields[f.name] = v;
  }
}
const fieldChanged = name => JSON.stringify(S.fields[name]) !== JSON.stringify(S.fields0[name]);

let formToldOnce = false;
function announceForm() {
  const n = new Set(allFields().map(f => f.name)).size;
  const pages = `${S.pdf.numPages} page${S.pdf.numPages > 1 ? 's' : ''}`;
  $('#docPages').textContent = n
    ? `${pages} · ${n} fillable field${n > 1 ? 's' : ''}`
    : `${pages} · stays on this device`;
  if (formToldOnce) return;
  formToldOnce = true;
  if (HAS_KEYBOARD) toast(n
    ? 'Press Tab to jump through the fields — Enter ticks a box.'
    : 'Press Tab to jump from blank to blank — Enter ticks a box.', 5200);
  else if (n) toast('This form is fillable — tap a highlighted box and type.', 4200);
}
const HAS_KEYBOARD = matchMedia('(hover: hover) and (pointer: fine)').matches;

/* the page background, so an edited field can cover whatever was in it before */
function pageBg(p) {
  if (!p.readyKey) return '#fff';               // nothing painted yet — don't cache black
  if (p.bg && p.bgKey === p.readyKey) return p.bg;
  try {
    /* Sample a few corners and keep the lightest. A single sample lands on
       ink often enough on a busy page, and if the canvas has been blanked it
       reads pure black — which is the last colour you want painted behind a
       form field. */
    const ctx = p.cv.getContext('2d');
    const pts = [[2, 2], [p.cv.width - 3, 2], [2, p.cv.height - 3]];
    let best = null, lum = -1;
    for (const [x, y] of pts) {
      if (x < 0 || y < 0) continue;
      const d = ctx.getImageData(x, y, 1, 1).data;
      const l = d[0] * 299 + d[1] * 587 + d[2] * 114;
      if (l > lum) { lum = l; best = `rgb(${d[0]},${d[1]},${d[2]})`; }
    }
    // essentially black everywhere means a blanked canvas, not a page colour
    p.bg = (best && lum > 24000) ? best : '#fff';
  } catch (_) { p.bg = '#fff'; }
  p.bgKey = p.readyKey;
  return p.bg;
}

function paintFields() {
  S.pageBox.forEach((p, pi) => {
    if (!p.fields?.length) return;
    p.fieldWrap.innerHTML = '';
    p.fields.forEach((f, fi) => {
      let el;
      if (f.type === 'text') {
        el = document.createElement(f.multiline ? 'textarea' : 'input');
        if (!f.multiline) el.type = 'text';
        if (f.maxLen) el.maxLength = f.maxLen;
        el.value = S.fields[f.name] ?? '';
        el.spellcheck = false;
        el.addEventListener('input', () => setField(f, el.value));
        el.addEventListener('focus', () => { markFieldHistory(); select(null); });
      } else if (f.type === 'choice') {
        el = document.createElement('select');
        const blank = document.createElement('option');
        blank.value = ''; blank.textContent = '—';
        el.append(blank);
        f.options.forEach((label, i) => {
          const o = document.createElement('option');
          o.value = f.optionValues[i] ?? label; o.textContent = label;
          el.append(o);
        });
        el.value = S.fields[f.name] ?? '';
        el.addEventListener('change', () => { markFieldHistory(); setField(f, el.value); });
      } else {
        el = document.createElement('button');
        el.type = 'button';
        el.innerHTML = f.type === 'check'
          ? `<svg viewBox="0 0 24 24"><path d="M4.5 12.5 9.5 17.5 20 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
          : `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>`;
        el.addEventListener('click', () => {
          markFieldHistory();
          setField(f, f.type === 'check' ? !S.fields[f.name] : (S.fields[f.name] === f.on ? '' : f.on));
        });
      }
      el.className = 'fld fld-' + f.type;
      el.dataset.name = f.name;
      el.title = f.name;
      // whichever field you land in becomes the place Next carries on from
      el.addEventListener('focus', () => markSpot(pi, `f:${pi}:${fi}`));
      f.el = el;
      p.fieldWrap.append(el);
    });
    reflectFields(p);
  });
  layoutFields();
}

let fieldHistoryPending = false;
function markFieldHistory() {
  if (fieldHistoryPending) return;
  fieldHistoryPending = true;
  push();
  setTimeout(() => (fieldHistoryPending = false), 900);
}

function setField(f, v) {
  S.fields[f.name] = v;
  // several widgets can share one field name — keep them in step
  S.pageBox.forEach(p => (p.fields || []).forEach(g => {
    if (g.name !== f.name || !g.el) return;
    if (g.type === 'text' && g.el.value !== v) g.el.value = v;
    if (g.type === 'choice' && g.el.value !== v) g.el.value = v;
  }));
  S.pageBox.forEach(reflectFields);
  saveSoon();
}

function reflectFields(p) {
  (p.fields || []).forEach(f => {
    if (!f.el) return;
    const v = S.fields[f.name];
    const on = f.type === 'check' ? !!v : f.type === 'radio' ? v === f.on : false;
    f.el.classList.toggle('is-on', on);
    const changed = fieldChanged(f.name);
    f.el.classList.toggle('is-changed', changed);
    f.el.style.setProperty('--fldbg', f.bg || pageBg(p));
  });
}

function layoutFields() {
  S.pageBox.forEach(p => {
    if (!p.fields?.length) return;
    const vp = p.page.getViewport({ scale: 1, rotation: 0 });
    const pxPerPt = p.lw / vp.width;
    const inset = 1.4 * pxPerPt;
    p.fields.forEach(f => {
      if (!f.el) return;
      const r = vp.convertToViewportRectangle(f.rect);
      const x = Math.min(r[0], r[2]), y = Math.min(r[1], r[3]);
      const w = Math.abs(r[2] - r[0]), h = Math.abs(r[3] - r[1]);
      const st = f.el.style;
      st.left = (x * pxPerPt + inset) + 'px';
      st.top = (y * pxPerPt + inset) + 'px';
      st.width = Math.max(6, w * pxPerPt - inset * 2) + 'px';
      st.height = Math.max(6, h * pxPerPt - inset * 2) + 'px';
      if (f.type === 'text' || f.type === 'choice') {
        const size = f.fs ? f.fs * pxPerPt : Math.min(h * 0.62, 16) * pxPerPt;
        st.fontSize = Math.max(5, size) + 'px';
        st.color = f.color;
        st.textAlign = ['left', 'center', 'right'][f.align] || 'left';
        if (!f.multiline) st.lineHeight = Math.max(6, h * pxPerPt - inset * 2) + 'px';
      }
    });
  });
}

function layoutPagesInner() {
  const W = Math.round(S.baseW * S.zoom);
  S.pageBox.forEach(p => {
    const r = totalRot(p);
    const flip = r === 90 || r === 270;
    p.dw = W;
    p.dh = Math.round(W * (flip ? p.uw / p.uh : p.uh / p.uw));
    p.lw = flip ? p.dh : p.dw;
    p.lh = flip ? p.dw : p.dh;
    p.el.style.width = p.dw + 'px';
    p.el.style.height = p.dh + 'px';
    p.layer.style.width = p.lw + 'px';
    p.layer.style.height = p.lh + 'px';
    p.layer.style.transform =
      r === 90 ? `translateX(${p.dw}px) rotate(90deg)` :
      r === 180 ? `translate(${p.dw}px, ${p.dh}px) rotate(180deg)` :
      r === 270 ? `translateY(${p.dh}px) rotate(270deg)` : 'none';
    showCrop(p);
  });
  relayoutItems();
  layoutFields();
}

/* Show a crop the moment it is made, not at the download.

   The page element keeps its full size — every coordinate in the app is a
   fraction of the whole page, and rewriting all of that to mean "a fraction
   of what is left" would be a change with no upside and a great many places
   to get wrong. Instead the box is clipped to the part you kept and pulled
   back by the amount removed, so the layout closes up around it. The border
   box is untouched, which is what getBoundingClientRect reports, so taps,
   hints, item placement and the pixel scan all carry on measuring the page
   they have always measured. Only your eyes are told about it.

   While the crop bar is open the page is shown whole, because you cannot drag
   an edge outwards that you can no longer see. */
function showCrop(p) {
  const c = (cropPi === S.pageBox.indexOf(p)) ? null : cropNow(p);
  if (!c) { p.el.style.clipPath = ''; p.el.style.margin = ''; return; }
  const t = c.y0 * p.dh, b = (1 - c.y1) * p.dh;
  const l = c.x0 * p.dw, r = (1 - c.x1) * p.dw;
  p.el.style.clipPath = `inset(${t}px ${r}px ${b}px ${l}px)`;
  p.el.style.margin = `${-t}px ${-r}px ${-b}px ${-l}px`;
}

function layoutPages() {
  layoutPagesInner();
  layoutHints();          // the blanks are positioned in page pixels too
}

/* Objects are stored in the frame of the page *as it looked when they were
   placed* (their `rot`). That way a mark added to an already-sideways scan is
   upright, and rotating the page afterwards carries its marks around with it. */
const norm4 = r => ((((r || 0) % 360) + 360) % 360);
function unrotXY(rot, x, y) {
  switch (norm4(rot)) {
    case 90: return [y, 1 - x];
    case 180: return [1 - x, 1 - y];
    case 270: return [1 - y, x];
    default: return [x, y];
  }
}
/* page dims (w,h) seen through a rotation */
const localDims = (w, h, rot) => (norm4(rot) % 180 ? [h, w] : [w, h]);
/* screen-space pixel delta -> the object's own axes */
function unspin(deg, dx, dy) {
  const t = norm4(deg) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return [dx * c + dy * s, -dx * s + dy * c];
}
const toUnrot = (p, dx, dy) => unrotXY(totalRot(p), dx, dy);

let renderT;
function renderSoon() { clearTimeout(renderT); renderT = setTimeout(renderVisible, 140); }

/** drop everything we believe about a page's pixels */
function forget(p) {
  p.renderKey = null; p.readyKey = null;
  p.bg = null; p.bgKey = null;          // the sampled page colour came from those pixels
}

/* Android reclaims GPU memory from backgrounded tabs, and a canvas created
   with `alpha: false` reads back as solid black once its backing store is
   gone — which the app would happily treat as a correctly rendered page, and
   then sample that black as the page's background colour. Coming back into
   view, assume nothing and redraw. */
function refreshOnReturn() {
  if (!S.pdf || !S.pageBox.length) return;
  S.pageBox.forEach(forget);
  renderVisible();
}

/* Sometimes the redraw does not stick: the tab comes back, the render throws
   or the backing store is reclaimed a moment after it finished, and the page
   is left blank with your own text and ticks floating on nothing — the
   document you were filling in has apparently vanished, which reads as a
   crash. Nothing detects that from the inside, so look: sample the canvas,
   and if a page that claims to be drawn has no ink on it at all, it is not
   drawn. Retry a couple of times and then leave it alone rather than spin. */
function pageIsBlank(p) {
  if (!p.readyKey || !p.cv.width) return false;
  try {
    const ctx = p.cv.getContext('2d', { willReadFrequently: true });
    const w = Math.min(48, p.cv.width), h = Math.min(64, p.cv.height);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c2 = cv.getContext('2d', { willReadFrequently: true });
    c2.drawImage(p.cv, 0, 0, w, h);
    const d = c2.getImageData(0, 0, w, h).data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo < 8;                      // one flat colour is not a page
  } catch (_) { return false; }
}

let healing = 0;
function healPages() {
  if (!S.pdf || !S.pageBox.length || healing > 2) return;
  const sick = S.pageBox.filter(p => p.el.offsetParent !== null && pageIsBlank(p));
  if (!sick.length) { healing = 0; return; }
  healing++;
  sick.forEach(forget);
  renderVisible().then(() => setTimeout(healPages, 350));
}
const cameBack = () => { healing = 0; refreshOnReturn(); setTimeout(healPages, 400); };
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') cameBack();
});
window.addEventListener('pageshow', cameBack);
window.addEventListener('focus', () => setTimeout(healPages, 400));

async function renderOne(p, dpr) {
  const key = p.dw + ':' + totalRot(p);
  if (p.renderKey === key) {
    if (p.readyKey !== key && p.task) { try { await p.task.promise; p.readyKey = key; } catch (_) {} }
    return;
  }
  try {
    p.task?.cancel();
    const target = Math.round(p.dw * (dpr || clamp(window.devicePixelRatio || 1, 1, 2.5)));
    const vp = p.page.getViewport({ scale: target / (totalRot(p) % 180 ? p.uh : p.uw), rotation: totalRot(p) });
    /* Draw somewhere nobody is looking, then put it up in one move.
       Setting width on a canvas wipes it, so rendering straight into the
       visible one meant every redraw blanked the page first and painted it
       back a moment later — a flash on every return to the app, every rotate,
       every zoom. The page now changes from the old picture to the new one
       with nothing in between. */
    const off = document.createElement('canvas');
    off.width = Math.round(vp.width);
    off.height = Math.round(vp.height);
    p.renderKey = key;
    p.task = p.page.render({ canvasContext: off.getContext('2d', { alpha: false }), viewport: vp });
    await p.task.promise;
    if (p.cv.width !== off.width || p.cv.height !== off.height) {
      p.cv.width = off.width; p.cv.height = off.height;
    }
    p.cv.getContext('2d', { alpha: false }).drawImage(off, 0, 0);
    off.width = off.height = 0;                    // release it straight away
    p.readyKey = key;
    if (p.fields?.length) reflectFields(p);
  } catch (_) { p.renderKey = null; }
}

async function renderVisible() {
  const tok = ++S.renderTok;
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
  const top = stageEl.scrollTop - stageEl.clientHeight;
  const bot = stageEl.scrollTop + stageEl.clientHeight * 2;

  for (const p of S.pageBox) {
    if (tok !== S.renderTok) return;
    const y = p.el.offsetTop;
    if (y + p.dh < top || y > bot) continue;
    await renderOne(p, dpr);
    ensureScan(p).then(hintsSoon);   // the blanks can be drawn once the scan lands
  }
}
stageEl.addEventListener('scroll', renderSoon, { passive: true });

let resizeT, lastFitW = 0;
window.addEventListener('resize', () => {
  if (!S.pdf) return;
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    /* Only a change in *width* means the page needs re-fitting. A keyboard
       opening changes the height and nothing else, and re-fitting on that
       threw away the zoom you had set — you would zoom in to read a line,
       tap it, and the keyboard would appear over a page that had shrunk back
       to fit, with the field you were aiming at now too small to read. */
    const w = fitWidth();
    if (w !== lastFitW) { lastFitW = w; S.baseW = w; layoutPages(); }
    renderVisible();
  }, 180);
});

/* ------------------------------------------------------------ zoom */
function zoomTo(z, mx, my) {
  const z0 = S.zoom;
  S.zoom = clamp(z, 1, 6);
  const f = S.zoom / z0;
  layoutPages();
  stageEl.scrollLeft = (stageEl.scrollLeft + mx) * f - mx;
  stageEl.scrollTop = (stageEl.scrollTop + my) * f - my;
  renderSoon();
}
(() => {
  let d0 = 0, z0 = 1, mid = null, sc0 = null;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  stageEl.addEventListener('touchstart', e => {
    if (e.touches.length !== 2) return;
    d0 = dist(e.touches); z0 = S.zoom;
    const r = stageEl.getBoundingClientRect();
    mid = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left,
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top };
    sc0 = { l: stageEl.scrollLeft, t: stageEl.scrollTop };
  }, { passive: true });

  stageEl.addEventListener('touchmove', e => {
    if (e.touches.length !== 2 || !d0) return;
    e.preventDefault();
    const z = clamp(z0 * clamp(dist(e.touches) / d0, 0.25, 8), 1, 6);
    const f = z / z0;
    S.zoom = z; layoutPages();
    stageEl.scrollLeft = (sc0.l + mid.x) * f - mid.x;
    stageEl.scrollTop = (sc0.t + mid.y) * f - mid.y;
  }, { passive: false });

  stageEl.addEventListener('touchend', e => { if (e.touches.length < 2 && d0) { d0 = 0; renderSoon(); } }, { passive: true });

  stageEl.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = stageEl.getBoundingClientRect();
    zoomTo(S.zoom * (1 - e.deltaY / 400), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  /* Double tap used to zoom here, and that is the gesture a form needs for
     something else: putting a text box where the scan did not offer one. Two
     fingers still zoom, which is how people zoom anyway, and the wheel with
     ctrl held still does it on a desktop. Nothing else was reaching the
     double-tap handler further down while this one had it. */
})();

/* ======================================================= BLANK-LINE SNAPPING
   Most forms mark a blank with either a run of underscores or a drawn rule.
   Rather than guess from the PDF's operators, read the page we already
   rendered: a fill-in line is a long, *thin* band of dark pixels. Text rows
   never qualify — the gaps between glyphs break the run, and a row of type is
   far taller than a rule. Everything here is in the page's own display frame,
   which is exactly the frame objects are placed in. */

/* NOT WIRED IN — kept because the reasoning is worth not repeating.

   What counts as ink ought to depend on the page: software draws pure black
   on pure white, but a scan of the same form has soft grey rules, and a fixed
   cutoff catches those only in patches. Otsu's method looked like the answer.

   It is not, for this kind of document. A form with solid black section
   banners gives Otsu two strong populations — banner and everything else —
   so it splits there and throws away the grey rules entirely. Measured on a
   scanned employment application it took detected table cells from 7 to 1.

   The fix, when it comes, is probably a *local* threshold — a window around
   each candidate rule rather than one number for the page. */
function inkThreshold(d) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    hist[(d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0]++;
    n++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 150, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) { bestVar = v; best = t; }
  }
  // a page with almost no ink gives a meaningless split; keep it sensible
  return clamp(best, 90, 205);
}
/* White tolerated inside one run. Deliberately *not* scaled with the scan:
   tried it, and it made both fixtures worse. A gap in a printed rule is a
   physical flaw of a fixed size, so the tolerance is about the paper, not
   about how closely you look at it. */
const GAP = 5;             // px of white tolerated inside one run

function scanLines(cv) {
  const W = cv.width, H = cv.height;
  let d;
  try { d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data; }
  catch (_) { return { W, H, bands: [], data: null, mask: null }; }

  /* one pass to a 1-byte-per-pixel ink mask — every scan below reads this
     instead of re-deriving luminance, which keeps the box pass cheap */
  /* Ink is either plainly dark, or darker than the paper immediately around
     it. The first half is the old fixed cutoff and catches everything it
     always did; the second half is what finds the soft grey rules of a scan,
     which a single number cannot — too high and text bleeds together, too low
     and the rules vanish in patches and shred into fragments.

     Comparing each pixel to a local mean needs that mean cheaply, so build a
     summed-area table once and read any window from four lookups. Taking the
     union rather than replacing keeps this strictly additive: nothing that
     used to register stops registering. */
  const DARK = 150;                                 // plainly dark, whatever the paper
  const lum = new Uint8Array(W * H);
  for (let i = 0, m = 0; m < lum.length; m++, i += 4) {
    lum[m] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  }
  const sum = new Uint32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x < W; x++) {
      run += lum[y * W + x];
      sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + run;
    }
  }
  const R = clamp(Math.round(W / 40), 8, 40);      // half a window
  const CUT = 18;                                   // how much darker than its paper
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(H - 1, y + R);
    for (let x = 0; x < W; x++) {
      const v = lum[y * W + x];
      if (v < DARK) { mask[y * W + x] = 1; continue; }
      const x0 = Math.max(0, x - R), x1 = Math.min(W - 1, x + R);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const tot = sum[(y1 + 1) * (W + 1) + x1 + 1] - sum[y0 * (W + 1) + x1 + 1]
                - sum[(y1 + 1) * (W + 1) + x0] + sum[y0 * (W + 1) + x0];
      if (v < tot / area - CUT) mask[y * W + x] = 1;
    }
  }

  /* Every qualifying run on the row, not just the longest one. A form row
     like "City ______  State ____  ZIP ______" has three separate rules at
     the same height; keeping only the widest would silently lose the other
     two, which is exactly what makes a short blank feel "not registered". */
  const minLen = Math.max(24 * K, W * 0.045);
  const rows = new Array(H).fill(null);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    let list = null, start = -1, last = -1, gap = 0;
    const close = () => {
      if (start >= 0 && last - start + 1 >= minLen) (list || (list = [])).push({ x0: start, x1: last });
      start = -1; last = -1; gap = 0;
    };
    for (let x = 0; x < W; x++) {
      if (mask[base + x]) { if (start < 0) start = x; last = x; gap = 0; }
      else if (start >= 0 && ++gap > GAP) close();
    }
    close();
    rows[y] = list;
  }

  /* Grow bands downwards, matching each row's runs to the band they overlap.
     Matching on overlap rather than mere adjacency keeps neighbouring rules
     on the same row apart. */
  const maxThick = Math.max(4 * K, Math.round(H * 0.007));
  const raw = [];
  const share = (a, b) => {
    const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
    return ov <= 0 ? 0 : ov / Math.min(a.x1 - a.x0 + 1, b.x1 - b.x0 + 1);
  };
  let open = [];
  for (let y = 0; y <= H; y++) {
    const list = rows[y] || [];
    const taken = new Set();
    const next = [];
    for (const b of open) {
      let pick = -1, bestShare = 0.6;
      for (let i = 0; i < list.length; i++) {
        if (taken.has(i)) continue;
        const v = share(b, list[i]);
        if (v > bestShare) { bestShare = v; pick = i; }
      }
      if (pick < 0) {
        if (b.bot - b.top + 1 <= maxThick) raw.push(b);
        continue;
      }
      taken.add(pick);
      const r = list[pick];
      b.bot = y;
      if (r.x1 - r.x0 > b.x1 - b.x0) { b.x0 = r.x0; b.x1 = r.x1; }
      next.push(b);
    }
    for (let i = 0; i < list.length; i++) {
      if (!taken.has(i)) next.push({ top: y, bot: y, x0: list[i].x0, x1: list[i].x1 });
    }
    open = next;
  }

  /* A row of type can also produce a long run — letters nearly touch. Two
     things separate a real rule from a line of text: a rule is almost solid
     across its whole length, and there is white space directly above and
     below it. Text is neither. */
  const density = (y, x0, x1) => {
    if (y < 0 || y >= H) return 0;
    let c = 0, base = y * W;
    for (let x = x0; x <= x1; x++) if (mask[base + x]) c++;
    return c / (x1 - x0 + 1);
  };
  /* …and a rule you can write on is not hemmed in on both sides. A heavy
     word like "Phone Number:" has a level where the letters nearly join, and
     that row reads as a solid run; the check three pixels out clears it
     because the stems are thin there. What gives it away is that there is
     more of the same word one or two pixels above AND below. A real blank has
     open paper on at least one side. Left in, these phantoms did real damage:
     stitching would then join one to the genuine rule beside it and drag the
     blank's left edge back across the label, so the hint struck through the
     very words naming the field. */
  const bands = raw.filter(b => {
    let solid = 0, core = 0;
    for (let y = b.top; y <= b.bot; y++) {
      const v = density(y, b.x0, b.x1);
      solid = Math.max(solid, v);
      if (v >= 0.55) core++;
    }
    if (solid < 0.80) return false;
    /* White space above and below is what separates a rule from a row of
       type. But *another rule* is not type, and a section banner is drawn as
       two rules six pixels apart — each one saw the other, called it text,
       and both were thrown away, taking every cell on that row with them.
       Nearly-solid across the same width is the tell: text never is. */
    const clear = dir => {
      const at = g => density(dir < 0 ? b.top - Math.round(g * K) : b.bot + Math.round(g * K), b.x0, b.x1);
      if (at(3) < 0.28 && at(5) < 0.28) return true;          // open paper
      for (let g = 2; g <= 7; g++) if (at(g) > 0.90) return true;  // another rule
      return false;
    };
    if (!clear(-1) || !clear(1)) return false;
    /* A rule is thin. A heavy word like "Phone Number:" is not — but across
       its whole x-height the letters nearly join, so every row of it reads as
       a run and the whole word arrives as one eight-pixel "rule" that tops out
       around 0.8 dense. A real rule that thick is drawn solid. Six-plus dense
       rows with gaps still in them is a word, and left in these phantoms did
       real damage: stitching would join one to the genuine rule beside it and
       drag the blank's left edge back across the label, so the hint struck
       through the very words naming the field. */
    return !(core >= 6 * K && solid < 0.92);
  });

  /* Two rules of the same width, joined down both sides, are the edges of a
     drawn rectangle rather than two blanks. That is fine while the rectangle
     is empty — a boxed input is somewhere to write. But if there is already
     something inside it, it is a table cell, and offering to type on its
     border is wrong. Stacked blank lines share an x range too, which is why
     the test insists on the vertical strokes joining them. */
  const joined = (a, b) => {
    const top = Math.min(a.bot, b.bot), bot = Math.max(a.top, b.top);
    if (bot - top < 6 * K) return false;
    const col = cx => {
      let c = 0;
      for (let y = top; y <= bot; y++) {
        const base = y * W;
        if (mask[base + cx] || (cx > 0 && mask[base + cx - 1]) || (cx + 1 < W && mask[base + cx + 1])) c++;
      }
      return c / (bot - top + 1);
    };
    return col(Math.max(a.x0, b.x0)) > 0.75 && col(Math.min(a.x1, b.x1)) > 0.75;
  };
  const written = (a, b) => {
    const pad = Math.round(3 * K);
    const y0 = Math.min(a.bot, b.bot) + pad, y1 = Math.max(a.top, b.top) - pad;
    const x0 = Math.max(a.x0, b.x0) + pad, x1 = Math.min(a.x1, b.x1) - pad;
    if (y1 - y0 < 4 * K || x1 - x0 < 8 * K) return false;
    let ink = 0, tot = 0;
    for (let y = y0; y <= y1; y += 2) {
      const base = y * W;
      for (let x = x0; x <= x1; x += 2) { tot++; if (mask[base + x]) ink++; }
    }
    return tot > 0 && ink / tot > 0.02;
  };
  /* A scan is never perfectly square. A rule that drifts a couple of pixels
     across the page comes back as a row of overlapping fragments — one "Full
     Name:" line arrived as five — because each row's run marches sideways
     faster than the overlap test tolerates. Stitching collinear neighbours
     back together costs little and is the difference between a scanned form
     working and not. */
  /* Two fragments belong to one rule if the ink actually carries on between
     them. Distance alone cannot decide it: a skewed table rule can break with
     an 80px hole, while "City ____  State __" are two real blanks 50px apart.
     So walk the gap along the line the two fragments imply and see whether
     there is something there. */
  const carriesOn = (a, b) => {
    const L = a.x1 <= b.x1 ? a : b, R = L === a ? b : a;
    const gx0 = Math.min(L.x1, R.x1), gx1 = Math.max(L.x0, R.x0);
    if (gx1 <= gx0 + 1) return true;                       // already overlapping
    const ya = (L.top + L.bot) / 2, yb = (R.top + R.bot) / 2;
    const steps = clamp(Math.round((gx1 - gx0) / (5 * K)), 4, 40);
    let hit = 0;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = Math.round(gx0 + (gx1 - gx0) * t);
      const y = Math.round(ya + (yb - ya) * t);
      const rad = Math.round(3 * K);
      for (let dy = -rad; dy <= rad; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < H && mask[yy * W + x]) { hit++; break; }
      }
    }
    return hit >= (steps - 1) * 0.85;
  };
  const stitch = list => {
    const near = Math.max(4 * K, Math.round(H * 0.006));
    const reach = W * 0.35;
    let again = true;
    while (again) {
      again = false;
      list.sort((a, b) => a.top - b.top || a.x0 - b.x0);
      for (let i = 0; i < list.length && !again; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (Math.abs(b.top - a.top) > near) continue;
          const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
          if (gap > reach || !carriesOn(a, b)) continue;
          a.top = Math.min(a.top, b.top); a.bot = Math.max(a.bot, b.bot);
          a.x0 = Math.min(a.x0, b.x0);    a.x1 = Math.max(a.x1, b.x1);
          list.splice(j, 1);
          again = true;
          break;
        }
      }
    }
    return list;
  };

  /* The edge of a scan is a rule too, and never one to write on. */
  const edge = Math.max(2 * K, Math.round(H * 0.012));
  const inner = stitch(bands).filter(b =>
    b.top > edge && b.bot < H - edge && !(b.x1 - b.x0 > W * 0.97));

  const cellEdge = new Set();
  for (let i = 0; i < inner.length; i++) {
    for (let j = i + 1; j < inner.length; j++) {
      const a = inner[i], b = inner[j];
      const gap = Math.abs(b.top - a.top);
      if (gap < 8 * K || gap > H * 0.3) continue;
      if (Math.abs(a.x0 - b.x0) > 3 * K || Math.abs(a.x1 - b.x1) > 3 * K) continue;
      if (!joined(a, b) || !written(a, b)) continue;
      cellEdge.add(a); cellEdge.add(b);
    }
  }

  /* `allBands` is every rule; `bands` is what is left after discarding the
     edges of written-in rectangles. Grid detection needs the former — the
     rejection below is a blunt instrument that, faced with a whole table,
     removes every rule in it and leaves nothing to build cells from. */
  return { W, H, allBands: inner, bands: inner.filter(b => !cellEdge.has(b)), data: d, mask };
}

/** Height of the label sitting just left of a line — used to match font size.
    Walks up from the rule and stops at the first clear gap, so the row above
    (a different field) is never folded into the measurement. */
function inkHeightIn(scan, band, xStart, xEnd, maxSkip) {
  const { W, H, mask } = scan;
  if (!mask || xEnd - xStart < 8) return 0;
  const inked = y => {
    if (y < 0) return false;
    const base = y * W;
    for (let x = xStart; x < xEnd; x++) if (mask[base + x]) return true;
    return false;
  };
  const maxUp = Math.round(H * 0.035);
  let y = band.top - 1, skipped = 0;
  while (y >= 0 && skipped < maxSkip && !inked(y)) { y--; skipped++; }
  if (y < 0 || !inked(y)) return 0;
  const bottom = y;
  let gap = 0;
  while (y >= 0 && bottom - y < maxUp) {
    if (inked(y)) gap = 0;
    else if (++gap >= 3) break;
    y--;
  }
  return bottom - (y + gap) + 1;
}

/** Height of the label belonging to a line. Forms label a blank one of two
    ways — beside it ("Name: ______") or above it — so try beside first and
    fall back to directly above, within the line's own width. */
function inkHeightLeft(scan, band) {
  const { W, H } = scan;
  const beside = inkHeightIn(
    scan, band,
    Math.max(0, band.x0 - Math.round(W * 0.32)),
    Math.max(0, band.x0 - 3),
    Math.round(H * 0.006));
  if (beside) return beside;
  return inkHeightIn(scan, band, band.x0, Math.min(W, band.x1 + 1), Math.round(H * 0.024));
}

/* ---------------------------------------------------------- BOXED INPUTS
   A square small enough to tick is a tick box. A rectangle bigger than that,
   drawn hollow, is somewhere to write — the bordered input a form uses
   instead of a rule, and there is no reason to make anyone place a text box
   inside it by hand when the border already says exactly where the writing
   goes. Same evidence as a tick box: a top edge, a matching bottom edge, the
   two sides joining them, and nothing in the middle. Only the proportions
   differ, so only the proportions are tested. */
function scanPanels(scan) {
  const { W, H, mask } = scan;
  if (!mask) return [];
  // a bordered input is not the width of the whole sheet; that is a row or a frame
  const minW = Math.round(W * 0.035), maxW = Math.round(W * 0.62);
  const minH = Math.round(H * 0.010), maxH = Math.round(H * 0.075);

  const runs = new Array(H).fill(null);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    let list = null, start = -1, gap = 0;
    for (let x = 0; x <= W; x++) {
      if (x < W && mask[base + x]) { start = start < 0 ? x : start; gap = 0; continue; }
      if (start >= 0 && ++gap <= 3 && x < W) continue;      // a border can have specks
      if (start >= 0) {
        const len = x - gap - start;
        if (len >= minW && len <= maxW) (list || (list = [])).push(start, x - gap - 1);
        start = -1; gap = 0;
      }
    }
    runs[y] = list;
  }

  const dens = (y, x0, x1) => {
    if (y < 0 || y >= H) return 0;
    let c = 0, base = y * W;
    for (let x = x0; x <= x1; x++) if (mask[base + x]) c++;
    return c / (x1 - x0 + 1);
  };
  const side = (x, y0, y1) => {
    let c = 0;
    for (let y = y0; y <= y1; y++) {
      const b = y * W;
      if (mask[b + x] || (x > 0 && mask[b + x - 1]) || (x + 1 < W && mask[b + x + 1])) c++;
    }
    return c / (y1 - y0 + 1);
  };

  const out = [], used = [];
  for (let y = 0; y < H; y++) {
    const list = runs[y];
    if (!list) continue;
    for (let k = 0; k < list.length; k += 2) {
      const x0 = list[k], x1 = list[k + 1];
      if (dens(y, x0, x1) < 0.9) continue;                  // the top must be drawn
      let y1 = -1;
      for (let dy = minH; dy <= maxH && y + dy < H; dy++) {
        const bl = runs[y + dy];
        if (!bl) continue;
        for (let j = 0; j < bl.length; j += 2) {
          if (Math.abs(bl[j] - x0) <= 3 && Math.abs(bl[j + 1] - x1) <= 3 &&
              dens(y + dy, x0, x1) > 0.9) { y1 = y + dy; break; }
        }
        if (y1 > 0) break;
      }
      if (y1 < 0) continue;
      if (side(x0, y, y1) < 0.85 || side(x1, y, y1) < 0.85) continue;   // both uprights

      // hollow: whatever is already written in it is not an empty field
      const iy0 = y + 3, iy1 = y1 - 3, ix0 = x0 + 3, ix1 = x1 - 3;
      if (iy1 - iy0 < 3 || ix1 - ix0 < 6) continue;
      let ink = 0, tot = 0;
      for (let yy = iy0; yy <= iy1; yy++) {
        const b = yy * W;
        for (let xx = ix0; xx <= ix1; xx += 2) { tot++; if (mask[b + xx]) ink++; }
      }
      if (!tot || ink / tot > 0.02) continue;
      // one rectangle, not the same one found again a pixel lower
      if (used.some(u => Math.abs(u.y - y) < 6 && Math.abs(u.x - x0) < 6)) continue;
      used.push({ y, x: x0 });
      out.push({
        x0: x0 / W, x1: x1 / W, y0: y / H, y1: (y1 + 1) / H,
        cx: (x0 + x1) / 2 / W, cy: (y + y1) / 2 / H,
        w: (x1 - x0) / W, h: (y1 - y) / H, panel: 1,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------- CHECKBOX SPOTTING
   A tick box is the one shape on a form that is unmistakable from pixels
   alone: a small, near-square outline with nothing inside it. Look for a
   short horizontal run, a matching run a plausible distance below, solid
   sides joining them, and a clear middle. Anything already ticked fails the
   clear-middle test, which is exactly what we want — we only offer to fill
   boxes that are still empty. */
function scanBoxes(scan) {
  const { W, H, mask } = scan;
  if (!mask) return [];

  const minS = Math.max(5 * K, Math.round(H * 0.0075));
  const maxS = Math.max(minS + 4, Math.round(H * 0.030));

  // short horizontal runs, per row — candidate top and bottom edges
  const runs = new Array(H).fill(null);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    let list = null, start = -1;
    for (let x = 0; x <= W; x++) {
      if (x < W && mask[base + x]) { if (start < 0) start = x; continue; }
      if (start >= 0) {
        const len = x - start;
        if (len >= minS && len <= maxS) (list || (list = [])).push(start, x - 1);
        start = -1;
      }
    }
    runs[y] = list;
  }

  const out = [], taken = [];
  for (let y = 0; y < H; y++) {
    const list = runs[y];
    if (!list) continue;
    for (let k = 0; k < list.length; k += 2) {
      const x0 = list[k], x1 = list[k + 1], L = x1 - x0 + 1;

      // a bottom edge roughly one box-width below, at the same x range
      let y1 = -1;
      const lo = Math.max(2, Math.round(L * 0.62)), hi = Math.round(L * 1.62);
      for (let dy = lo; dy <= hi && y + dy < H; dy++) {
        const bl = runs[y + dy];
        if (!bl) continue;
        for (let j = 0; j < bl.length; j += 2) {
          if (Math.abs(bl[j] - x0) <= 2 && Math.abs(bl[j + 1] - x1) <= 2) { y1 = y + dy; break; }
        }
        if (y1 > 0) break;
      }
      if (y1 < 0) continue;

      // already covered by a box we accepted (thick borders repeat per row)
      if (taken.some(t => Math.abs(t.x - x0) <= 3 && Math.abs(t.y - y) <= Math.max(3, L * 0.5))) continue;

      /* Round letters are hollow too. A bold lowercase "o" has a long run
         across the top of the bowl, a matching one across the bottom, solid
         sides and a clear middle — it passes every test above. What it does
         not have is a *thin* border: two rows into an "o" you are still in
         the stroke, whereas two rows into a drawn box there is nothing but
         the two sides. That is the test that separates them. */
      const row = (yy) => {
        if (yy < 0 || yy >= H) return 1;
        let c = 0;
        const b = yy * W;
        for (let xx = x0; xx <= x1; xx++) if (mask[b + xx]) c++;
        return c / L;
      };
      if (row(y + 2) > 0.40 || row(y1 - 2) > 0.40) continue;

      const Hh = y1 - y + 1;
      const side = cx => {
        let c = 0;
        for (let yy = y; yy <= y1; yy++) {
          const b = yy * W;
          if (mask[b + cx] || (cx > 0 && mask[b + cx - 1]) || (cx + 1 < W && mask[b + cx + 1])) c++;
        }
        return c / Hh;
      };
      if (side(x0) < 0.78 || side(x1) < 0.78) continue;

      const ix0 = x0 + 2, ix1 = x1 - 2, iy0 = y + 2, iy1 = y1 - 2;
      if (ix1 - ix0 < 1 || iy1 - iy0 < 1) continue;
      let ink = 0;
      for (let yy = iy0; yy <= iy1; yy++) {
        const b = yy * W;
        for (let xx = ix0; xx <= ix1; xx++) if (mask[b + xx]) ink++;
      }
      if (ink / ((ix1 - ix0 + 1) * (iy1 - iy0 + 1)) > 0.12) continue;   // already ticked / not hollow

      taken.push({ x: x0, y });
      out.push({
        x0: x0 / W, y0: y / H, x1: (x1 + 1) / W, y1: (y1 + 1) / H,
        cx: (x0 + x1 + 1) / 2 / W, cy: (y + y1 + 1) / 2 / H,
        w: L / W, h: Hh / H,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------ TABLE CELLS
   A ruled table is the one place on a form where the blank is a box rather
   than a line, and where the answer belongs in the middle of it rather than
   sitting on a rule. Finding them needs the vertical rules the line scan
   ignores: with both sets, a cell is the gap between two neighbouring
   uprights, closed off by two of the horizontals that span it. */

function scanVRules(scan) {
  const { W, H, mask } = scan;
  if (!mask) return [];
  const minLen = Math.max(14 * K, Math.round(H * 0.014));
  const maxThick = Math.max(4 * K, Math.round(W * 0.006));

  const cols = new Array(W).fill(null);
  for (let x = 0; x < W; x++) {
    let list = null, start = -1, last = -1, gap = 0;
    const close = () => {
      if (start >= 0 && last - start + 1 >= minLen) (list || (list = [])).push({ y0: start, y1: last });
      start = -1; last = -1; gap = 0;
    };
    for (let y = 0; y < H; y++) {
      if (mask[y * W + x]) { if (start < 0) start = y; last = y; gap = 0; }
      else if (start >= 0 && ++gap > GAP) close();
    }
    close();
    cols[x] = list;
  }

  const share = (a, b) => {
    const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
    return ov <= 0 ? 0 : ov / Math.min(a.y1 - a.y0 + 1, b.y1 - b.y0 + 1);
  };
  const raw = [];
  let open = [];
  for (let x = 0; x <= W; x++) {
    const list = cols[x] || [];
    const taken = new Set();
    const next = [];
    for (const b of open) {
      let pick = -1, best = 0.6;
      for (let i = 0; i < list.length; i++) {
        if (taken.has(i)) continue;
        const v = share(b, list[i]);
        if (v > best) { best = v; pick = i; }
      }
      if (pick < 0) { if (b.x1 - b.x0 + 1 <= maxThick) raw.push(b); continue; }
      taken.add(pick);
      const r = list[pick];
      b.x1 = x;
      if (r.y1 - r.y0 > b.y1 - b.y0) { b.y0 = r.y0; b.y1 = r.y1; }
      next.push(b);
    }
    for (let i = 0; i < list.length; i++) {
      if (!taken.has(i)) next.push({ x0: x, x1: x, y0: list[i].y0, y1: list[i].y1 });
    }
    open = next;
  }

  // a stroke of type is crowded; a rule is thin and alone
  const dens = (x, y0, y1) => {
    if (x < 0 || x >= W) return 0;
    let c = 0;
    for (let y = y0; y <= y1; y++) if (mask[y * W + x]) c++;
    return c / (y1 - y0 + 1);
  };
  const edge = Math.max(2 * K, Math.round(W * 0.012));
  const kept = raw.filter(b => {
    if (b.x0 < edge || b.x1 > W - edge) return false;
    let solid = 0;
    for (let x = b.x0; x <= b.x1; x++) solid = Math.max(solid, dens(x, b.y0, b.y1));
    if (solid < 0.80) return false;
    const q3 = Math.round(3 * K), q5 = Math.round(5 * K);
    const l = Math.max(dens(b.x0 - q3, b.y0, b.y1), dens(b.x0 - q5, b.y0, b.y1));
    const r = Math.max(dens(b.x1 + q3, b.y0, b.y1), dens(b.x1 + q5, b.y0, b.y1));
    return l < 0.28 && r < 0.28;
  });

  // a skewed scan splits an upright too
  const near = Math.max(3 * K, Math.round(W * 0.004));
  let again = true;
  while (again) {
    again = false;
    kept.sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);
    for (let i = 0; i < kept.length && !again; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        const a = kept[i], b = kept[j];
        if (Math.abs(b.x0 - a.x0) > near) continue;
        if (Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) > Math.max(6 * K, H * 0.012)) continue;
        a.x0 = Math.min(a.x0, b.x0); a.x1 = Math.max(a.x1, b.x1);
        a.y0 = Math.min(a.y0, b.y0); a.y1 = Math.max(a.y1, b.y1);
        kept.splice(j, 1); again = true; break;
      }
    }
  }
  return kept;
}

/** the boxes of a ruled grid, and which horizontals were spent building them */
function findCells(hs, vs, W, H, mask) {
  const cells = [], usedH = new Set();
  /* A form's outer border is the one upright most likely to be missing: it
     runs the whole page, so any fold, shadow or soft edge in a scan breaks it
     into pieces too short to register. Losing it costs the leftmost cell of
     every single row — Last, Height, City, Contact Name, the entire first
     column. But the rules crossing it all start and stop at the same place,
     and enough of them agreeing is better evidence of an edge than one faint
     column of pixels. So take the border the rows imply. */
  const wideH = hs.filter(h => h.x1 - h.x0 > W * 0.5);
  const implied = [];
  /* Only on a page that is plainly a grid, and only where the border is
     actually absent. Guessing an edge on a page of plain blank lines turns
     the blanks into cell borders and the form stops working; patching the
     gaps in an upright that is merely broken cannot. */
  if (wideH.length >= 4 && vs.length >= 6) {
    for (const side of ['x0', 'x1']) {
      /* Where most of them end — the count that agrees, not the middle of the
         list. A median is pulled about by the rules that are themselves
         broken, and a border guessed a fifth of the way across the page is
         worse than no guess at all. */
      const at = wideH.map(h => h[side]).sort((a, b) => a - b);
      let x = -1, most = 3;                                // fewer than 4 is not evidence
      for (const c of at) {
        const n = at.filter(v => Math.abs(v - c) <= 6).length;
        if (n > most) { most = n; x = c; }
      }
      if (x < 0) continue;
      const have = vs.filter(v => Math.abs(v.x0 - x) <= 8).sort((a, b) => a.y0 - b.y0);
      let y = 0;
      for (const v of have.concat([{ y0: H, y1: H }])) {
        if (v.y0 - y > H * 0.02) implied.push({ x0: x, x1: x, y0: y, y1: v.y0 - 1, implied: true });
        y = Math.max(y, v.y1 + 1);
      }
    }
  }
  const V = [...vs, ...implied].sort((a, b) => a.x0 - b.x0);
  const Hh = [...hs].sort((a, b) => a.top - b.top);
  const minW = W * 0.025, minH = H * 0.012;

  for (let i = 0; i < V.length; i++) {
    for (let j = i + 1; j < V.length; j++) {
      const L = V[i], R = V[j];
      const x0 = L.x1 + 1, x1 = R.x0 - 1;
      if (x1 - x0 < minW) continue;
      const vy0 = Math.max(L.y0, R.y0), vy1 = Math.min(L.y1, R.y1);
      if (vy1 - vy0 < minH) continue;

      /* An upright standing between these two means they are not neighbours —
         but only across the rows it actually crosses. Judged over the whole
         height of the pair, a divider one row tall never reaches the
         threshold, and the page's two outer borders pair up into a single
         cell swallowing everything between them. So ask the question of each
         candidate cell instead. */
      const between = [];
      for (let k = i + 1; k < j; k++) {
        const M = V[k];
        if (M.x0 > x0 && M.x1 < x1) between.push(M);
      }
      const split = (top, bot) => between.some(M =>
        Math.min(M.y1, bot) - Math.max(M.y0, top) >
        Math.min(bot - top, M.y1 - M.y0) * 0.5);

            /* How closely a rule has to reach the uprights to be counted as this
         cell's lid. Five pixels is right for a drawn table and too strict for
         a scan, where a rule fades out before it meets the border — miss by a
         hair and the whole row of cells vanishes. */
      const reach = Math.max(5 * K, Math.round(W * 0.015));
      const spans = Hh.filter(h =>
        h.x0 <= x0 + reach && h.x1 >= x1 - reach && h.bot >= vy0 - 5 && h.top <= vy1 + 5);
      for (let a = 0; a + 1 < spans.length; a++) {
        const T = spans[a], B = spans[a + 1];
        if (B.top - T.bot < minH) continue;
        if (split(T.bot, B.top)) continue;
        usedH.add(T); usedH.add(B);
        /* Where the ink sits inside the box matters more than whether there
           is any. A government form prints the caption *inside* the cell, at
           the top, and leaves the room below it for the answer — "Last",
           "City", "ZIP", "Eye Color" are all drawn that way. Treating any
           inked cell as already filled threw that entire pattern away: on a
           DMV application it discarded better than thirty real fields and
           left the form looking almost empty. So read the rows: a caption up
           top with clear paper under it is a labelled box, and the answer
           belongs in the clear part. */
        const iy0 = T.bot + 3, iy1 = B.top - 3, ix0 = x0 + 3, ix1 = x1 - 3;
        const wide = ix1 - ix0 + 1;
        const tall = iy1 - iy0;
        const inked = [];
        for (let y = iy0; y <= iy1; y++) {
          let c = 0;
          const base = y * W;
          for (let x = ix0; x <= ix1; x++) if (mask[base + x]) c++;
          /* An absolute floor as well as a fraction: a scan leaves a couple of
             stray dark pixels on most rows, and a pure percentage reads those
             as writing and calls every wide cell already full. */
          inked.push(c >= Math.max(4 * K, wide * 0.02));
        }
        /* The caption is the first band of ink, allowing for the gap between
           a word's body and its descenders. What matters after it is the
           clear run — that is the paper left for the answer. Whether there is
           anything *further* down does not decide it: "Height ___ ft ___ in"
           has rules near the bottom and is still a captioned box. Insisting
           the whole cell below the caption be clear marked every one of those
           as filled. */
        let capA = inked.indexOf(true), capB = -1, gapEnd = 0;
        if (capA >= 0) {
          capB = capA;
          for (let i = capA + 1, hole = 0; i < inked.length; i++) {
            if (inked[i]) { capB = i; hole = 0; }
            else if (++hole > 2) break;
          }
          gapEnd = capB + 1;
          while (gapEnd < inked.length && !inked[gapEnd]) gapEnd++;
        }
        const capped = capA >= 0 && capA < tall * 0.4 &&
                       gapEnd - capB - 1 >= Math.max(9 * K, H * 0.011);
        const wy0 = capped ? iy0 + capB + 2 : T.bot;         // where you write
        cells.push({
          x0: x0 / W, x1: x1 / W, y0: wy0 / H, y1: B.top / H,
          cx: (x0 + x1) / 2 / W, cy: (wy0 + B.top) / 2 / H,
          w: (x1 - x0) / W, h: (B.top - wy0) / H,
          box: { x0: x0 / W, x1: x1 / W, y0: T.bot / H, y1: B.top / H },
          cap: capped
            ? { x0: x0 / W, x1: x1 / W, y0: (iy0 + capA - 2) / H, y1: (iy0 + capB + 2) / H }
            : null,
          // something further down the box: rules to fill, or an answer already there
          body: capped && gapEnd < inked.length,
          filled: capA >= 0 && !capped,
        });
      }
      /* Don't stop here. "Nearest neighbour" is not a property of an upright,
         it is a property of an upright *on a given row*: the form's left
         border neighbours a different divider in every band it passes
         through. Breaking after the first match paired the border with one
         row and lost the leftmost cell of every other — Last, Height, City,
         Contact Name, the whole first column of a DMV form. The blocked test
         above already refuses a pair with an upright standing between them,
         which is the thing the break was reaching for. */
    }
  }
  return { cells, usedH, uprights: V };
}

/* Scanning runs on its own small render rather than the on-screen canvas, so
   the answer is the same whether you are zoomed out on a phone or zoomed
   right in on a desktop — and a 6× zoom never means scanning a 12000px
   bitmap. The canvas is thrown away immediately; only the measurements are
   kept, in memory, in this tab. */
const EMPTY_SCAN = { lines: [], boxes: [], cells: [] };
/* The scan used to run at a fixed 1000px wide whatever the page was, which
   quietly downsampled anything bigger. A form that arrives as a photograph is
   a bitmap of 1200-2000px, and a table rule in it is a hairline one or two
   pixels across — resample that down and it becomes a grey smudge that no
   longer reads as solid, so the upright it belonged to disappears and every
   cell in that column goes with it. Because each row is judged on its own the
   losses come out ragged: a box on the third row and nothing on the first two.

   So scan at the page's own resolution, up to a ceiling. Every constant below
   that counts pixels is multiplied by K, or raising the width would just move
   the problem: at 1600px a "thin" rule of four pixels is no longer thin. */
const SCAN_W_BASE = 1000;
const SCAN_W_MAX = 1700;
let SCAN_W = SCAN_W_BASE;
let K = 1;
const scanKeyOf = p => 'r' + totalRot(p);

function pageScan(p) {
  return (p.scanKey === scanKeyOf(p) && p.scanned) || EMPTY_SCAN;
}
const pageLines = p => pageScan(p).lines;
const pageBoxes = p => pageScan(p).boxes;
const pageCells = p => pageScan(p).cells;

/** the resolution the page actually carries, from the biggest image on it */
async function nativeWidth(p) {
  try {
    const ops = await p.page.getOperatorList();
    let best = 0;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const a = ops.argsArray[i];
      if (!a) continue;
      for (const v of a) {
        if (v && typeof v === 'object' && typeof v.width === 'number' && typeof v.height === 'number') {
          best = Math.max(best, v.width);
        }
      }
    }
    return best;
  } catch (_) { return 0; }
}

/* A table is a rectangle. If a column is proved on some rows of a table and
   not others, the gap is a faint rule, not a missing cell — no form has a
   column that stops halfway down. That is what made the losses look arbitrary:
   the outermost column of a table is bounded by the sheet's own border, the
   rule most likely to fade, so "Degree or Diploma" appeared on the third row
   and nowhere else. Finding the rows and the columns separately and then
   insisting the grid is complete is far steadier than hoping every rule
   survives, and it costs nothing when they all do. Anything that already has
   writing in it is left alone. */
function completeGrid(cells, scan, boxy) {
  const near = (a, b, t) => Math.abs(a - b) < t;
  const add = [];
  /* One table at a time. Two tables on a page have similar row heights, so
     proximity has to decide it: rows of one grid sit within about a row of
     each other and their columns overlap. Merge two tables and each inherits
     the other's columns. */
  const seen = [];
  const uniq = cells.filter(c => {
    if (seen.some(o => near(o.cx, c.cx, 0.012) && near(o.cy, c.cy, 0.008))) return false;
    seen.push(c); return true;
  });
  const groups = [];
  for (const c of uniq) {
    const g = groups.find(g => near(g.h, c.h, 0.010) &&
      g.rows.some(r => Math.abs(r.cy - c.cy) < Math.max(0.028, c.h * 2.2)));
    if (g) { g.rows.push(c); g.h = (g.h + c.h) / 2; } else groups.push({ h: c.h, rows: [c] });
  }
  for (const g of groups) {
    const rows = [], cols = [];
    for (const c of g.rows) {
      let r = rows.find(r => near(r.cy, c.cy, c.h * 0.6));
      if (!r) rows.push(r = { cy: c.cy, y0: c.y0, y1: c.y1, at: [] });
      r.at.push(c);
      let k = cols.find(k => near(k.cx, c.cx, Math.max(0.02, c.w * 0.45)));
      if (!k) cols.push(k = { cx: c.cx, x0: c.x0, x1: c.x1, n: 0 });
      k.n++;
    }
    if (rows.length < 2 || cols.length < 2) continue;
    for (const r of rows) {
      /* Only finish a row that is plainly part of the grid. A "Yes / No" pair
         under an availability chart shares its rows and none of its columns,
         and completing it scatters phantom boxes across the days. A row that
         already holds half the columns is in the grid; two boxes out of eight
         are not. */
      if (r.at.length < cols.length * 0.5) continue;
      for (const k of cols) {
        /* One sighting is enough. The outermost column of a table is bounded
           by the sheet's own border and is exactly the one that survives on a
           single row — insisting on two proofs threw away the column this was
           written to rescue. The blank-paper test below is what keeps a stray
           cell from inventing one. */
        if (r.at.some(c => near(c.cx, k.cx, Math.max(0.02, (k.x1 - k.x0) * 0.45)))) continue;
        /* Only where the paper is actually blank — but a tick box is *drawn*,
           so for those look inside the outline rather than at the square as a
           whole, or every empty box reads as full of ink and nothing is ever
           completed. */
        const px = (v, n) => Math.round(v * n);
        const in8 = boxy ? 0.22 : 0;
        const iy = (r.y1 - r.y0) * in8, ix = (k.x1 - k.x0) * in8;
        let ink = 0, tot = 0;
        for (let y = px(r.y0 + iy, scan.H) + 2; y < px(r.y1 - iy, scan.H) - 1; y += 2) {
          const base = y * scan.W;
          for (let x = px(k.x0 + ix, scan.W) + 2; x < px(k.x1 - ix, scan.W) - 1; x += 2) {
            tot++; if (scan.mask[base + x]) ink++;
          }
        }
        if (!tot || ink / tot > (boxy ? 0.5 : 0.02)) continue;
        if (add.some(o => near(o.cx, k.cx, 0.012) && near(o.cy, r.cy, 0.008))) continue;
        add.push({ x0: k.x0, x1: k.x1, y0: r.y0, y1: r.y1,
                   cx: (k.x0 + k.x1) / 2, cy: (r.y0 + r.y1) / 2,
                   w: k.x1 - k.x0, h: r.y1 - r.y0, filled: false, guessed: 1 });
        if (boxy) add[add.length - 1].w = k.x1 - k.x0;
      }
    }
  }
  return add;
}

/** the same page at a closer look, for cells the first pass could not prove */
async function secondLook(p, have) {
  if (K !== 1) return [];
  const cv = document.createElement('canvas');
  const was = SCAN_W, wasK = K;
  try {
    SCAN_W = SCAN_W_MAX; K = SCAN_W / SCAN_W_BASE;
    const v0 = p.page.getViewport({ scale: 1, rotation: totalRot(p) });
    const vp = p.page.getViewport({ scale: SCAN_W / v0.width, rotation: totalRot(p) });
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    await p.page.render({
      canvasContext: cv.getContext('2d', { alpha: false, willReadFrequently: true }),
      viewport: vp,
    }).promise;
    const scan = scanLines(cv);
    const { cells } = findCells(scan.allBands, scanVRules(scan), scan.W, scan.H, scan.mask);
    // only what the first pass missed, judged by where it sits on the page
    return cells.filter(c => !c.filled &&
      !have.some(h => Math.abs(h.cx - c.cx) < 0.02 && Math.abs(h.cy - c.cy) < 0.012));
  } catch (_) { return []; }
  finally { SCAN_W = was; K = wasK; cv.width = cv.height = 0; }
}

function ensureScan(p) {
  const key = scanKeyOf(p);
  if (p.scanKey === key) return Promise.resolve(p.scanned);
  if (p.scanPending === key) return p.scanJob;
  p.scanPending = key;
  p.scanJob = (async () => {
    const cv = document.createElement('canvas');
    try {
      try { await p.task?.promise; } catch (_) {}      // don't render a page twice at once
      const v0 = p.page.getViewport({ scale: 1, rotation: totalRot(p) });
      SCAN_W = SCAN_W_BASE;
      K = 1;
      const vp = p.page.getViewport({ scale: SCAN_W / v0.width, rotation: totalRot(p) });
      cv.width = Math.round(vp.width);
      cv.height = Math.round(vp.height);
      await p.page.render({
        canvasContext: cv.getContext('2d', { alpha: false, willReadFrequently: true }),
        viewport: vp,
      }).promise;
      const scan = scanLines(cv);
      /* Rules spent on a table are not blanks to write on — the cells they
         bound are. Work those out first, then keep only the leftovers. */
      const vs = scanVRules(scan);
      const { cells, usedH, uprights } = findCells(scan.allBands, vs, scan.W, scan.H, scan.mask);

      /* Look again, closer, and keep whatever the second look adds.
         A hairline rule survives one resolution and not another: at 1000px a
         rule in a photographed form blurs into a smudge too soft to register,
         and at 1700px a rule in a crisp one falls between the tests instead.
         Neither width wins everywhere — on two versions of the same page one
         width found 27 cells and 18, the other 22 and 27. Picking a side is
         choosing which documents to be bad at. So do both and take the union:
         a cell either width can prove is a cell, and a column that only shows
         up under closer inspection is still a column. One extra scan per page,
         once; lines and tick boxes stay with the width they were tuned at. */
      cells.push(...await secondLook(p, cells));
      cells.push(...completeGrid(cells, scan));
      /* A rule with an upright standing at each end is a border — the side of
         a box, the line between two rows of a grid. It is drawn to divide the
         page, not to be written on, and offering it as a blank puts a text
         box across the middle of somebody's table. The rules a person fills
         in are open at least at one end. */
      const bounded = b => {
        const at = x => uprights.some(v =>
          Math.abs(v.x0 - x) <= 6 && v.y0 <= b.top + 4 && v.y1 >= b.bot - 4);
        return b.x1 - b.x0 > scan.W * 0.35 && at(b.x0) && at(b.x1);
      };
      const free = scan.bands.filter(b => !usedH.has(b) && !bounded(b));
      /* How much empty room sits above a rule. It matters because on a dense
         form the next thing up is often a section banner or a caption, and a
         writing box drawn blindly upwards lands squarely on that heading's own
         words — which is exactly what made a gridded form look scribbled on.
         Measuring the gap lets both the box and the text stop just short of it.
         Throwing the rule away instead was tried and was worse: "Full Name" on
         a scanned application sits directly under a solid black banner, and a
         rule is not disqualified from being a blank by what happens to be
         printed above it. */
      const clearAbove = b => {
        const CAP = Math.round(scan.H * 0.05);          // no need to look far
        const w = b.x1 - b.x0;
        /* Ignore a sliver at each end: a blank that starts right after a "$"
           or a bracket would otherwise report no room at all and get 5pt text. */
        const lo = b.x0 + Math.round(w * 0.05), hi = b.x1 - Math.round(w * 0.02);
        const need = Math.max(3 * K, Math.round(w * 0.05));
        const stop = Math.max(0, b.top - CAP);
        let y = b.top - 2;
        for (; y > stop; y--) {
          let ink = 0;
          const base = y * scan.W;
          for (let x = lo; x <= hi; x++) if (scan.mask[base + x] && ++ink >= need) break;
          if (ink >= need) break;
        }
        return (b.top - y) / scan.H;
      };
      /* The underside of a solid section banner is a long, thin, perfectly
         solid rule and passes every test a blank has to pass — but there is
         nowhere to write on it, because the banner is pressed right up
         against it. Room above is what makes a rule a blank. */
      /* One rule, several fields. A form writes "Full Name" once and then
         labels the thirds of the line underneath — Last, First, Middle — and
         treating that as a single blank means one text box stretching across
         all three and no way to tab between them. The captions below say
         where the divisions are: cluster them, and cut the rule at the gaps
         between. Only where the evidence is plain — a handful of short
         captions with clear air between them, not a sentence. */
      const subDivide = b => {
        // only the caption directly under the rule; any further and the strip
        // reaches the next row of the form and cuts on its labels instead
        const top = b.bot + 2, bot = Math.min(scan.H - 1, b.bot + Math.round(scan.H * 0.012));
        if (bot - top < 4) return null;
        /* Look a little to the left of where the rule starts. The first
           caption of a split line sits under the field's *label* — "Last"
           lives under "Full Name:", outside the rule itself — so a strip that
           begins where the rule begins never sees it, finds two captions
           instead of three, and hands you one box covering Last and First. */
        const W = scan.W;
        const lead = Math.round((b.x1 - b.x0) * 0.18);
        const from = Math.max(0, b.x0 - lead);
        const wide = b.x1 - from;
        const col = new Uint8Array(wide + 1);
        for (let y = top; y <= bot; y++) {
          const base = y * W;
          for (let x = from; x <= b.x1; x++) if (scan.mask[base + x]) col[x - from] = 1;
        }
        const need = Math.max(6 * K, Math.round(wide * 0.02));  // air between captions
        const runs = [];
        let s0 = -1, gap = 0;
        for (let i = 0; i <= wide; i++) {
          if (i <= wide && col[i]) { if (s0 < 0) s0 = i; gap = 0; continue; }
          if (s0 >= 0 && ++gap <= need && i < wide) continue;
          if (s0 >= 0) { runs.push([s0, i - gap]); s0 = -1; gap = 0; }
        }
        if (runs.length < 2 || runs.length > 5) return null;
        if (runs.some(r => (r[1] - r[0]) > wide * 0.35)) return null;   // a sentence
        /* Cut at the *left edge of each caption*, not halfway between them.
           A caption sits under the start of the thing it names, so this is
           where that section begins — tab into "First" and the cursor lands
           directly above the word First, which is where a person writing on
           paper would start. Halfway between two captions is nowhere in
           particular, and the writing then starts adrift of its own label. */
        const cuts = [];
        // a caption left of the rule confirms the first section; it cannot cut it
        for (let i = 1; i < runs.length; i++) {
          const at = from + runs[i][0];
          if (at > b.x0 + scan.W * 0.03) cuts.push(at);
        }
        if (!cuts.length) return null;
        const edges = [b.x0, ...cuts.map(Math.round), b.x1];
        const parts = [];
        for (let i = 0; i + 1 < edges.length; i++) {
          if (edges[i + 1] - edges[i] < scan.W * 0.05) return null;     // too thin to be a field
          parts.push({ ...b, x0: edges[i], x1: edges[i + 1] - 2 });
        }
        return parts;
      };
      const free2 = [];
      for (const b of free) {
        const parts = b.x1 - b.x0 > scan.W * 0.28 ? subDivide(b) : null;
        if (parts) free2.push(...parts); else free2.push(b);
      }
      const lines = free2.filter(b => clearAbove(b) * scan.H >= 8 * K).map(b => {
        /* Match the label if we found one, within the range a person actually
           writes in — see TEXT_PT. With no label to measure, the middle of
           that range beats the bottom of the clamp: that is what used to make
           an unlabelled blank get 6pt text.

           The clearance check still has the last word downwards. A tight row
           may need writing smaller than anyone would choose, and that is
           better than writing that collides with the line above it. */
        const ink = inkHeightLeft(scan, b);
        const clr = clearAbove(b);
        /* inkHeightIn walks from the lowest inked row of the caption up to
           the top of its ink, so what comes back is the whole span from
           descender to ascender — very nearly the em box, not the cap height.
           Dividing by 0.72 as though it were cap height inflated every
           estimate by about a third, which is why almost every blank on every
           fixture came out pinned to the ceiling instead of matched to its
           label. Against 0.95 they spread out across the range the way they
           were always meant to. */
        const want = fsFit(p, ink ? (ink / 0.95) / scan.H : 0);
        return {
          y: b.top / scan.H,                     // where a baseline should sit
          x0: b.x0 / scan.W,
          x1: b.x1 / scan.W,
          fs: Math.max(0.0085, Math.min(want, clr / 0.95)),
          clr,
          hasLabel: ink > 0,
        };
      });
      const boxes = scanBoxes(scan);
      /* A column of tick boxes is a grid exactly as a table is, and it fails
         the same way: one faint square in an availability chart and that one
         day cannot be ticked. Same rule, same evidence. */
      boxes.push(...completeGrid(boxes, scan, true));
      /* Bordered inputs join the table cells: both are a rectangle you write
         inside, and everything downstream already knows how to fill one. Drop
         any that a cell or a tick box has already claimed. */
      const holds = (q, x, y) => x > q.x0 + 0.004 && x < q.x1 - 0.004 &&
                                 y > q.y0 + 0.002 && y < q.y1 - 0.002;
      const panels = scanPanels(scan).filter(q => {
        // the same rectangle something else already offers
        if (boxes.some(B => Math.abs(B.cx - q.cx) < 0.02 && Math.abs(B.cy - q.cy) < 0.02)) return false;
        if (cells.some(c => Math.abs(c.cx - q.cx) < 0.02 && Math.abs(c.cy - q.cy) < 0.015)) return false;
        /* A rectangle with other places to write inside it is the frame round
           them, not an input: a whole row of a grid is drawn exactly like one
           wide box, and offering it would put one text box across the columns. */
        if (cells.some(c => holds(q, c.cx, c.cy))) return false;
        if (boxes.some(B => holds(q, B.cx, B.cy))) return false;
        if (lines.some(L => holds(q, (L.x0 + L.x1) / 2, L.y))) return false;
        return true;
      });
      /* A captioned box that already has rules or tick boxes drawn in it is
         not one place to write but several — "Height ___ ft. ___ in." is two
         blanks, and a yes/no column is a pair of boxes. Offer the finer thing
         and drop the box around it, or the page gets two overlapping targets
         that fight each other for the same tap. */
      const inside = (c, x, y) => x > c.x0 && x < c.x1 && y > c.y0 - 0.004 && y < c.y1 + 0.004;
      const split = c => {
        if (!c.cap) return false;
        const mine = lines.filter(L => inside(c, (L.x0 + L.x1) / 2, L.y));
        const tick = boxes.filter(B => inside(c, B.cx, B.cy));
        /* The caption still belongs to whatever is in the box — "Height" is
           the name of both rules under it, not of the box around them. Hand
           it down before dropping the box, or the rules fall back to the only
           other words nearby, which are the units printed after them, and the
           form comes out asking for "ft", "in" and "lbs". */
        mine.forEach(L => (L.cap = c.cap));
        tick.forEach(B => (B.cap = c.cap));
        // anything left further down that the rules and boxes do not explain
        // is somebody's answer, and this is not a blank after all
        return mine.length > 0 || tick.length > 0 || c.body;
      };
      p.scanned = {
        cells: cells.filter(c => !c.filled && !split(c)).concat(panels),
        cellsAll: cells, vrules: vs.length, bands: scan.bands.length,
        lines, boxes,
      };
    } catch (err) {
      console.warn('page scan failed', err);
      p.scanned = EMPTY_SCAN;
    }
    cv.width = cv.height = 0;                       // release the bitmap
    p.scanKey = key;
    p.scanPending = null;
    return p.scanned;
  })();
  return p.scanJob;
}

/** the tick box under a tap, if the tap really is inside one */
function findBox(p, x, y, pad = 0.004) {
  let best = null, bd = Infinity;
  for (const B of pageBoxes(p)) {
    if (x < B.x0 - pad || x > B.x1 + pad || y < B.y0 - pad || y > B.y1 + pad) continue;
    const d = Math.hypot(x - B.cx, y - B.cy);
    if (d < bd) { bd = d; best = B; }
  }
  return best;
}

/** nearest fill-in line to a tap, or null.
    `up` is how far above the line a tap still counts — generous, because that
    is where people aim when they mean to write on it. */
function findLine(p, x, y, up = 0.028, down = 0.020) {
  const lines = pageLines(p);
  let best = null, bd = Infinity;
  for (const L of lines) {
    const dy = y - L.y;                       // negative = tapped above the line
    if (dy < -up || dy > down) continue;
    if (x < L.x0 - 0.03 || x > L.x1 + 0.03) continue;
    const d = Math.abs(dy);
    if (d < bd) { bd = d; best = L; }
  }
  return best;
}

/* the flash sits on the page element, which is already in display space */
function flashLine(p, L) {
  const el = document.createElement('div');
  el.className = 'snapflash';
  el.style.left = (L.x0 * p.dw) + 'px';
  el.style.top = (L.y * p.dh - 1) + 'px';
  el.style.width = ((L.x1 - L.x0) * p.dw) + 'px';
  p.el.append(el);
  setTimeout(() => el.remove(), 800);
}

/* ================================================================== ITEMS */
const isText = it => it.type === 'text';
const textOf = it => (it.date ? renderDate(it) : it.text);

function itemEl(it) {
  const p = S.pageBox[it.page];
  const d = document.createElement('div');
  d.className = 'it it-' + it.type + (it.date ? ' it-date' : '') +
                (it.boxed ? ' is-boxed' : '') + (it.cell ? ' in-cell' : '');
  d.dataset.id = it.id;

  if (isText(it)) {
    const t = document.createElement('div');
    t.className = 'it-text';
    t.dataset.ph = 'Type…';
    t.textContent = textOf(it);
    t.style.color = it.color;
    d.append(t);
  } else if (it.type === 'sig') {
    const img = document.createElement('img');
    img.src = it.src; img.draggable = false;
    d.append(img);
  } else if (it.type === 'redact') {
    /* solid black */
  } else {
    d.classList.add('it-mark');
    d.innerHTML = it.type === 'check'
      ? `<svg viewBox="0 0 24 24"><path d="M2.6 12.8 9.2 19.6 21.4 4.6" fill="none" stroke="${it.color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg viewBox="0 0 24 24"><path d="M2.6 2.6 21.4 21.4 M21.4 2.6 2.6 21.4" fill="none" stroke="${it.color}" stroke-width="2.6" stroke-linecap="round"/></svg>`;
  }

  /* A handle on every corner. One handle in the bottom right can only ever
     grow a box down and to the right, which is the wrong direction most of
     the time: text already sitting on its line wants to grow *upward* off
     that line and stay left-aligned. Whichever corner you take hold of, the
     opposite one stays where it is — so the corner you are not touching is
     the part of the box you are keeping. */
  for (const c of CORNERS) {
    const h = document.createElement('div');
    h.className = 'handle handle-' + c;
    h.dataset.c = c;
    d.append(h);
  }
  p.layer.append(d);
  sizeItem(it, d);
  return d;
}

/* the object's own page-frame dimensions, in layer pixels */
const itemFrame = it => {
  const p = S.pageBox[it.page];
  return localDims(p.lw, p.lh, it.rot);
};

function sizeItem(it, d) {
  const p = S.pageBox[it.page];
  const [Wl, Hl] = localDims(p.lw, p.lh, it.rot);
  const [ux, uy] = unrotXY(it.rot, it.x, it.y);
  d.style.left = (ux * p.lw) + 'px';
  d.style.top = (uy * p.lh) + 'px';
  d.style.transform = it.rot ? `rotate(${-norm4(it.rot)}deg)` : '';
  if (isText(it)) {
    d.firstChild.style.fontSize = (it.fs * Hl) + 'px';
    if (it.cell) {
      d.style.width = ((it.cell.x1 - it.cell.x0) * Wl) + 'px';
      d.style.height = '';
    } else { d.style.width = ''; d.style.height = ''; }
  } else if (it.type === 'sig') {
    const w = it.w * Wl;
    d.style.width = w + 'px'; d.style.height = (w * it.ar) + 'px';
  } else if (it.type === 'redact') {
    d.style.width = (it.w * Wl) + 'px'; d.style.height = (it.h * Hl) + 'px';
  } else {
    const s = it.size * Hl;
    d.style.width = s + 'px'; d.style.height = s + 'px';
  }
}

function paintItems() {
  S.pageBox.forEach(p => p.layer.querySelectorAll('.it').forEach(e => e.remove()));
  S.items.forEach(it => {
    const d = itemEl(it);
    if (S.sel === it.id) d.classList.add('sel');
  });
  hintsSoon();
}
function relayoutItems() {
  S.items.forEach(it => {
    const d = S.pageBox[it.page]?.layer.querySelector(`[data-id="${it.id}"]`);
    if (d) sizeItem(it, d);
  });
}
const elOf = id => pagesEl.querySelector(`[data-id="${id}"]`);
const getSel = () => S.items.find(i => i.id === S.sel);

function select(id) {
  // flush whatever is being typed before judging whether a box is empty
  const ae = document.activeElement;
  if (ae && ae.isContentEditable) ae.blur();
  // an empty text box you tapped away from was never really wanted
  const prev = getSel();
  if (prev && prev.id !== id && isText(prev) && !prev.date && !prev.link && !prev.text.trim()) {
    S.items.splice(S.items.indexOf(prev), 1);
    elOf(prev.id)?.remove();
  }
  S.sel = id;
  $$('.it').forEach(d => d.classList.toggle('sel', d.dataset.id === id));
  syncBars();
  if (prev && prev.id !== id) hintsSoon();
}

/* The bars live in the same column as the stage, so one appearing takes its
   height off the stage and everything you were looking at slides. Zoomed in
   on one line of a form that is the difference between placing a date where
   you meant to and chasing it back down the page. The scroll offset is the
   top of the view, so holding it steady still loses the bottom — hold the
   *middle* instead, which is where you are looking and where you just tapped. */
function keepView(change) {
  const h0 = stageEl.clientHeight, top0 = stageEl.scrollTop;
  change();
  const d = h0 - stageEl.clientHeight;
  if (!d) return;
  const max = Math.max(0, stageEl.scrollHeight - stageEl.clientHeight);
  stageEl.scrollTop = clamp(top0 + d / 2, 0, max);
}

function syncBars() {
  const it = getSel();
  keepView(() => { $('#selbar').hidden = !it; });
  if (!it) return;
  const colorable = isText(it) || it.type === 'check' || it.type === 'x';
  $('#swatches').hidden = !colorable;
  $('#sepColor').hidden = !colorable;
  $$('#swatches .sw').forEach(b => b.classList.toggle('is-on', b.dataset.color === it.color));

  const stampBtn = $('#btnStamp');
  stampBtn.hidden = it.type !== 'sig';
  if (it.type === 'sig') {
    stampBtn.textContent = it.stampMode === 'none' ? 'No timestamp'
      : it.stampMode === 'date' ? 'Date only' : 'Date & time';
  }
  const fmtBtn = $('#btnDateFmt');
  fmtBtn.hidden = !it.date;
  if (it.date) fmtBtn.textContent = shortLabel(it.date.fmt);

  /* Thickness is one button here and a bar of its own when pressed — see
     openPen. Anything the button does not apply to closes that bar, or you
     end up adjusting the weight of something that has no weight. */
  const penable = it.type === 'sig' && !!it.gen;
  $('#btnPen').hidden = !penable;
  if (penable) $('#penSel').value = it.gen.pen;
  else closePen();
}

/* ---- signature thickness, on demand

   A slider is a wide control, and parking one permanently in a bar that
   already has to scroll means scrolling to it every time you want the two
   seconds of use it gets. So the bar carries a button, and the button brings
   the slider up on its own — over the tools, like crop and rotate, so there
   is nothing to scroll past and nothing else competing for the space. */
function openPen() {
  const it = getSel();
  if (!it || it.type !== 'sig' || !it.gen) return;
  closeCrop(); closeRotate();
  $('#penSel').value = it.gen.pen;
  keepView(() => {
    $('#penbar').hidden = false;
    $('#editor').classList.add('busytool');
  });
}
function closePen() {
  if ($('#penbar').hidden) return;
  keepView(() => {
    $('#penbar').hidden = true;
    if ($('#cropbar').hidden && $('#rotbar').hidden) $('#editor').classList.remove('busytool');
  });
}

/* redraw a placed signature at a new pen weight */
let penT;
async function repen(it, value) {
  it.gen.pen = value;
  it.src = await renderSig(it.gen);
  const img = new Image(); img.src = it.src; await img.decode();
  it.ar = img.height / img.width;
  const d = elOf(it.id);
  if (d) { d.querySelector('img').src = it.src; sizeItem(it, d); }
  reseatStamp(it);
  saveSoon();
}
$('#penSel').addEventListener('input', e => {
  const it = getSel();
  if (!it || it.type !== 'sig' || !it.gen) return;
  clearTimeout(penT);
  const v = +e.target.value;
  penT = setTimeout(() => repen(it, v), 60);
});
$('#penSel').addEventListener('change', () => { const it = getSel(); if (it?.gen) push(); });
$('#btnPen').addEventListener('click', openPen);
$('#penDone').addEventListener('click', closePen);

/* -------------------------------------------------------------- toolbar */
$$('.tool').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.tool;
  if (t === 'sig') { S.tool = null; reflectTool(); openSig(); return; }
  if (t === 'rotate') { S.tool = null; reflectTool(); openRotate(); return; }
  if (t === 'crop') { S.tool = null; reflectTool(); openCrop(); return; }
  if (t === 'clear') { S.tool = null; reflectTool(); openClear(); return; }
  if (t === 'simple') { S.tool = null; reflectTool(); goSimple(); return; }
  S.tool = S.tool === t ? null : t;
  pendingSig = null;
  reflectTool();
  /* Hand focus back to the page. A focused button in a bar at the bottom is
     something a browser will pan its own viewport to keep in view, and while
     you are pinched in on one line that pan is the whole screen moving. */
  focusStage();
}));
/* …and do not let the press take focus in the first place */
$('#toolwrap').addEventListener('mousedown', e => {
  if (e.target.closest('.tool, .toolnext')) e.preventDefault();
});

/* ---- how far along the row of tools you are

   Five buttons fit on a phone and there are ten, so the row scrolls — and a
   row that scrolls with nothing to say so reads as the whole set. The track
   under the tools is the row, the bar on it is the part you can see, and the
   chip at the right edge both announces the rest and goes there. Neither
   moves on its own: the point is to be readable in the moment you glance at
   it, not to catch the eye later. */
const toolbarEl = $('#toolbar');
let parked = false, parking = false;
function syncRail() {
  const rail = $('#toolRail'), thumb = $('#toolThumb');
  const next = $('#toolNext'), prev = $('#toolPrev');
  if (!rail) return;
  const room = toolbarEl.scrollWidth - toolbarEl.clientWidth;
  /* Nothing to park or measure until the row has actually been laid out with
     a width — which is not true while the editor is still hidden behind the
     chooser, so this is the honest place to do it rather than a timer. */
  if (room < 8) { rail.hidden = next.hidden = prev.hidden = true; return; }
  rail.hidden = next.hidden = prev.hidden = false;
  if (!parked && !parking) {
    /* Next frame, and measured rather than derived. The chips have only just
       stopped being hidden, so the row is about to lose their width — parking
       against the width it has this instant lands a tool-and-a-bit too far
       along. And offsetLeft answers a question about the layout tree, when
       what is wanted is where the button is on the screen.

       It counts as parked only once it has actually moved something: this
       runs while the page chooser is still up, and a row that is laid out but
       not on screen measures zero and would be quietly given up on. */
    parking = true;
    requestAnimationFrame(() => {
      parking = false;
      const first = toolbarEl.querySelector('.tool:not(.tool-alt)');
      const r = toolbarEl.getBoundingClientRect();
      if (!first || !r.width) return;
      parked = true;
      toolbarEl.scrollLeft += first.getBoundingClientRect().left - r.left;
      syncRail();
    });
  }
  const seen = toolbarEl.clientWidth / toolbarEl.scrollWidth;
  const at = toolbarEl.scrollLeft / room;
  thumb.style.width = (seen * 100) + '%';
  thumb.style.left = (at * (1 - seen) * 100) + '%';
  // an arrow with nothing that way still says which way the row runs
  prev.classList.toggle('spent', at < 0.02);
  next.classList.toggle('spent', at > 0.98);
}
toolbarEl.addEventListener('scroll', syncRail, { passive: true });
addEventListener('resize', syncRail);

/* A press on either chip goes most of the way across rather than exactly one
   screenful: landing dead on a boundary leaves half a button showing at each
   edge and no sense of having arrived anywhere. */
const slide = dir => toolbarEl.scrollBy({ left: dir * toolbarEl.clientWidth * 0.86, behavior: 'smooth' });
$('#toolNext').addEventListener('click', () => slide(1));
$('#toolPrev').addEventListener('click', () => slide(-1));

/* Simple view sits at the near end of the row, parked just off the left edge:
   the five you reach for are what you see, and one swipe right — or the green
   chip — brings it in. Armed here, done by syncRail the first time the row is
   wide enough to scroll, so it happens once per document and never yanks the
   row back out from under a swipe. */
function parkTools() { parked = false; syncRail(); }
const PROMPT = {
  text: 'Tap a blank line to type on it',
  date: 'Tap the page to add the date',
  check: 'Tap a box to tick it',
  x: 'Tap a box to mark it',
  redact: 'Drag across whatever you want blacked out',
};
function reflectTool() {
  $$('.tool').forEach(b => b.classList.toggle('is-on', b.dataset.tool === S.tool));
  $('#editor').classList.toggle('arming', !!S.tool || !!pendingSig);
  $$('.page').forEach(p => p.classList.toggle('arm', !!S.tool || !!pendingSig));
  const on = !!S.tool || !!pendingSig;
  $('#placing').hidden = !on;
  if (on) $('#placingText').textContent = pendingSig ? 'Tap where your signature goes' : PROMPT[S.tool];
}
$('#placingCancel').addEventListener('click', () => { S.tool = null; pendingSig = null; reflectTool(); });

/* ------------------------------------------------------- placing / editing */
let pendingSig = null;

/* Double tap puts a text box exactly where you put your finger.

   The scan is a guess and sometimes it guesses wrong — a blank it did not
   see, a field the form draws in some way nothing accounts for. Rather than
   make you go up to the toolbar, arm the Text tool and come back, the second
   tap is the escape hatch: it drops a box right there, already selected, so
   the next thing you type goes in it. Browsers spend that gesture on zoom,
   which this page has no use for — the viewport is fixed. */
const DBL = { t: 0, x: 0, y: 0 };
const isDoubleTap = e => {
  const now = performance.now();
  const near = Math.hypot(e.clientX - DBL.x, e.clientY - DBL.y) < 28 && now - DBL.t < 420;
  DBL.t = now; DBL.x = e.clientX; DBL.y = e.clientY;
  if (near) DBL.t = 0;                       // three taps are not two doubles
  return near;
};

pagesEl.addEventListener('pointerdown', e => {
  if (!e.isPrimary) return;
  const pageEl = e.target.closest('.page');
  if (!pageEl) return;

  if (e.target.closest('.fld')) return;         // a real form field handles itself

  const handle = e.target.closest('.handle');
  const itEl = e.target.closest('.it');
  if (handle && itEl) return startResize(e, itEl);
  if (itEl) { isDoubleTap(e); return startDrag(e, itEl); }

  const pi = +pageEl.dataset.i;
  const p = S.pageBox[pi];
  const r = pageEl.getBoundingClientRect();
  // the page as the user sees it right now is the frame we place into
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;

  const twice = isDoubleTap(e);

  if (S.tool === 'redact') { e.preventDefault(); return startRubber(e, pi, x, y); }

  // a check or an X dropped on a tick box lands squarely inside it
  if (S.tool === 'check' || S.tool === 'x') {
    const B = findBox(p, x, y, 0.006);
    if (B) { e.preventDefault(); clearBoxCursor(); cycleBox(pi, B, S.tool); S.tool = null; reflectTool(); return void markSpot(pi, boxKey(pi, B)); }
    /* Nowhere in particular: ask twice. Landing a mark on a box the scan
       found is unambiguous, but a single tap on open paper is far more often
       a scroll that did not travel, or a finger resting on the page. */
    if (!twice) { e.preventDefault(); toast('Tap again to put it there.', 1800); return; }
  }
  if (S.tool || pendingSig) { e.preventDefault(); return place(pi, x, y); }

  /* Nothing armed: a tap straight into an empty tick box ticks it. On touch
     it has to be a tap and not a scroll that happened to pass over the box,
     so this waits for the finger to come back up — which also means the page
     scrolls normally while it is down. */
  const B = findBox(p, x, y, 0.002);
  if (B) {
    if (e.pointerType !== 'touch') e.preventDefault();
    return onTap(e, () => {
      clearBoxCursor(); cycleBox(pi, B, 'x'); markSpot(pi, boxKey(pi, B));
    });
  }

  // …and tapping a marked-up blank line starts typing on it
  const hint = findHint(p, x, y);
  if (hint) return armHintTap(e, pi, hint);

  /* Nothing here — which is exactly when the second tap means something. It
     never gets to overrule a tick box or a blank the scan already found:
     those do the right thing already, and a quick double tap on one of them
     is just an impatient single tap. */
  if (twice) { e.preventDefault(); return placeLooseText(pi, x, y); }

  focusStage();
  leaveSpot();
  if (S.sel) select(null);
});

/* ------------------------------------------------------------- tick boxes */
const CORNERS = ['nw', 'ne', 'sw', 'se'];
const isMark = it => it.type === 'check' || it.type === 'x';

/* Everything is stored by its top-left corner, so changing a size alone grows
   the object down and to the right — and a tick you enlarged because it was
   too small for its box has now walked out of the box, and a line of text has
   sunk below the rule it was sitting on. Every resize then cost a drag to put
   it back, which is most of the value of resizing gone.

   So resizing says which part of the object it is *keeping*, and the object
   is moved to honour it. `keep` is a corner ('sw' keeps the left edge and the
   bottom), or 'c' for the middle. Measuring the element on both sides of the
   change is what makes this work for text, whose width nobody stores: it is
   whatever the words come out as. */
function resized(it, d, keep, apply) {
  const [Wl, Hl] = itemFrame(it);
  const w0 = d.offsetWidth, h0 = d.offsetHeight;
  apply();
  sizeItem(it, d);
  const dw = d.offsetWidth - w0, dh = d.offsetHeight - h0;
  if (keep === 'c') { it.x -= dw / 2 / Wl; it.y -= dh / 2 / Hl; return; }
  if (keep.includes('e')) it.x -= dw / Wl;      // keeping the right edge
  if (keep.includes('s')) it.y -= dh / Hl;      // keeping the bottom
  sizeItem(it, d);
}

/** the mark already sitting in this box, if any */
function markInBox(pi, B) {
  return S.items.find(it => {
    if (it.page !== pi || !isMark(it)) return false;
    const [Wl, Hl] = itemFrame(it);
    const cx = it.x + (it.size * Hl / Wl) / 2, cy = it.y + it.size / 2;
    return cx >= B.x0 && cx <= B.x1 && cy >= B.y0 && cy <= B.y1;
  });
}

function placeInBox(pi, B, type, sel = true) {
  const p = S.pageBox[pi];
  const rot = totalRot(p);
  const [Wl, Hl] = localDims(p.lw, p.lh, rot);
  /* Fill the box. At 86% inside a glyph that only uses two thirds of its own
     viewBox, the mark came out under half the width of the square it was in —
     you could scan a page and not see that it had been ticked at all. The
     corners of the cross should land on the corners of the box. */
  const side = Math.min(B.w * Wl, B.h * Hl) * 1.02;
  const size = side / Hl;
  const it = {
    id: uid(), page: pi, rot, type,
    x: clamp(B.cx - (side / Wl) / 2, 0, 1),
    y: clamp(B.cy - size / 2, 0, 1),
    size, color: COLORS[0], boxed: 1,
  };
  push();
  S.items.push(it);
  itemEl(it);
  if (sel) select(it.id);
  saveSoon();
  return it;
}

/** One box, one control: empty → X → checkmark → empty again. An X first,
    because that is what people put in a box on paper, and because it is the
    mark you can see from across the page. */
function cycleBox(pi, B, first, sel = true) {
  const cur = markInBox(pi, B);
  if (!cur) return placeInBox(pi, B, first, sel);
  if (cur.type === first) {
    push();
    cur.type = first === 'x' ? 'check' : 'x';
    paintItems();
    if (sel) select(cur.id);
    saveSoon();
    return cur;
  }
  push();
  removeItem(cur.id);
  saveSoon();
  return null;
}

// tapping the grey area beside the page also deselects
stageEl.addEventListener('pointerdown', e => {
  if (!e.isPrimary || e.target.closest('.page')) return;
  focusStage();
  if (S.sel) select(null);
});

/* A text box placed by hand, at the spot and nowhere else. It does not snap
   to a rule: you double tapped because the rule you wanted was not offered,
   so moving the box somewhere else would be answering the wrong question.
   Sized to the blank underneath if there is one, since that is only a guess
   about how big your writing should be, not about where it goes. */
function placeLooseText(pi, x, y) {
  const p = S.pageBox[pi];
  const near = findLine(p, x, y);
  const fs = near ? near.fs : fsRange(p).def;
  const it = { id: uid(), page: pi, rot: totalRot(p), type: 'text',
               x: clamp(x, 0, .97), y: clamp(y - fs * 0.62, 0, .99),
               fs, color: COLORS[0], text: '' };
  push();
  S.items.push(it);
  const d = itemEl(it);
  select(it.id);
  edit(d);
  // the tap that made it is still in flight; don't let its click steal the caret
  requestAnimationFrame(() => { if (S.sel === it.id && !it.text) edit(d); });
  saveSoon();
  return it;
}

function place(pi, x, y) {
  const p = S.pageBox[pi];
  const rot = totalRot(p);
  const [Wl, Hl] = localDims(p.lw, p.lh, rot);
  const tool = S.tool;
  const id = uid();
  const L = pendingSig ? findLine(p, x, y, 0.065, 0.028)
    : (tool === 'text' || tool === 'date') ? findLine(p, x, y)
    : null;
  let it;

  if (pendingSig) {
    const ar = pendingSig.ar;
    const wFor = h => sigWidth(p, ar, h);
    let w, sx, sy;
    if (L) {
      // sit the signature on the line, sized to the label beside it
      w = sigOnLine(p, L, ar);
      const h = (w * Wl * ar) / Hl;
      sx = clamp(L.x0 + 0.008, 0, 1 - w);
      sy = clamp(L.y - h - 0.004, 0, 1);
    } else {
      // nothing to match: a hand-sized signature, centred on the tap
      w = wFor(SIG_PT / pageHpt(p));
      sx = clamp(x - w / 2, 0, 1 - w);
      sy = clamp(y - ((w * Wl * ar) / Hl) / 2, 0, 1);
    }
    it = { id, page: pi, rot, type: 'sig', x: sx, y: sy, w, ar,
           src: pendingSig.src, gen: pendingSig.gen || null,
           stampMode: pendingSig.stamp ? 'datetime' : 'none' };
    push(); S.items.push(it); itemEl(it);
    if (it.stampMode !== 'none') addStamp(it);
    if (L) flashLine(p, L);
    pendingSig = null; S.tool = null; reflectTool(); select(id);
    if (L) markSpot(pi, lineKey(pi, L));
    saveSoon(); return;
  }

  if (tool === 'text' || tool === 'date') {
    const fs = L ? L.fs : fsRange(p).def;
    // baseline lands just above the rule; otherwise centre the text on the tap
    const ty = L ? L.y - fs * (BASELINE + 0.06) : y - fs * 0.62;
    let tx = L ? L.x0 + 0.006 : x;
    if (L && x - tx > 0.36) tx = x;            // don't yank across a full-width rule
    it = { id, page: pi, rot, type: 'text', x: clamp(tx, 0, .97), y: clamp(ty, 0, .99),
           fs, color: COLORS[0], text: '' };
    if (L) it.lineKey = lineKey(pi, L);
    if (tool === 'date') it.date = { at: Date.now(), fmt: 0 };
    if (L) flashLine(p, L);
  } else if (tool === 'redact') {
    it = { id, page: pi, rot, type: 'redact', x: clamp(x - DEF.redW / 2, 0, 1 - DEF.redW),
           y: clamp(y - DEF.redH / 2, 0, 1 - DEF.redH), w: DEF.redW, h: DEF.redH };
  } else {
    const s = DEF.mark;
    it = { id, page: pi, rot, type: tool, x: clamp(x - (s * Hl / Wl) / 2, 0, 1),
           y: clamp(y - s / 2, 0, 1 - s), size: s, color: COLORS[0] };
  }

  push();
  S.items.push(it);
  const d = itemEl(it);
  if (!STICKY.has(tool)) { S.tool = null; reflectTool(); }
  select(id);
  if (it.lineKey) markSpot(pi, it.lineKey);
  if (isText(it) && !it.date) edit(d);
}

/* signature + timestamp behave as one object */
function addStamp(sig) {
  const [Wl, Hl] = itemFrame(sig);
  const sigH = (sig.w * Wl * sig.ar) / Hl;
  const st = {
    id: uid(), page: sig.page, rot: sig.rot, type: 'text',
    x: sig.x + 0.004, y: clamp(sig.y + sigH + 0.004, 0, 1),
    // scale to the signature, or a small snapped signature gets a huge date
    fs: stampFsFor(sig.w),
    color: COLORS[0],
    text: '', link: sig.id,
    date: { at: Date.now(), fmt: sig.stampMode === 'date' ? 1 : 3 },
  };
  S.items.push(st);
  itemEl(st);
  return st;
}

/** re-seat a signature's timestamp under it (after a move or resize) */
function reseatStamp(sig) {
  const st = stampOf(sig);
  if (!st) return;
  const [Wl, Hl] = itemFrame(sig);
  st.x = sig.x + 0.004;
  st.y = clamp(sig.y + (sig.w * Wl * sig.ar) / Hl + 0.004, 0, 1);
  const d = elOf(st.id);
  if (d) sizeItem(st, d);
}
const stampOf = sig => S.items.find(i => i.link === sig.id);

/* rubber-band blackout */
function startRubber(e, pi, x0, y0) {
  const p = S.pageBox[pi];
  const rot = totalRot(p);
  const [Wl, Hl] = localDims(p.lw, p.lh, rot);
  const rect = p.el.getBoundingClientRect();
  const band = document.createElement('div');
  band.className = 'rubber';
  band.style.transform = rot ? `rotate(${-rot}deg)` : '';
  p.layer.append(band);
  let x1 = x0, y1 = y0, moved = false;
  const draw = () => {
    const [ux, uy] = unrotXY(rot, Math.min(x0, x1), Math.min(y0, y1));
    band.style.left = (ux * p.lw) + 'px';
    band.style.top = (uy * p.lh) + 'px';
    band.style.width = (Math.abs(x1 - x0) * Wl) + 'px';
    band.style.height = (Math.abs(y1 - y0) * Hl) + 'px';
  };
  draw();
  const pid = e.pointerId;
  try { p.el.setPointerCapture(pid); } catch (_) {}
  const move = ev => {
    if (ev.pointerId !== pid) return;
    ev.preventDefault();
    x1 = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
    y1 = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
    if (Math.abs(x1 - x0) * Wl > 4 || Math.abs(y1 - y0) * Hl > 4) moved = true;
    draw();
  };
  const up = ev => {
    if (ev && ev.pointerId !== pid) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    try { p.el.releasePointerCapture(pid); } catch (_) {}
    band.remove();
    if (!moved) return place(pi, x0, y0);
    push();
    const it = {
      id: uid(), page: pi, rot, type: 'redact',
      x: Math.min(x0, x1), y: Math.min(y0, y1),
      w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
    };
    S.items.push(it); itemEl(it);
    S.tool = null; reflectTool(); select(it.id); saveSoon();
  };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/* text editing */
function edit(d) {
  const t = d.firstChild;
  t.contentEditable = 'plaintext-only';
  if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
  t.focus();
  const r = document.createRange(); r.selectNodeContents(t);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  t.onblur = () => {
    t.contentEditable = 'false';
    const it = S.items.find(i => i.id === d.dataset.id);
    if (!it) return;
    const v = t.innerText.replace(/ /g, ' ').replace(/\n+$/, '');
    if (v !== it.text) { push(); it.text = v; }
    // an empty box is kept so it can still be dragged into place; it is
    // discarded when you select something else, and never exported.
    saveSoon();
  };
  t.onkeydown = ev => { if (ev.key === 'Escape') t.blur(); };
}

function removeItem(id) {
  hintsSoon();
  const i = S.items.findIndex(x => x.id === id);
  if (i < 0) return;
  const it = S.items[i];
  S.items.splice(i, 1);
  elOf(id)?.remove();
  if (it.type === 'sig') {
    const st = S.items.find(x => x.link === id);
    if (st) { S.items.splice(S.items.indexOf(st), 1); elOf(st.id)?.remove(); }
  }
  if (S.sel === id) { S.sel = null; syncBars(); }
  saveSoon();
}

/* Two fingers on the glass is a pinch, never a drag. The first finger of a
   pinch usually lands on something — on a filled-in form, quite often on a
   text box — and a drag started from it would ride along with the zoom and
   leave the box somewhere you never put it. So count the fingers: a gesture
   that becomes a pinch gives back whatever it had already moved. */
const touching = new Set();
addEventListener('pointerdown', e => { if (e.pointerType === 'touch') touching.add(e.pointerId); }, true);
const lift = e => touching.delete(e.pointerId);
addEventListener('pointerup', lift, true);
addEventListener('pointercancel', lift, true);
const pinching = e => e.pointerType === 'touch' && touching.size > 1;

/* --------------------------------------------------------- a real tap

   On a page with thirty things written on it, most presses are not taps:
   they are the start of a scroll, or the first finger of a pinch. Acting on
   pointerdown meant every one of those landed on whatever happened to be
   under the finger — picking up an entry you were only scrolling past,
   dropping an X in a box you were scrolling over — and the only sign was
   that the bar at the bottom had quietly changed to something else.

   So on touch nothing happens until the finger comes back up in the same
   place. Travel more than a few pixels, bring a second finger, or hold on
   past the point where a tap is still a tap, and the press was navigation
   and gets left alone. Crucially nothing is prevented while we wait, so the
   page scrolls under the finger exactly as it does anywhere else.

   A mouse needs none of this. A click is a click. */
const TAP_SLOP = 8, TAP_MS = 700;
function onTap(e, run) {
  if (e.pointerType !== 'touch') return run();
  if (pinching(e)) return;
  const sx = e.clientX, sy = e.clientY, t0 = performance.now(), pid = e.pointerId;
  let dead = false;
  const off = () => {
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', off);
    window.removeEventListener('pointerdown', second, true);
    window.removeEventListener('pointermove', track);
  };
  /* A second finger any time during the gesture means a pinch, and asking
     `touching.size` on the way up is too late to see it: the global bookkeeping
     runs in the capture phase, so by the time this hears about the release the
     finger that lifted has already been struck off. Watch the arrival instead. */
  const second = ev => { if (ev.pointerId !== pid) dead = true; };
  // travel is judged from every move, not only from where the finger ended up
  const track = ev => {
    if (ev.pointerId === pid && Math.hypot(ev.clientX - sx, ev.clientY - sy) > TAP_SLOP) dead = true;
  };
  const up = ev => {
    if (ev.pointerId !== pid) return;
    off();
    if (dead) return;                                                    // pinch or scroll
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > TAP_SLOP) return;
    if (performance.now() - t0 > TAP_MS) return;                         // a long press
    run();
  };
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', off);
  window.addEventListener('pointerdown', second, true);
  window.addEventListener('pointermove', track);
}

/* drag — works on an empty box that is still being typed into: a real drag
   (more than a few pixels) takes over, a tap just moves the caret. */
function startDrag(e, d) {
  if (pinching(e)) return;                 // the second finger of a pinch
  const it = S.items.find(i => i.id === d.dataset.id);
  if (!it) return;
  const wasSel = S.sel === it.id;
  /* A finger is blunt. Scrolling a page covered in things you have placed
     dragged them about constantly, because the press that starts a scroll
     lands on one of them. So on touch an object has to be selected before it
     will move: the first tap chooses it, the second drags it. A mouse is
     precise enough not to need the ceremony.

     And that first tap has to be an actual tap — see onTap. Choosing on
     pointerdown meant the scroll that merely passed over something selected
     it, which is how you end up looking at a bar full of controls for an
     entry you never meant to touch. */
  if (e.pointerType === 'touch' && !wasSel) {
    onTap(e, () => {
      if (!S.items.some(i => i.id === it.id)) return;      // deleted meanwhile
      select(it.id);
      if (it.lineKey) markSpot(it.page, it.lineKey);
    });
    return;
  }
  const tnode = d.firstChild;
  const editing = isText(it) &&
    (tnode?.contentEditable === 'true' || tnode?.contentEditable === 'plaintext-only');

  if (!editing) { select(it.id); e.preventDefault(); try { d.setPointerCapture(e.pointerId); } catch (_) {} }
  if (it.lineKey) markSpot(it.page, it.lineKey);

  const p = S.pageBox[it.page];
  const spin = norm4(totalRot(p) - it.rot);
  const [Wl, Hl] = itemFrame(it);
  const sx = e.clientX, sy = e.clientY;
  const pid = e.pointerId;

  /* a signature and its timestamp move together, whichever one you grab */
  const anchor = it.link ? S.items.find(i => i.id === it.link) : it;
  const partner = anchor === it
    ? (it.type === 'sig' ? stampOf(it) : null)
    : anchor;
  const o = { x: it.x, y: it.y, px: partner?.x, py: partner?.y };
  let moved = false;

  const off = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };

  /* Put it back exactly where it was and take the undo step off the stack
     with it — a pinch should leave no trace, not something to undo. */
  const putBack = () => {
    if (moved) {
      it.x = o.x; it.y = o.y;
      sizeItem(it, d);
      if (partner) {
        partner.x = o.px; partner.y = o.py;
        const pd = elOf(partner.id);
        if (pd) sizeItem(partner, pd);
      }
      S.past.pop(); syncHistory();
      moved = false;
    }
    off();
  };

  const move = ev => {
    if (pinching(ev)) return putBack();
    if (ev.pointerId !== pid) return;
    if (!moved) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) <= 6) return;
      moved = true;
      if (editing) { tnode.blur(); select(it.id); try { d.setPointerCapture(pid); } catch (_) {} }
      // dragged out of its tick box: it is a free mark again, handle and all
      if (it.boxed) { delete it.boxed; d.classList.remove('is-boxed'); }
      push();
    }
    ev.preventDefault();
    const [ppx, ppy] = unspin(spin, ev.clientX - sx, ev.clientY - sy);
    const dx = ppx / Wl, dy = ppy / Hl;
    it.x = clamp(o.x + dx, -0.06, 1.03); it.y = clamp(o.y + dy, -0.03, 1.0);
    sizeItem(it, d);
    if (partner) {
      partner.x = o.px + dx; partner.y = o.py + dy;
      const pd = elOf(partner.id);
      if (pd) sizeItem(partner, pd);
    }
  };
  const up = ev => {
    if (ev && ev.pointerId !== pid) return;
    off();
    if (!moved && isText(it) && !it.date && wasSel && !editing) edit(d);
    /* Dragging a box you were typing into hands the caret back when you let
       go. You moved it because it was in the wrong place, not because you
       changed your mind about writing in it — having to tap it again to carry
       on is a step that exists for no reason. An empty box counts even if the
       caret had already slipped away: an empty box is one nobody has written
       in yet, and there is nothing else it could be for. */
    if (moved && isText(it) && !it.date &&
        (editing || !it.text.trim())) edit(d);
    // tapping a mark that already sits in a tick box moves it on round the cycle
    if (!moved && wasSel && isMark(it)) {
      const [Wl, Hl] = itemFrame(it);
      const B = findBox(p, it.x + (it.size * Hl / Wl) / 2, it.y + it.size / 2, 0.004);
      if (B) cycleBox(it.page, B, 'x');
    }
    if (moved) saveSoon();
  };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/* resize */
function startResize(e, d) {
  if (pinching(e)) return;
  let it = S.items.find(i => i.id === d.dataset.id);
  if (!it) return;
  /* Which corner you took hold of. The one opposite is what stays put, so
     dragging the top right of a line of text grows it upward off the rule and
     leaves it left-aligned exactly where it was. */
  const corner = e.target.closest('.handle')?.dataset.c || 'se';
  const gx = corner.includes('e') ? 1 : -1;      // which way is bigger
  const gy = corner.includes('s') ? 1 : -1;
  const keep = (corner[0] === 'n' ? 's' : 'n') + (corner[1] === 'w' ? 'e' : 'w');

  /* A timestamp belongs to its signature. Its handle sits right where the
     signature's does, so grabbing either one has to resize the pair — not
     blow the date up on its own. */
  if (it.link) {
    const sig = S.items.find(i => i.id === it.link);
    const sd = sig && elOf(sig.id);
    if (sig && sd) { it = sig; d = sd; }
  }

  select(it.id);
  const p = S.pageBox[it.page];
  const spin = norm4(totalRot(p) - it.rot);
  const [Wl, Hl] = itemFrame(it);
  const sx = e.clientX, sy = e.clientY;
  const st = it.type === 'sig' ? stampOf(it) : null;
  const o = { fs: it.fs, w: it.w, h: it.h, size: it.size, x: it.x, y: it.y,
              w0: d.offsetWidth, h0: d.offsetHeight };
  const pid = e.pointerId;
  let started = false;
  // capture can be refused; a resize that silently does nothing is worse
  try { d.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault(); e.stopPropagation();

  const move = ev => {
    if (ev.pointerId !== pid) return;
    // a second finger means a pinch: give back the size it had and get out
    if (pinching(ev)) {
      if (started) {
        it.fs = o.fs; it.w = o.w; it.h = o.h; it.size = o.size;
        it.x = o.x; it.y = o.y;              // a mark moves as it grows now
        if (st) st.fs = stampFsFor(it.w);
        sizeItem(it, d);
        if (it.type === 'sig') reseatStamp(it);
        S.past.pop(); syncHistory();
        started = false;
      }
      return up();
    }
    if (!started) { started = true; push(); }
    const [ppx, ppy] = unspin(spin, ev.clientX - sx, ev.clientY - sy);
    const dx = (ppx / Wl) * gx, dy = (ppy / Hl) * gy;
    if (isText(it)) it.fs = clamp(o.fs + dy * 0.6 + dx * 0.15, 0.005, 0.14);
    else if (it.type === 'sig') {
      it.w = clamp(o.w + dx, 0.04, 1.2);                                    // aspect locked
      if (st) st.fs = stampFsFor(it.w);          // the date follows, down to a readable floor
    }
    else if (it.type === 'redact') { it.w = clamp(o.w + dx, 0.008, 1.2); it.h = clamp(o.h + dy, 0.004, 1.0); }
    else it.size = clamp(o.size + dy, 0.006, 0.35);
    /* Work out where it belongs from where it *started*, not from where the
       last frame of this drag left it. Nudging it a little each time looks
       right for a moment and then walks, because every step carries the last
       step's rounding with it. */
    it.x = o.x; it.y = o.y;
    sizeItem(it, d);
    if (keep.includes('e')) it.x = o.x - (d.offsetWidth - o.w0) / Wl;
    if (keep.includes('s')) it.y = o.y - (d.offsetHeight - o.h0) / Hl;
    sizeItem(it, d);
    if (it.type === 'sig') reseatStamp(it);
  };
  const up = ev => {
    if (ev && ev.pointerId !== pid) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    saveSoon();
  };
  /* On the window, not on the element. Listening on the element only works
     while pointer capture holds it, and capture can be refused — then the
     first drag past the edge of a small tick leaves the element behind and
     the resize quietly stops. A drag belongs to the gesture, not to whatever
     it happens to be over. */
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/* selection bar */
$$('#swatches .sw').forEach(b => b.addEventListener('click', () => {
  const it = getSel(); if (!it) return;
  push(); it.color = b.dataset.color;
  paintItems(); select(it.id);
}));
const bump = f => {
  const sel = getSel(); if (!sel) return;
  // sizing a timestamp sizes the signature it belongs to
  const it = (sel.link && S.items.find(i => i.id === sel.link)) || sel;
  const d = elOf(it.id);
  if (!d) return;
  push();
  /* Grow about the middle, so the object stays where you put it instead of
     creeping down and to the right every time you press the button. Text
     sitting on a blank line is the exception: there, the bottom edge *is* the
     line and the left edge is where the writing starts, so it keeps those two
     and grows upward. Centring that would lift it off its rule. */
  const keep = (isText(it) && it.lineKey) ? 'sw' : 'c';
  resized(it, d, keep, () => {
    if (isText(it)) it.fs = clamp(it.fs * f, 0.005, 0.14);
    else if (it.type === 'sig') {
      it.w = clamp(it.w * f, 0.04, 1.2);
      const st = stampOf(it);
      if (st) st.fs = stampFsFor(it.w);
    }
    else if (it.type === 'redact') { it.w = clamp(it.w * f, 0.008, 1.2); it.h = clamp(it.h * f, 0.004, 1); }
    else it.size = clamp(it.size * f, 0.006, 0.35);
  });
  if (it.type === 'sig') reseatStamp(it);
  relayoutItems(); saveSoon();
};
/* Nudge. A finger cannot place something to the pixel, and asking it to is
   how you end up dragging the object right off the line you were aiming at.
   Four arrows: a tap steps once, holding one scrubs — slowly at first, so a
   short hold is still precise, then faster once you clearly mean to travel.
   The step is a fraction of the page rather than a screen pixel, so it moves
   the same amount however far you are zoomed in. */
const NUDGE = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
function nudge(dir, far) {
  const it = getSel(); if (!it) return;
  const [Wl, Hl] = itemFrame(it);
  const step = (far ? 0.0045 : 0.0016);
  const [dx, dy] = NUDGE[dir];
  const partner = it.type === 'sig' ? stampOf(it) : (it.link ? S.items.find(i => i.id === it.link) : null);
  const move = o => {
    o.x = clamp(o.x + dx * step * (Hl / Wl), -0.06, 1.03);
    o.y = clamp(o.y + dy * step, -0.03, 1.0);
    const d = elOf(o.id); if (d) sizeItem(o, d);
  };
  move(it);
  if (partner) move(partner);
  saveSoon();
}
$('#nudge').addEventListener('pointerdown', e => {
  const b = e.target.closest('.nud'); if (!b) return;
  e.preventDefault();
  const dir = b.dataset.d, pid = e.pointerId;
  push();
  nudge(dir, false);
  let t0 = performance.now(), timer = null;
  const tick = () => { nudge(dir, performance.now() - t0 > 900); };
  const hold = setTimeout(() => { timer = setInterval(tick, 55); }, 340);
  const off = ev => {
    if (ev && ev.pointerId !== pid) return;
    clearTimeout(hold); if (timer) clearInterval(timer);
    window.removeEventListener('pointerup', off);
    window.removeEventListener('pointercancel', off);
  };
  window.addEventListener('pointerup', off);
  window.addEventListener('pointercancel', off);
});

$('#btnBigger').addEventListener('click', () => bump(1.15));
$('#btnSmaller').addEventListener('click', () => bump(1 / 1.15));
$('#btnDelete').addEventListener('click', () => { const it = getSel(); if (it) { push(); removeItem(it.id); } });
/* Duplicate used to sit here too. Copying something you have placed is a
   rare thing to want on a form — you are filling in one of each — and it was
   holding a permanent slot in a bar that has to fit on a phone beside the
   controls you reach for every time. */

/* Bring forward / send backward used to live here. Stacking order only ever
   matters when two things overlap, which on a filled-in form is a mistake
   rather than a layout — and the two buttons cost a permanent slot in a bar
   that has to fit on a phone. Items still draw in the order they were made. */

$('#btnStamp').addEventListener('click', () => {
  const it = getSel(); if (!it || it.type !== 'sig') return;
  push();
  const order = ['datetime', 'date', 'none'];
  it.stampMode = order[(order.indexOf(it.stampMode || 'none') + 1) % 3];
  const st = stampOf(it);
  if (it.stampMode === 'none') { if (st) { S.items.splice(S.items.indexOf(st), 1); elOf(st.id)?.remove(); } }
  else if (!st) addStamp(it);
  else { st.date.fmt = it.stampMode === 'date' ? 1 : 3; paintItems(); }
  select(it.id); saveSoon();
});
$('#btnDateFmt').addEventListener('click', () => {
  const it = getSel(); if (!it?.date) return;
  push();
  const cycle = it.link ? STAMP_CYCLE : DATE_CYCLE;
  it.date.fmt = cycle[(cycle.indexOf(it.date.fmt) + 1) % cycle.length];
  paintItems(); select(it.id); saveSoon();
});

/* On a desktop the arrow keys are the obvious way to shift something a hair,
   and the on-screen nudge pad is already the thumb version of exactly that —
   so they share it. They only apply while something is selected and the caret
   is not inside it, which is the guard at the top of this handler: inside a
   text box the arrows still move the caret, as they must.

   Holding an arrow repeats, and a burst of repeats is one undo step rather
   than forty — you meant to move it there once. Shift takes a bigger stride. */
const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
let arrowAt = 0, arrowT0 = 0;

document.addEventListener('keydown', e => {
  if ($('#editor').hidden) return;
  const typing = !!document.activeElement?.isContentEditable ||
                 /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

  const dir = ARROWS[e.key];

  /* While the crop bar is open the arrows belong to the crop: same idea as
     the on-screen pad beside it, and the only way to take a precise slice off
     an edge with a trackpad. Shift strides. */
  if (dir && cropPi >= 0 && !typing) {
    e.preventDefault();
    nudgeCrop(dir, e.shiftKey);
    return;
  }

  /* With the caret inside a text box the arrows belong to the caret, as they
     must. Shift is not otherwise spoken for — there is no ranged selection in
     these boxes worth extending — so Shift means "the arrows are for the
     object, not the words": you can put a line of text exactly where you want
     it without first clicking out of it and back into it.

     A held key goes further per press after about a second, the same way the
     pad on the phone does when you hold a corner down, and one held burst is
     one undo step rather than forty. */
  if (dir && S.sel && !e.metaKey && !e.ctrlKey && !e.altKey && !KB.box &&
      (!typing || e.shiftKey)) {
    e.preventDefault();
    const now = performance.now();
    if (now - arrowAt > 700) { push(); arrowT0 = now; }
    arrowAt = now;
    nudge(dir, now - arrowT0 > 900);
    return;
  }

  if (typing) return;

  if ((e.key === 'Backspace' || e.key === 'Delete') && S.sel) { e.preventDefault(); push(); removeItem(S.sel); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
});

/* ================================================ KEYBOARD FILLING (desktop)
   On a real keyboard the fastest way through a form is Tab, Tab, Tab. So Tab
   walks every place you could plausibly need to write, in reading order:
   fields the document actually declares, blank lines it only implies, and
   empty tick boxes. The implied ones come from the same local pixel scan that
   powers tap-to-snap — the page is measured in this tab, the measurements
   live in memory, and nothing about them is sent or stored anywhere beyond
   the local draft already described on the home screen. */

const KB = { pi: 0, key: null, box: null, el: null, cur: null, at: 0, of: 0 };
const lineKey = (pi, L) => `l:${pi}:${Math.round(L.y * 1e4)}:${Math.round(L.x0 * 1e4)}`;
const boxKey  = (pi, B) => `b:${pi}:${Math.round(B.cy * 1e4)}:${Math.round(B.cx * 1e4)}`;
const cellKey = (pi, C) => `c:${pi}:${Math.round(C.cy * 1e4)}:${Math.round(C.cx * 1e4)}`;

/** Where a form field sits on the page as displayed, 0–1.

    Taken from the PDF's own coordinates rather than the overlay's measured
    box. Measuring the DOM meant the answer depended on the editor being on
    screen — with it hidden every rect came back zero, every field spot
    vanished, and the blank lines underneath got offered in their place. It
    also removes the sub-pixel drift you get from reading a rect mid-scroll. */
function fieldRect(p, f) {
  try {
    const vp = p.page.getViewport({ scale: 1, rotation: totalRot(p) });
    const r = vp.convertToViewportRectangle(f.rect);
    return {
      x0: Math.min(r[0], r[2]) / vp.width, x1: Math.max(r[0], r[2]) / vp.width,
      y0: Math.min(r[1], r[3]) / vp.height, y1: Math.max(r[1], r[3]) / vp.height,
    };
  } catch (_) { return null; }
}

function spotsForPage(pi) {
  const p = S.pageBox[pi];
  if (!p) return [];
  const out = [], rects = [];

  /* Every kind reports `cy` — the middle of where you would actually write —
     and `h`, roughly how tall that writing is. Comparing a field's top edge
     with a rule's baseline and a box's bottom edge, as this used to, put
     things on the same visual row a whole line-height apart and the order
     jumped about. */
  (p.fields || []).forEach((f, i) => {
    const r = fieldRect(p, f);
    if (!r) return;
    rects.push(r);
    out.push({ kind: 'field', page: pi, f, x: r.x0, y: r.y0,
               cy: (r.y0 + r.y1) / 2, h: Math.abs(r.y1 - r.y0),
               key: `f:${pi}:${i}` });
  });

  // a guess is only worth offering where the document did not already declare one
  const free = (x0, y0, x1, y1) =>
    !rects.some(r => x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0);

  pageLines(p).forEach(L => {
    if (!free(L.x0, L.y - L.fs * 1.3, L.x1, L.y + 0.004)) return;
    out.push({ kind: 'line', page: pi, L, x: L.x0, y: L.y,
               cy: L.y - L.fs * 0.38, h: L.fs,      // text sits above the rule
               key: lineKey(pi, L) });
  });
  pageBoxes(p).forEach(B => {
    if (!free(B.x0, B.y0, B.x1, B.y1)) return;
    out.push({ kind: 'box', page: pi, B, x: B.x0, y: B.y1,
               cy: B.cy, h: B.h, key: boxKey(pi, B) });
  });
  pageCells(p).forEach(C => {
    if (!free(C.x0, C.y0, C.x1, C.y1)) return;
    out.push({ kind: 'cell', page: pi, C, x: C.x0, y: C.y1,
               cy: C.cy, h: C.h, key: cellKey(pi, C) });
  });

  /* Reading order: build rows top to bottom, joining anything whose middle is
     within about a line of the row's, then read each row left to right. */
  out.sort((a, b) => a.cy - b.cy || a.x - b.x);
  const rows = [];
  for (const s of out) {
    const r = rows[rows.length - 1];
    const tol = Math.max(0.009, Math.max(r ? r.h : 0, s.h) * 0.8);
    if (r && s.cy - r.cy <= tol) { r.items.push(s); r.h = Math.max(r.h, s.h); }
    else rows.push({ cy: s.cy, h: s.h, items: [s] });
  }
  return rows.flatMap(r => r.items.sort((a, b) => a.x - b.x));
}

/* ================================================ READING THE QUESTIONS
   To lay a form out as a plain list, each blank needs the words that belong
   to it. The PDF already carries its text with positions, so this is
   measurement rather than guesswork: pull the words, glue adjacent ones back
   into phrases, and for every spot take the phrase that reads as its label.

   Forms label things in three places and only three. Beside it on the same
   row — "Phone: ______". Above it — a heading over a ruled blank. And for a
   tick box, to its right — "☐ I agree to the terms". Look in that order.

   A page with no text at all is a scan. Nothing here fails; the blanks are
   simply numbered instead, and stay just as fillable. */

const LABEL_MAX = 78;

/* ------------------------------------------------------------------- OCR
   A scanned page carries no text, so there is nothing to read a label from.
   Tesseract fixes that entirely on the device — but it is seven megabytes, so
   it is fetched only when someone actually opens Simple view on a scan, and
   cached by the service worker afterwards. Everything downstream is unchanged:
   OCR produces the same {text, box} shape the text layer does, so the label
   lookup, the reading order and the cards never learn where the words came
   from. */
const OCR_DIR = 'vendor/ocr/';
const OCR_W = 1700;                    // ~200dpi on Letter; Tesseract wants the pixels
let ocrWorker = null, ocrBooting = null;

async function ocrReady(onNote) {
  if (ocrWorker) return ocrWorker;
  if (ocrBooting) return ocrBooting;
  ocrBooting = (async () => {
    onNote?.('Fetching the text reader (one time)…');
    const mod = await import('./' + OCR_DIR + 'tesseract.esm.min.js');
    const T = mod.default || mod;          // the ESM build exports the namespace as default
    onNote?.('Starting the text reader…');
    ocrWorker = await T.createWorker('eng', 1, {
      workerPath: new URL(OCR_DIR + 'worker.min.js', location.href).href,
      corePath: new URL(OCR_DIR + 'tesseract-core-simd-lstm.js', location.href).href,
      langPath: new URL(OCR_DIR, location.href).href,
      gzip: false,
      legacyCore: false,
      legacyLang: false,
      /* Load the worker from its real URL. Tesseract wraps it in a blob by
         default, and a blob worker has a `blob:` base — so the core's own
         relative fetch for its .wasm has nothing to resolve against and the
         whole thing hangs. */
      workerBlobURL: false,
    });
    return ocrWorker;
  })();
  try { return await ocrBooting; } finally { ocrBooting = null; }
}

/** read one page with OCR, in the same shape the text layer gives */
async function ocrPage(p, onNote) {
  const w = await ocrReady(onNote);
  const cv = document.createElement('canvas');
  try {
    const v0 = p.page.getViewport({ scale: 1, rotation: totalRot(p) });
    const vp = p.page.getViewport({ scale: OCR_W / v0.width, rotation: totalRot(p) });
    cv.width = Math.round(vp.width);
    cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await p.page.render({ canvasContext: ctx, viewport: vp }).promise;
    const res = await w.recognize(cv, {}, { blocks: true });
    const out = [];
    const eat = ln => (ln.words || []).forEach(word => {
      const t = (word.text || '').trim();
      if (!t || (word.confidence ?? 100) < 45) return;
      const b = word.bbox || {};
      out.push({
        s: t,
        x0: b.x0 / cv.width, x1: b.x1 / cv.width,
        cy: ((b.y0 + b.y1) / 2) / cv.height,
        h: Math.max(1, b.y1 - b.y0) / cv.height,
      });
    });
    (res.data.blocks || []).forEach(bl =>
      (bl.paragraphs || []).forEach(pa => (pa.lines || []).forEach(eat)));
    if (!out.length) (res.data.lines || []).forEach(eat);
    return out;
  } finally { cv.width = cv.height = 0; }
}

/** every word on a page, in the same 0–1 display frame as everything else */
/** glue neighbouring words back into the phrase a person would read */
function joinWords(out) {
  out.sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
  const runs = [];
  for (const w of out) {
    const r = runs[runs.length - 1];
    if (r && Math.abs(r.cy - w.cy) < Math.max(r.h, w.h) * 0.6 &&
        w.x0 - r.x1 < Math.max(r.h, w.h) * 1.2 && w.x0 >= r.x0) {
      r.s += (w.x0 - r.x1 > r.h * 0.18 ? ' ' : '') + w.s;
      r.x1 = Math.max(r.x1, w.x1);
    } else runs.push({ ...w });
  }
  return runs;
}

/** the page's words, read with OCR if the document carries none */
async function wordsOrOcr(p, onNote) {
  const w = await pageWords(p);
  if (w.length) return w;
  if (p.ocrKey === 'w' + totalRot(p)) return p.words;
  try {
    p.words = joinWords(await ocrPage(p, onNote));
    p.ocrKey = 'w' + totalRot(p);
  } catch (err) {
    console.warn('OCR unavailable', err);
    p.words = [];
    p.ocrKey = 'w' + totalRot(p);
  }
  return p.words;
}

async function pageWords(p) {
  const key = 'w' + totalRot(p);
  if (p.wordKey === key) return p.words;
  p.wordKey = key;
  p.words = [];
  try {
    const vp = p.page.getViewport({ scale: 1, rotation: totalRot(p) });
    const tc = await p.page.getTextContent();
    const out = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const m = pdfjsLib.Util.transform(vp.transform, it.transform);
      const h = Math.hypot(m[2], m[3]) || 8;
      const w = it.width * Math.hypot(vp.transform[0], vp.transform[1]) || 0;
      out.push({
        s: it.str,
        x0: m[4] / vp.width,
        x1: (m[4] + w) / vp.width,
        cy: (m[5] - h * 0.35) / vp.height,     // middle of the glyphs, not the baseline
        h: h / vp.height,
      });
    }
    p.words = joinWords(out);
  } catch (_) { p.words = []; }
  return p.words;
}

/* OCR has no idea an empty tick box is a control — it sees a small rounded
   shape and reads it as a letter, so labels come back as "O Full-Time" or,
   for a bare grid cell, just "Oo". Strip a leading glyph, and treat a label
   that is nothing but glyphs as no label at all. */
const GLYPHY = /^[\s.·•*O0oQ□◻▢❑☐■\[\]()|]{1,3}$/;
const stripGlyph = t => t.replace(/^[O0oQ□◻▢❑☐\[\]|]{1,2}[\s.·]+/, '');

/** tidy a captured phrase into something that reads as a question */
function tidyLabel(s) {
  let t = stripGlyph((s || '').replace(/\s+/g, ' ').trim());
  if (GLYPHY.test(t)) return '';
  t = t.replace(/[\s._:\-–—]+$/, '');            // trailing colons, dashes, dot leaders
  t = t.replace(/^[\s._:\-–—•*]+/, '');
  if (t.length > LABEL_MAX) t = t.slice(0, LABEL_MAX - 1).replace(/\s\S*$/, '') + '…';
  return t;
}

/** the words belonging to one spot, or null if the page has nothing to read */
function labelFor(words, sp, skipRight) {
  if (!words.length) return null;
  const rowTol = Math.max(0.008, sp.h * 0.9);

  /* A captioned box carries its own label — the words printed inside it,
     above the space left for the answer. Reading them out of the box beats
     every guess below it, because there is nothing to guess: the form has
     already said which words belong to this field. */
  const cap = sp.kind === 'cell' ? sp.C?.cap
            : sp.kind === 'line' ? sp.L?.cap
            : sp.kind === 'box'  ? sp.B?.cap : null;
  if (cap) {
    const said = words
      .filter(r => r.cy > cap.y0 && r.cy < cap.y1 && r.x1 > cap.x0 && r.x0 < cap.x1)
      .sort((a, b) => a.x0 - b.x0)
      .map(r => r.s).join(' ');
    /* Two rules can share one caption — "Height ____ ft. ____ in." — and then
       the caption alone names them both. The unit printed just past the rule
       is what tells them apart, so keep it. */
    let unit = '';
    if (sp.kind === 'line' && sp.L) {
      for (const r of words) {
        if (Math.abs(r.cy - sp.cy) > rowTol) continue;
        const d = r.x0 - sp.L.x1;
        if (d < -0.004 || d > 0.025) continue;
        const s = r.s.trim();
        if (s.length <= 5 && /[A-Za-z]/.test(s)) { unit = s; break; }
      }
    }
    const t = tidyLabel(unit ? `${said} ${unit}` : said);
    if (t) return t;
  }

  // a tick box is labelled to its right, and nothing else comes close
  const ticky = !skipRight && (sp.kind === 'box' ||
    (sp.kind === 'field' && (sp.f?.type === 'check' || sp.f?.type === 'radio')));
  if (ticky) {
    let best = null, bd = 0.10;
    for (const r of words) {
      if (Math.abs(r.cy - sp.cy) > rowTol) continue;
      if (GLYPHY.test(r.s.trim())) continue;        // that is the box itself
      const d = r.x0 - sp.x;
      if (d < -0.004 || d > bd) continue;
      bd = d; best = r;
    }
    /* OCR does not know a tick box is a control: it sees a small square and
       reads it as letters, then runs them into the label beside it — "Renewal"
       comes back as "OC Renewal", "REAL ID" as "CJ REAL ID". Spelling cannot
       settle which prefixes are junk without eating real ones ("Do you…", "ID
       Number"), but geometry can: only strip when the captured word actually
       overlaps the box we detected. */
    const bx1 = sp.B ? sp.B.x1 : sp.x;
    const t = best && tidyLabel(
      best.x0 < bx1 - 0.001 ? best.s.replace(/^\s*\S{1,2}(?=\s)/, '') : best.s);
    if (t) return t;
  }

  /* Beside it, on the same row. How far apart two things can be and still
     count as one row has to allow for the label's own size: a blank sized at
     the bottom of the clamp gets a hair-thin tolerance, and then "Signature:"
     misses the line drawn right next to it and the field ends up named after
     a stray phrase from the paragraph above. */
  let best = null, bd = 0.30;
  for (const r of words) {
    if (Math.abs(r.cy - sp.cy) > Math.max(rowTol, (r.h || 0) * 0.8)) continue;
    const d = sp.x - r.x1;
    if (d < -0.004 || d > bd) continue;
    bd = d; best = r;
  }
  if (best) return tidyLabel(best.s);

  /* Above it. A row of blanks shares one row of headings, so height alone
     ties — "State" and "ZIP code" sit at exactly the same distance. Score
     horizontal distance too, or every blank in the row takes the last
     heading it saw. */
  let ab = null, best2 = Infinity;
  for (const r of words) {
    const dy = sp.cy - r.cy;
    if (dy <= 0 || dy > 0.055) continue;
    if (r.x1 < sp.x - 0.02 || r.x0 > sp.x + 0.35) continue;
    const score = dy + Math.abs(r.x0 - sp.x) * 0.6;
    if (score < best2) { best2 = score; ab = r; }
  }
  return ab ? tidyLabel(ab.s) : '';
}

/** every spot in the document, in reading order, with its question */
async function readQuestions(opts = {}) {
  const out = [];
  let seen = 0;
  for (let pi = 0; pi < S.pageBox.length; pi++) {
    const p = S.pageBox[pi];
    await ensureScan(p);
    const words = opts.ocr
      ? await wordsOrOcr(p, n => opts.note?.(n, pi + 1, S.pageBox.length))
      : await pageWords(p);
    seen += words.length;
    for (const sp of spotsForPage(pi)) {
      out.push({
        ...sp,
        label: labelFor(words, sp),
        // what a *group* of buttons is asking, as opposed to one button's own text
        askLabel: labelFor(words, sp, true),
      });
    }
  }
  // no readable text anywhere means a scan, not a page that happens to be bare
  const scanned = seen === 0;
  out.forEach((q, i) => {
    q.n = i + 1;
    if (!q.label) q.label = `Blank ${i + 1}`;
    q.sign = /\bsign(ature|ed)?\b/i.test(q.label) && q.kind !== 'box';
    q.dateish = /\bdate\b|\bd\.?o\.?b\.?\b|birth/i.test(q.label) && q.kind !== 'box';
  });
  return { questions: out, scanned };
}

/* ============================================== TAPPABLE BLANKS
   A declared form field shows you where to type. A blank line does not — so
   draw one. Every line the scan finds gets a faint box sitting on it, which
   makes the guess visible and gives you something to aim at: tap it and you
   are typing, no need to reach for the Text tool first. The Text tool still
   places a box anywhere you like.

   The boxes are decoration only — `pointer-events: none` — because the page
   already owns the gesture. Letting them take it would break scrolling. */

/** where you would write on this line, 0-1 in the page's display frame */
const hintRect = L => {
  /* Never grow up into whatever is printed above — see clearAbove(). */
  const room = L.clr != null ? Math.max(L.clr * 0.9, L.fs * 0.6) : L.fs * 1.45;
  return {
    x0: L.x0, x1: L.x1,
    y0: L.y - Math.min(L.fs * 1.45, room), y1: L.y + 0.002,
  };
};

function placeHint(p, h) {
  const rot = totalRot(p);
  const [Wl, Hl] = localDims(p.lw, p.lh, rot);
  const [ux, uy] = unrotXY(rot, h.r.x0, h.r.y0);
  const st = h.el.style;
  st.left = (ux * p.lw) + 'px';
  st.top = (uy * p.lh) + 'px';
  st.width = ((h.r.x1 - h.r.x0) * Wl) + 'px';
  st.height = ((h.r.y1 - h.r.y0) * Hl) + 'px';
  st.transform = rot ? `rotate(${-norm4(rot)}deg)` : '';
}

function paintHints() {
  hotHint = null;                    // the element it pointed at is about to go
  S.pageBox.forEach((p, pi) => {
    p.layer.querySelectorAll('.linehint').forEach(e => e.remove());
    p.hints = [];
    if (!S.pdf || !p.scanKey) return;
    for (const spot of spotsForPage(pi)) {
      if (spot.kind !== 'line' && spot.kind !== 'cell') continue;
      // once something is on the line, the thing itself is the target
      if (S.items.some(i => i.page === pi && i.lineKey === spot.key)) continue;
      const el = document.createElement('div');
      el.className = spot.kind === 'cell' ? 'linehint is-cell' : 'linehint';
      const h = { L: spot.L, C: spot.C, kind: spot.kind, key: spot.key,
                  r: spot.kind === 'cell'
                    ? { x0: spot.C.x0, x1: spot.C.x1, y0: spot.C.y0, y1: spot.C.y1 }
                    : hintRect(spot.L),
                  el };
      placeHint(p, h);
      p.layer.append(el);
      p.hints.push(h);
    }
  });
}
function layoutHints() {
  S.pageBox.forEach(p => (p.hints || []).forEach(h => placeHint(p, h)));
}
let hintsT;
function hintsSoon() { clearTimeout(hintsT); hintsT = setTimeout(paintHints, 40); }

/** the tappable blank under a point, if any */
function findHint(p, x, y, pad = 0.003) {
  for (const h of p.hints || []) {
    if (x >= h.r.x0 - pad && x <= h.r.x1 + pad &&
        y >= h.r.y0 - pad && y <= h.r.y1 + pad) return h;
  }
  return null;
}

/* ------------------------------------------------------ hover (mouse only)

   A blank is drawn where the scan believes it is, and that is not always
   where you would have drawn it: a rule can start a word further right than
   its caption suggests, and two blanks on one line can split in a place you
   would not have picked. Under a mouse the pointer already says what you are
   considering, so the thing beneath it lights up and shows you its real
   extent — before you click, rather than after you have typed into it.

   Tick boxes have no marker of their own (a page of outlined squares does not
   need outlining again), so hovering one borrows a marker that follows the
   pointer around. Touch gets none of this: a finger has no hover, and lighting
   something up at the moment it is tapped is just a flicker. */
const hotEl = document.createElement('div');
hotEl.className = 'boxhot';
let hotHint = null;

function clearHover() {
  if (hotHint) { hotHint.el?.classList.remove('hot'); hotHint = null; }
  hotEl.remove();
  $('#editor').classList.remove('overspot');
}

function hoverSpot(e) {
  if (e.pointerType && e.pointerType !== 'mouse') return;
  if (!$('#editor') || $('#editor').hidden || S.tool || pendingSig) return clearHover();
  const pageEl = e.target.closest?.('.page');
  if (!pageEl || e.target.closest('.it') || e.target.closest('.fld')) return clearHover();
  const p = S.pageBox[+pageEl.dataset.i];
  if (!p) return clearHover();
  const r = pageEl.getBoundingClientRect();
  if (!r.width || !r.height) return clearHover();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;

  const B = findBox(p, x, y, 0.002);
  if (B) {
    if (hotHint) { hotHint.el?.classList.remove('hot'); hotHint = null; }
    if (hotEl.parentNode !== p.layer) p.layer.append(hotEl);
    placeHint(p, { el: hotEl, r: { x0: B.x0, x1: B.x1, y0: B.y0, y1: B.y1 } });
    $('#editor').classList.add('overspot');
    return;
  }
  hotEl.remove();

  const h = findHint(p, x, y);
  if (h !== hotHint) {
    hotHint?.el?.classList.remove('hot');
    hotHint = h || null;
    hotHint?.el?.classList.add('hot');
  }
  $('#editor').classList.toggle('overspot', !!h);
}

stageEl.addEventListener('pointermove', hoverSpot);
stageEl.addEventListener('pointerleave', clearHover);
stageEl.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') clearHover(); });
stageEl.addEventListener('scroll', clearHover, { passive: true });

/** Start typing in a table cell. The text is centred in the box rather than
    resting on a rule, because that is what a person writing in a table does
    and what makes the finished page look right. */
function textInCell(pi, C, key, focus = true) {
  const p = S.pageBox[pi];
  let it = S.items.find(i => i.page === pi && i.lineKey === key);
  if (!it) {
    /* Fill the cell, but only up to the size a person writes at — a tall
       cell is a tall cell, not an instruction to write in 24pt. The cell
       still caps it downwards so the writing cannot outgrow its own box. */
    const fs = Math.max(0.0085, Math.min(fsFit(p, C.h * 0.52), C.h * 0.62));
    it = { id: uid(), page: pi, rot: totalRot(p), type: 'text',
           x: C.x0, y: clamp(C.cy - fs * 0.62, 0, .99),
           fs, color: COLORS[0], text: '', lineKey: key,
           cell: { x0: C.x0, x1: C.x1, y0: C.y0, y1: C.y1 } };
    push(); S.items.push(it); itemEl(it); saveSoon();
  }
  select(it.id);
  markSpot(pi, key);
  hintsSoon();
  if (focus) { const d = elOf(it.id); if (d) edit(d); }
  return it;
}

/** start typing on a line — from a tap, from Tab, or from the Next button */
function textOnLine(pi, L, key, focus = true) {
  const p = S.pageBox[pi];
  let it = S.items.find(i => i.page === pi && i.lineKey === key);
  if (!it) {
    const rot = totalRot(p), fs = L.fs;
    it = { id: uid(), page: pi, rot, type: 'text',
           x: clamp(L.x0 + 0.006, 0, .97),
           y: clamp(L.y - fs * (BASELINE + 0.06), 0, .99),
           fs, color: COLORS[0], text: '', lineKey: key };
    push(); S.items.push(it); itemEl(it); flashLine(p, L); saveSoon();
  }
  select(it.id);
  markSpot(pi, key);
  hintsSoon();
  if (focus) { const d = elOf(it.id); if (d) edit(d); }
  return it;
}

/** A press on a blank might be the start of a scroll. Wait for the release
    and only treat it as a tap if the finger stayed put. */
function armHintTap(e, pi, hint) {
  onTap(e, () => {
    if (hint.kind === 'cell') textInCell(pi, hint.C, hint.key);
    else textOnLine(pi, hint.L, hint.key);
  });
}

/** Move the cursor onto a spot the user just acted on, so Next carries on
    from there. A bare tap on the page deliberately does not do this — it
    should leave you where you were. */
function markSpot(pi, key) {
  const list = spotsForPage(pi);
  const i = list.findIndex(s => s.key === key);
  if (i < 0) return;
  KB.pi = pi; KB.key = key; KB.at = i + 1; KB.of = list.length; KB.cur = list[i];
  syncJump();
  revealSpot();
}

async function spotsOf(pi) {
  const p = S.pageBox[pi];
  if (!p) return [];
  await ensureScan(p);
  return S.pageBox[pi] === p ? spotsForPage(pi) : [];   // document may have closed mid-scan
}

async function moveSpot(dir) {
  if (!S.pdf || !S.pageBox.length) return;
  const n = S.pageBox.length;
  let pi = clamp(KB.pi || 0, 0, n - 1);
  let list = await spotsOf(pi);
  const ix = KB.key ? list.findIndex(s => s.key === KB.key) : -1;
  let next = ix < 0 ? (dir > 0 ? 0 : list.length - 1) : ix + dir;

  for (let hop = 0; hop <= n; hop++) {
    if (next >= 0 && next < list.length) {
      const s = list[next];
      KB.pi = pi; KB.key = s.key; KB.at = next + 1; KB.of = list.length;
      return enterSpot(s);
    }
    pi = (pi + dir + n) % n;
    list = await spotsOf(pi);
    next = dir > 0 ? 0 : list.length - 1;
  }
  toast('Nothing obvious to fill in here — use the toolbar to add a text box.', 3200);
}

/* ============================================== KEEPING THE BARS ON SCREEN
   An on-screen keyboard is handled two different ways. Chrome honours
   `interactive-widget=resizes-content` in the viewport meta and shrinks the
   layout viewport, so the flex column simply gets shorter and every bar stays
   put. Safari does not: it leaves the layout viewport alone, shrinks the
   *visual* viewport and scrolls it, which slides a fixed element's top edge
   off the screen — taking Back / Next with it. So follow the visual viewport
   directly and keep the editor inside whatever is actually visible. */
const vp = window.visualViewport;

function fitViewport() {
  const v = window.visualViewport;
  const ed = $('#editor');
  if (!v || !ed) return;
  if (ed.hidden) { ed.style.height = ''; ed.style.top = ''; ed.classList.remove('kb'); return; }

  /* Pinch to zoom shrinks the visual viewport too, and it is not a keyboard.
     Sizing the editor to it then means zooming in makes the page smaller: the
     editor collapses to a fraction of its height, the stage collapses with
     it, and the next re-fit renders the page at that fraction of its width —
     you zoom in to read a line and the whole document shrinks away from you.
     While the page is scaled, leave the layout alone and let the browser pan
     over it, which is what zoom is for. */
  if (v.scale > 1.01) {
    ed.style.height = ''; ed.style.top = '';
    ed.classList.remove('kb');
    return;
  }
  ed.style.height = v.height + 'px';
  ed.style.top = v.offsetTop + 'px';

  /* Two ways to know a keyboard is up. Safari leaves the layout viewport
     alone, so a big gap between the two heights gives it away. Chrome
     resizes the layout viewport instead, which closes that gap — there,
     something editable having focus on a touch device is the signal. */
  const shrunk = window.innerHeight - v.height > 150;
  const ae = document.activeElement;
  const typing = !HAS_KEYBOARD && !!ae && ed.contains(ae) &&
    (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
  ed.classList.toggle('kb', shrunk || typing);
  syncRail();
}

/* The keyboard finishes arriving after the focus event that summoned it, so
   check again once the visible strip has actually settled. */
let revealT;
const revealSoon = () => { clearTimeout(revealT); revealT = setTimeout(revealFocused, 140); };

if (vp) {
  vp.addEventListener('resize', () => { fitViewport(); revealSoon(); });
  vp.addEventListener('scroll', fitViewport);
  window.addEventListener('orientationchange', () => setTimeout(fitViewport, 250));
}
// focus and blur move the keyboard; the viewport event can lag behind them
document.addEventListener('focusin', () => setTimeout(() => { fitViewport(); revealFocused(); }, 90), true);
document.addEventListener('focusout', () => setTimeout(fitViewport, 60), true);

/* ---------------------------------------------------------- the jump bar */
const SPOT_LABEL = { field: 'Form field', line: 'Blank line', box: 'Tick this box', cell: 'Table cell' };

function syncJump() {
  const s = KB.cur;
  const mid = $('#btnSpotAct'), lab = $('#spotLabel');
  const onBox = !!KB.box;
  mid.classList.toggle('is-act', onBox);
  lab.textContent = onBox ? 'Tick this box'
    : s ? `${SPOT_LABEL[s.kind]} · ${KB.at} of ${KB.of}`
    : 'Jump to the next blank';
}

$('#btnPrevSpot').addEventListener('click', () => moveSpot(-1));
$('#btnNextSpot').addEventListener('click', () => moveSpot(1));
$('#btnSpotAct').addEventListener('click', () => {
  if (KB.box) return bumpBox();
  if (!KB.cur) return void moveSpot(1);
  enterSpot(KB.cur);                                   // put me back where I was
});

/* Back / Next and Tab are the only things that move the page, because they
   are the only things where you asked to be taken somewhere. */
async function enterSpot(s) {
  const p = S.pageBox[s.page];
  clearBoxCursor();
  KB.cur = s;
  KB.nav = true;
  try { return await enterSpotInner(s, p); } finally { KB.nav = false; }
}
async function enterSpotInner(s, p) {

  if (s.kind === 'field') {
    select(null);
    scrollToSpot(p, s.x, s.cy, s.h);
    s.f.el?.focus({ preventScroll: true });
    if (s.f.type === 'text' && s.f.el?.setSelectionRange) {
      const v = s.f.el.value.length;
      try { s.f.el.setSelectionRange(v, v); } catch (_) {}
    }
    syncJump();
    return;
  }

  if (s.kind === 'line' || s.kind === 'cell') {
    const it = s.kind === 'cell'
      ? textInCell(s.page, s.C, s.key, false)
      : textOnLine(s.page, s.L, s.key, false);
    scrollToSpot(p, s.x, s.cy, s.h);
    const d = elOf(it.id);
    if (d) edit(d);
    syncJump();
    return;
  }

  // a tick box: highlight it and wait for Enter or the bar's tick button
  select(null);
  blurActive();
  KB.box = s;
  paintBoxCursor(p, s.B);
  scrollToSpot(p, s.B.cx, s.B.cy, s.B.h);
  focusStage();
  syncJump();
}

/* Put the thing you are filling in the middle of what you can actually see.
   The stage is already sized to the visible viewport, so with a keyboard up
   its middle is the middle of the strip above the keyboard. */
function scrollToSpot(p, x, cy, h = 0) {
  const view = stageEl.clientHeight;
  const top = p.el.offsetTop + (cy * p.dh) - view / 2 + (h * p.dh) / 2;
  const max = Math.max(0, stageEl.scrollHeight - view);
  const want = clamp(top, 0, max);
  if (Math.abs(want - stageEl.scrollTop) > 6) stageEl.scrollTo({ top: want, behavior: 'smooth' });
  const maxX = Math.max(0, stageEl.scrollWidth - stageEl.clientWidth);
  if (maxX > 2) {
    stageEl.scrollLeft = clamp(p.el.offsetLeft + x * p.dw - stageEl.clientWidth * 0.4, 0, maxX);
  }
}
/* When you tapped the thing yourself you are already looking at it, and
   moving the page under your finger is disorienting — you lose your place
   mid-sentence. So do nothing unless the spot is genuinely out of sight,
   which really happens when a keyboard opens over it, and then scroll by the
   least that brings it back rather than re-centring the whole page. */
/* Bring a rectangle inside the visible strip by the least that does it, and
   without touching the zoom. Both axes matter: zoomed in, the thing you just
   tapped is as easily off to the side as under the keyboard. */
function revealRect(top, bot, left, right) {
  const vh = stageEl.clientHeight, vw = stageEl.clientWidth;
  const padY = Math.min(56, vh * 0.12), padX = Math.min(40, vw * 0.12);
  let by = 0, bx = 0;
  if (top < padY) by = top - padY;
  else if (bot > vh - padY) by = Math.min(bot - (vh - padY), top - padY);
  if (left < padX) bx = left - padX;
  else if (right > vw - padX) bx = Math.min(right - (vw - padX), left - padX);
  if (Math.abs(by) < 4 && Math.abs(bx) < 4) return;
  stageEl.scrollTo({
    top: clamp(stageEl.scrollTop + by, 0, Math.max(0, stageEl.scrollHeight - vh)),
    left: clamp(stageEl.scrollLeft + bx, 0, Math.max(0, stageEl.scrollWidth - vw)),
    behavior: 'smooth',
  });
}

function revealSpot() {
  const s = KB.cur;
  if (KB.nav || !s || $('#editor').hidden) return;   // Back / Next is already moving us
  const p = S.pageBox[s.page];
  if (!p) return;
  const top = p.el.offsetTop + (s.cy - s.h / 2) * p.dh - stageEl.scrollTop;
  const left = p.el.offsetLeft + s.x * p.dw - stageEl.scrollLeft;
  revealRect(top, top + Math.max(s.h * p.dh, 24), left, left + 24);
}

/* Whatever you are actually typing into, kept above the keyboard. Working
   from the focused element rather than from the cursor's spot covers the box
   you just double tapped into, which belongs to no spot at all — it is
   wherever you put your finger, and that is exactly where you want to be
   looking. */
function revealFocused() {
  if (KB.nav || $('#editor').hidden) return;
  const ae = document.activeElement;
  if (!ae || !pagesEl.contains(ae)) return void revealSpot();
  const r = ae.getBoundingClientRect();
  const s = stageEl.getBoundingClientRect();
  if (!r.width && !r.height) return;
  revealRect(r.top - s.top, r.bottom - s.top, r.left - s.left, r.right - s.left);
  /* Pinched in, the stage is bigger than the window onto it, so scrolling the
     stage can leave the box outside what you can actually see. Ask the browser
     to pan its own viewport too — it is the only thing that can. */
  const v = window.visualViewport;
  if (v && v.scale > 1.01) {
    try { ae.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch (_) {}
  }
}

function paintBoxCursor(p, B) {
  const rot = totalRot(p);
  const [Wl, Hl] = localDims(p.lw, p.lh, rot);
  const [ux, uy] = unrotXY(rot, B.x0, B.y0);
  const el = document.createElement('div');
  el.className = 'boxcursor';
  el.style.left = (ux * p.lw) + 'px';
  el.style.top = (uy * p.lh) + 'px';
  el.style.width = (B.w * Wl) + 'px';
  el.style.height = (B.h * Hl) + 'px';
  el.style.transform = rot ? `rotate(${-norm4(rot)}deg)` : '';
  p.layer.append(el);
  KB.el = el;
  $('#kbhint').hidden = false;
}
function clearBoxCursor() {
  KB.el?.remove();
  KB.el = null; KB.box = null;
  const h = $('#kbhint');
  if (h) h.hidden = true;
}
function leaveSpot() {
  clearBoxCursor();
  if (KB.cur?.kind === 'box') KB.cur = null;   // the highlight is gone, so is the label
  syncJump();
}

/** Enter on a highlighted tick box: X, then a check, then clear again */
function bumpBox() {
  const s = KB.box;
  if (!s) return;
  cycleBox(s.page, s.B, 'x', false);
  select(null);
  focusStage();
}

const blurActive = () => {
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae !== stageEl) ae.blur?.();
};
const focusStage = () => { try { stageEl.focus({ preventScroll: true }); } catch (_) {} };

/** Tab belongs to the document only while the user is actually in it */
function tabIsOurs() {
  if (KB.box) return true;
  const ae = document.activeElement;
  if (!ae || ae === document.body) return false;
  return ae === stageEl || stageEl.contains(ae);
}

document.addEventListener('keydown', e => {
  if ($('#editor').hidden || !$('#done').hidden) return;
  if ($$('.sheet-wrap').some(s => !s.hidden)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === 'Tab' && tabIsOurs()) {
    e.preventDefault();
    moveSpot(e.shiftKey ? -1 : 1);
    return;
  }

  if (e.key === 'Enter') {
    const ae = document.activeElement;
    if (ae?.tagName === 'TEXTAREA') return;                        // multi-line field: newline
    if (ae?.classList?.contains('fld-check') || ae?.classList?.contains('fld-radio')) return;
    if (KB.box) { e.preventDefault(); return bumpBox(); }
    if (ae?.isContentEditable || ae?.tagName === 'INPUT' || ae?.tagName === 'SELECT') {
      if (!stageEl.contains(ae)) return;
      e.preventDefault();
      return void moveSpot(1);
    }
    const it = getSel();
    if (it && isMark(it)) {
      e.preventDefault(); push();
      it.type = it.type === 'x' ? 'check' : 'x';
      paintItems(); select(it.id); saveSoon();
    }
    return;
  }

  if (e.key === 'Escape') {
    if (KB.box) { clearBoxCursor(); focusStage(); return; }
    if (stageEl.contains(document.activeElement) || document.activeElement === stageEl) {
      blurActive(); KB.key = null;
      $('#btnFinish').focus();
    }
  }
}, true);

// tapping the page hands the keyboard back to the document
stageEl.addEventListener('pointerdown', e => {
  if (!e.isPrimary || KB.box) return;
  leaveSpot();
});

/* ================================================================ ROTATE */
function currentPage() {
  const mid = stageEl.scrollTop + stageEl.clientHeight / 2;
  let best = 0, bd = Infinity;
  S.pageBox.forEach((p, i) => {
    const c = p.el.offsetTop + p.dh / 2;
    if (Math.abs(c - mid) < bd) { bd = Math.abs(c - mid); best = i; }
  });
  return best;
}
/* Rotate is a verb you repeat, not a value you pick. Four buttons offering
   90, 180, 270 and "original" made you work out which one you wanted from a
   page that was already sideways; two arrows let you press until it looks
   right, and press the other way if you overshoot. The bar sits over the
   tools rather than in a sheet, so the page stays in view while you turn it. */
function openRotate() {
  select(null);
  closeCrop(); closePen();
  $('#rotbar').dataset.page = currentPage();
  $('#rotbar').hidden = false;
  $('#editor').classList.add('busytool');
  labelRot();
  revealPage(+$('#rotbar').dataset.page);
}
function closeRotate() {
  $('#rotbar').hidden = true;
  $('#editor').classList.remove('busytool');
}
function labelRot() {
  const i = +$('#rotbar').dataset.page;
  const n = S.pageBox.length;
  $('#rotHint').textContent = n > 1 ? `Page ${i + 1} of ${n}` : 'This page';
}
function turn(by) {
  const all = $('#rotAll').checked;
  const i = +$('#rotbar').dataset.page;
  const p0 = S.pageBox[i];
  if (!p0) return;
  push();
  const to = norm4(p0.userRot + by);
  (all ? S.pageBox : [p0]).forEach(p => {
    p.userRot = all ? norm4(p.userRot + by) : to;
    p.renderKey = null;
  });
  layoutPages(); renderVisible(); hintsSoon(); saveSoon();
}
$('#rotCCW').addEventListener('click', () => turn(-90));
$('#rotCW').addEventListener('click', () => turn(90));
$('#rotDone').addEventListener('click', closeRotate);

/* ============================================================== SIGNATURE */
const sigSheet = $('#sigSheet');
const pad = $('#pad');
let padCtx, strokes = [], cur = null, sigColor = COLORS[0], sigTab = 'draw';
let typedFont = 'Caveat', photoBmp = null, photoOut = null, pen = 2.6;

const FONTS = [
  { name: 'Caveat', stack: `'FS Caveat', 'Segoe Script', 'Bradley Hand', cursive` },
  { name: 'Dancing', stack: `'FS Dancing', 'Snell Roundhand', 'Brush Script MT', cursive` },
];

function openSig() {
  sigSheet.hidden = false;
  $('#penPad').value = pen;
  $('#penWrapSheet').hidden = sigTab === 'photo';
  setupPad(); drawFontOptions(); refreshSaved(); updateUse();
}
$$('[data-close]').forEach(b => b.addEventListener('click', () => { b.closest('.sheet-wrap').hidden = true; }));
$$('.tab').forEach(t => t.addEventListener('click', () => {
  sigTab = t.dataset.tab;
  $$('.tab').forEach(x => x.classList.toggle('is-on', x === t));
  $$('.pane').forEach(p => (p.hidden = p.dataset.pane !== sigTab));
  $('#penWrapSheet').hidden = sigTab === 'photo';
  updateUse();
}));
$('#penPad').addEventListener('input', e => {
  pen = +e.target.value;
  redrawPad();
  drawFontOptions();
});
$$('[data-sigcolor]').forEach(b => b.addEventListener('click', () => {
  sigColor = b.dataset.sigcolor;
  $$('[data-sigcolor]').forEach(x => x.classList.toggle('is-on', x === b));
  redrawPad(); drawFontOptions(); if (photoBmp) processPhoto();
}));

function setupPad() {
  const r = pad.getBoundingClientRect();
  const dpr = clamp(devicePixelRatio || 1, 1, 3);
  pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr);
  padCtx = pad.getContext('2d'); padCtx.scale(dpr, dpr);
  redrawPad();
}
const padPt = e => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
pad.addEventListener('pointerdown', e => {
  e.preventDefault(); pad.setPointerCapture(e.pointerId);
  cur = [padPt(e)]; strokes.push(cur); $('#padHint').hidden = true;
});
pad.addEventListener('pointermove', e => { if (!cur) return; e.preventDefault(); cur.push(padPt(e)); redrawPad(); });
['pointerup', 'pointercancel', 'pointerleave'].forEach(t =>
  pad.addEventListener(t, () => { if (cur) { cur = null; updateUse(); } }));

function redrawPad() { if (!padCtx) return; padCtx.clearRect(0, 0, pad.width, pad.height); strokeAll(padCtx, strokes, sigColor, pen); }
function strokeAll(ctx, sts, color, w) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = color; ctx.lineWidth = w;
  sts.forEach(s => {
    if (s.length < 2) { ctx.beginPath(); ctx.arc(s[0][0], s[0][1], w / 2, 0, 7); ctx.fillStyle = color; ctx.fill(); return; }
    ctx.beginPath(); ctx.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length - 1; i++) {
      ctx.quadraticCurveTo(s[i][0], s[i][1], (s[i][0] + s[i + 1][0]) / 2, (s[i][1] + s[i + 1][1]) / 2);
    }
    ctx.lineTo(s.at(-1)[0], s.at(-1)[1]);
    ctx.stroke();
  });
}
$('#padClear').addEventListener('click', () => { strokes = []; redrawPad(); $('#padHint').hidden = false; updateUse(); });

function drawFontOptions() {
  const wrap = $('#fontPick');
  const name = $('#typeName').value.trim() || 'Your Name';
  wrap.innerHTML = '';
  FONTS.forEach(f => {
    const b = document.createElement('button');
    b.className = 'fontopt' + (typedFont === f.name ? ' is-on' : '');
    b.style.fontFamily = f.stack; b.style.color = sigColor; b.textContent = name;
    const extra = (pen - 2.6) * 0.42;
    b.style.webkitTextStroke = extra > 0 ? `${extra.toFixed(2)}px ${sigColor}` : '';
    b.onclick = () => { typedFont = f.name; drawFontOptions(); updateUse(); };
    wrap.append(b);
  });
}
$('#typeName').addEventListener('input', () => { drawFontOptions(); updateUse(); });

$('#photoPick').addEventListener('click', () => $('#photoInput').click());
$('#photoInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  busy(true, 'Reading image…');
  try {
    photoBmp = await createImageBitmap(f);
    $('#photoPrev').hidden = false; $('#thrWrap').hidden = false;
    processPhoto();
  } catch (_) { toast('That image could not be read.'); }
  finally { busy(false); }
});
$('#thr').addEventListener('input', () => processPhoto());

function processPhoto() {
  if (!photoBmp) return;
  const sc = Math.min(1, 1400 / Math.max(photoBmp.width, photoBmp.height));
  const w = Math.round(photoBmp.width * sc), h = Math.round(photoBmp.height * sc);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(photoBmp, 0, 0, w, h);
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  const hi = (+$('#thr').value / 100) * 255, lo = hi * 0.62;
  const col = [parseInt(sigColor.slice(1, 3), 16), parseInt(sigColor.slice(3, 5), 16), parseInt(sigColor.slice(5, 7), 16)];
  let minX = w, minY = h, maxX = 0, maxY = 0, ink = 0;
  for (let i = 0, px = 0; i < d.length; i += 4, px++) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const a = lum >= hi ? 0 : lum <= lo ? 255 : Math.round(255 * (hi - lum) / (hi - lo));
    d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = a;
    if (a > 40) {
      ink++;
      const x = px % w, y = (px / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  ctx.putImageData(im, 0, 0);
  if (!ink) { photoOut = null; $('#photoImg').src = c.toDataURL(); updateUse(); return; }
  const q = Math.round(Math.max(w, h) * 0.01);
  minX = Math.max(0, minX - q); minY = Math.max(0, minY - q);
  maxX = Math.min(w - 1, maxX + q); maxY = Math.min(h - 1, maxY + q);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const c2 = document.createElement('canvas'); c2.width = cw; c2.height = ch;
  c2.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch);
  photoOut = c2.toDataURL('image/png');
  $('#photoImg').src = photoOut;
  updateUse();
}

function updateUse() {
  const ok = sigTab === 'draw' ? strokes.length > 0
    : sigTab === 'type' ? $('#typeName').value.trim().length > 0 : !!photoOut;
  $('#sigUse').disabled = !ok;
}

function trimCanvas(c) {
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (data[(y * c.width + x) * 4 + 3] > 12) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return c;
  const q = Math.round(Math.max(c.width, c.height) * 0.02);
  minX = Math.max(0, minX - q); minY = Math.max(0, minY - q);
  maxX = Math.min(c.width - 1, maxX + q); maxY = Math.min(c.height - 1, maxY + q);
  const o = document.createElement('canvas');
  o.width = maxX - minX + 1; o.height = maxY - minY + 1;
  o.getContext('2d').drawImage(c, minX, minY, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}

/* Everything needed to redraw a signature at a different weight later. */
function currentGen() {
  if (sigTab === 'draw') {
    const r = pad.getBoundingClientRect();
    return { kind: 'draw', strokes: strokes.map(st => st.map(pt => [Math.round(pt[0] * 10) / 10, Math.round(pt[1] * 10) / 10])),
             w: r.width, h: r.height, color: sigColor, pen };
  }
  if (sigTab === 'type') {
    return { kind: 'type', name: $('#typeName').value.trim(), font: typedFont, color: sigColor, pen };
  }
  return null;                        // photos are not regenerable
}

async function renderSig(gen) {
  if (!gen) return null;
  if (gen.kind === 'draw') {
    const K = 3;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(gen.w * K)); c.height = Math.max(1, Math.round(gen.h * K));
    const ctx = c.getContext('2d'); ctx.scale(K, K);
    strokeAll(ctx, gen.strokes, gen.color, gen.pen);
    return trimCanvas(c).toDataURL('image/png');
  }
  const f = FONTS.find(x => x.name === gen.font) || FONTS[0];
  try { await document.fonts.load(`64px ${f.stack.split(',')[0]}`, gen.name); } catch (_) {}
  const size = 150;
  const m = document.createElement('canvas').getContext('2d');
  m.font = `${size}px ${f.stack}`;
  const c = document.createElement('canvas');
  c.width = Math.ceil(m.measureText(gen.name).width) + size;
  c.height = Math.round(size * 2.1);
  const ctx = c.getContext('2d');
  ctx.font = `${size}px ${f.stack}`;
  ctx.fillStyle = gen.color; ctx.strokeStyle = gen.color;
  ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.fillText(gen.name, size / 2, c.height / 2);
  const extra = (gen.pen - 2.6) * 2.4;                 // weight beyond the natural stroke
  if (extra > 0) { ctx.lineWidth = extra; ctx.strokeText(gen.name, size / 2, c.height / 2); }
  return trimCanvas(c).toDataURL('image/png');
}

async function buildSignature() {
  if (sigTab === 'photo') return photoOut;
  return renderSig(currentGen());
}

async function armSignature(src, withStamp, gen) {
  const img = new Image(); img.src = src; await img.decode();
  pendingSig = { src, ar: img.height / img.width, stamp: withStamp, gen: gen || null };
  sigSheet.hidden = true;
  S.tool = null; reflectTool();
}
$('#sigUse').addEventListener('click', async () => {
  busy(true, 'Preparing…');
  try {
    const src = await buildSignature();
    if (!src) return;
    if (simSignTarget) {
      const t = simSignTarget; simSignTarget = null;
      const img = new Image(); img.src = src; await img.decode();
      sigSheet.hidden = true;
      const old = simSigItem(t.q);
      if (old) removeItem(old.id);
      const it = placeSigOnLine(t.q.page, t.q.L, {
        src, ar: img.height / img.width, stamp: $('#sigStamp').checked, gen: currentGen(),
      });
      it.sigLine = t.q.key;
      t.paint();
    } else {
      await armSignature(src, $('#sigStamp').checked, currentGen());
    }
    await rememberSig(src);
  } finally { busy(false); }
});

async function rememberSig(src) {
  const list = (await DB.get('sigs')) || [];
  if (!list.includes(src)) list.unshift(src);
  await DB.set('sigs', list.slice(0, 4));
}
async function refreshSaved() {
  const list = (await DB.get('sigs')) || [];
  $('#savedSigs').hidden = !list.length;
  const w = $('#savedList'); w.innerHTML = '';
  list.forEach(src => {
    const b = document.createElement('button');
    b.className = 'saved-item';
    b.innerHTML = `<img src="${src}" alt="Saved signature">`;
    b.onclick = () => armSignature(src, $('#sigStamp').checked, null);
    const del = document.createElement('span');
    del.className = 'saved-del';
    del.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;
    del.onclick = async ev => { ev.stopPropagation(); await DB.set('sigs', list.filter(s => s !== src)); refreshSaved(); };
    b.append(del); w.append(b);
  });
}

/* ================================================================== EXPORT */
const outName = () => S.name.replace(/\.pdf$/i, '') + '-Signed.pdf';

function markCanvas(ctx, type, x, y, size, color) {
  const s = size / 24;
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (type === 'check') { ctx.moveTo(4.5, 12.5); ctx.lineTo(9.5, 17.5); ctx.lineTo(20, 6); }
  else { ctx.moveTo(5.5, 5.5); ctx.lineTo(18.5, 18.5); ctx.moveTo(18.5, 5.5); ctx.lineTo(5.5, 18.5); }
  ctx.stroke(); ctx.restore();
}

const imgCache = new Map();
async function loadImg(src) {
  if (imgCache.has(src)) return imgCache.get(src);
  const img = new Image(); img.src = src; await img.decode();
  imgCache.set(src, img); return img;
}

/** Render one page unrotated with its objects burned in → PNG bytes. */
async function rasterPage(pi, items, doc) {
  const p = S.pageBox[pi];
  const page = await (doc || S.pdf).getPage(pi + 1);
  const scale = clamp(1700 / p.uw, 1.6, 3.2);
  const vp = page.getViewport({ scale, rotation: 0 });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  const W = c.width, H = c.height;
  for (const it of items) {
    const [Wl, Hl] = localDims(W, H, it.rot);
    const [ux, uy] = unrotXY(it.rot, it.x, it.y);
    ctx.save();
    ctx.translate(ux * W, uy * H);
    if (it.rot) ctx.rotate(-norm4(it.rot) * Math.PI / 180);
    if (it.type === 'redact') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, it.w * Wl, it.h * Hl);
    } else if (it.type === 'sig') {
      const img = await loadImg(it.src);
      const w = it.w * Wl;
      ctx.drawImage(img, 0, 0, w, w * it.ar);
    } else if (isText(it)) {
      const fs = it.fs * Hl;
      ctx.fillStyle = it.color;
      ctx.font = `${fs}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      ctx.textBaseline = 'alphabetic';
      textOf(it).split('\n').forEach((ln, i) => ctx.fillText(ln, 0, fs * BASELINE + i * fs * LINEH));
    } else {
      markCanvas(ctx, it.type, 0, 0, it.size * Hl, it.color);
    }
    ctx.restore();
  }
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/* Write the typed values back into the document's own form and flatten it, so
   the result is a plain page a recipient cannot un-type. */
async function flattenForm(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const done = new Set();
  for (const f of allFields()) {
    if (done.has(f.name)) continue;
    done.add(f.name);
    const v = S.fields[f.name];
    if (v === undefined || !fieldChanged(f.name)) continue;
    if (f.type === 'text') form.getTextField(f.name).setText(String(v ?? ''));
    else if (f.type === 'check') { const c = form.getCheckBox(f.name); v ? c.check() : c.uncheck(); }
    else if (f.type === 'radio') { const g = form.getRadioGroup(f.name); if (v) g.select(String(v)); else g.clear(); }
    else if (f.type === 'choice') {
      const val = String(v ?? '');
      let d; try { d = form.getDropdown(f.name); } catch (_) { d = form.getOptionList(f.name); }
      val ? d.select(val) : d.clear();
    }
  }
  try { form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica)); } catch (_) {}
  form.flatten();
  return doc.save({ useObjectStreams: false });
}

/* If the document's own form refuses to cooperate, fall back to drawing the
   values ourselves at the field rectangles. */
function fieldFallbackItems() {
  const out = [];
  S.pageBox.forEach((p, pi) => {
    const vp = p.page.getViewport({ scale: 1, rotation: 0 });
    (p.fields || []).forEach(f => {
      const v = S.fields[f.name];
      if (!v || !fieldChanged(f.name)) return;
      const r = vp.convertToViewportRectangle(f.rect);
      const x = Math.min(r[0], r[2]) / vp.width;
      const y = Math.min(r[1], r[3]) / vp.height;
      const w = Math.abs(r[2] - r[0]) / vp.width;
      const h = Math.abs(r[3] - r[1]) / vp.height;
      if (f.type === 'text' || f.type === 'choice') {
        const fs = f.fs ? f.fs / vp.height : Math.min(h * 0.62, 0.02);
        out.push({ id: 'ff' + out.length, page: pi, rot: 0, type: 'text',
                   x: x + 0.004, y: y + (h - fs * LINEH) / 2, fs, color: f.color, text: String(v) });
      } else if (f.type === 'check' ? v : v === f.on) {
        out.push({ id: 'ff' + out.length, page: pi, rot: 0, type: 'check',
                   x: x + w * 0.1, y: y + h * 0.1, size: Math.min(w, h) * 0.8, color: f.color });
      }
    });
  });
  return out;
}

async function buildPdf() {
  let bytes = S.bytes.slice(0);
  let rasterDoc = null;
  let extra = [];

  const touched = allFields().some(f => fieldChanged(f.name));
  if (touched) {
    try {
      bytes = await flattenForm(bytes);
      rasterDoc = await pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
    } catch (e) {
      console.warn('form flatten unavailable, drawing values instead', e);
      bytes = S.bytes.slice(0);
      rasterDoc = null;
      extra = fieldFallbackItems();
    }
  }

  const src = await PDFDocument.load(bytes.slice(0), { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);

  const byPage = S.pageBox.map(() => []);
  [...extra, ...S.items].forEach(it => { if (!isText(it) || textOf(it).trim()) byPage[it.page].push(it); });

  const sigImgs = new Map();
  for (const it of S.items) {
    if (it.type === 'sig' && !sigImgs.has(it.src)) {
      const bytes = Uint8Array.from(atob(it.src.split(',')[1]), ch => ch.charCodeAt(0));
      sigImgs.set(it.src, await out.embedPng(bytes));
    }
  }
  const encodable = t => { try { font.widthOfTextAtSize(t, 12); return true; } catch (_) { return false; } };

  for (let i = 0; i < S.pageBox.length; i++) {
    const pb = S.pageBox[i];
    const items = byPage[i];
    const rot = totalRot(pb);
    const hasRedact = items.some(it => it.type === 'redact');
    const badText = items.some(it => isText(it) && !textOf(it).split('\n').every(encodable));

    if (hasRedact || badText) {
      const png = await rasterPage(i, items, rasterDoc);
      const img = await out.embedPng(png);
      const p = out.addPage([pb.uw, pb.uh]);
      p.drawImage(img, { x: 0, y: 0, width: pb.uw, height: pb.uh });
      p.setRotation(degrees(rot));
      continue;
    }

    const [copied] = await out.copyPages(src, [i]);
    const p = out.addPage(copied);
    const cb = p.getCropBox ? p.getCropBox() : { x: 0, y: 0, width: pb.uw, height: pb.uh };
    const OX = cb.x, OY = cb.y, W = cb.width || pb.uw, H = cb.height || pb.uh;

    /* a point in the object's own page-frame -> a point on the un-rotated page */
    const anchor = (it, lx, ly) => {
      const [ux, uy] = unrotXY(it.rot, lx, ly);
      return { x: OX + ux * W, y: OY + H - uy * H };
    };

    for (const it of items) {
      const [Wl, Hl] = localDims(W, H, it.rot);
      const spin = degrees(norm4(it.rot));
      if (isText(it)) {
        const fs = it.fs * Hl;
        textOf(it).split('\n').forEach((ln, k) => {
          if (!ln) return;
          let lx = it.x;
          if (it.cell) {
            // sit it in the middle of the box, the way you would write it
            const wide = font.widthOfTextAtSize(ln, fs) / Wl;
            lx = it.cell.x0 + ((it.cell.x1 - it.cell.x0) - wide) / 2;
          }
          const a = anchor(it, lx, it.y + it.fs * BASELINE + k * it.fs * LINEH);
          p.drawText(ln, { x: a.x, y: a.y, size: fs, font, color: hex2rgb(it.color), rotate: spin });
        });
      } else if (it.type === 'sig') {
        const w = it.w * Wl, h = w * it.ar;
        const a = anchor(it, it.x, it.y + h / Hl);
        p.drawImage(sigImgs.get(it.src), { x: a.x, y: a.y, width: w, height: h, rotate: spin });
      } else {
        const s = it.size * Hl, k = s / 24;
        const a = anchor(it, it.x, it.y);
        p.drawSvgPath(it.type === 'check' ? 'M 4.5 12.5 L 9.5 17.5 L 20 6' : 'M 5.5 5.5 L 18.5 18.5 M 18.5 5.5 L 5.5 18.5', {
          x: a.x, y: a.y, scale: k, rotate: spin,
          borderColor: hex2rgb(it.color), borderWidth: 2.2 * k, borderLineCap: LineCapStyle.Round,
        });
      }
    }
    p.setRotation(degrees(rot));
    /* The crop is a CropBox, not a cut: the page keeps everything it had and
       the viewer is told which part of it to show. Nothing is destroyed, so
       widening the crop later gets it all back — and a blackout, which really
       does have to destroy what it covers, is a separate thing entirely. */
    const pb2 = S.pageBox[i];
    const cr = pb2 ? cropNow(pb2) : null;
    if (cr) {
      const [ax, ay] = unrotXY(rot, cr.x0, cr.y0);
      const [bx, by] = unrotXY(rot, cr.x1, cr.y1);
      const mb = p.getMediaBox();
      const lo = Math.min(ax, bx), hi = Math.max(ax, bx);
      const t = Math.min(ay, by), b2 = Math.max(ay, by);
      p.setCropBox(mb.x + lo * mb.width, mb.y + (1 - b2) * mb.height,
                   (hi - lo) * mb.width, (b2 - t) * mb.height);
    }
  }

  out.setProducer('Fill & Sign — free PDF fill and sign by Eli Otterholt');
  out.setCreator('Fill & Sign');
  const blob = new Blob([await out.save({ useObjectStreams: false })], { type: 'application/pdf' });
  try { rasterDoc?.destroy?.(); } catch (_) {}
  return blob;
}


/* ------------------------------------------------------- the Back button
   Android's back gesture is the one control the app does not own, and by
   default it leaves the site — so a back-swipe while filling a form closed
   Fill & Sign outright rather than stepping out of the sheet, or the crop, or
   the document. Keep one spare history entry while anything of ours is open,
   spend it on closing that thing, and put another back. Only when nothing is
   open does Back mean leave. */
let backDepth = 0;
function armBack() { try { history.pushState({ fs: ++backDepth }, ''); } catch (_) {} }

addEventListener('popstate', () => {
  const sheet = $$('.sheet-wrap').find(x => !x.hidden);
  if (sheet) { sheet.hidden = true; return armBack(); }
  if (!$('#cropbar').hidden) { closeCrop(); return armBack(); }
  if (!$('#rotbar').hidden) { closeRotate(); return armBack(); }
  if (!$('#penbar').hidden) { closePen(); return armBack(); }
  if (!$('#pick').hidden) { $('#pick').hidden = true; closeDoc(); return armBack(); }
  if (!$('#simple').hidden) { showPage(); return armBack(); }
  if (!$('#done').hidden) {
    stopConfetti(); $('#done').hidden = true; $('#editor').hidden = false;
    fitViewport(); return armBack();
  }
  if (!$('#editor').hidden) { closeDoc(); return armBack(); }
  // nothing of ours is showing: this one really was meant to leave
});

/* ================================================================== CROP
   A document arrives the wrong size — a photo with the desk in it, a scan
   with a margin of shadow — and the fix is one gesture, not a trip through
   another app. The crop is stored against the page and applied on export as
   the PDF's own CropBox, so nothing is thrown away: come back and widen it
   again whenever you like. In the editor it is drawn rather than applied,
   because shading what will go is honest about a change that has not
   happened yet, and it leaves the page's own layout untouched. */
let cropPi = -1;

/* A crop is remembered in the frame of the page as it looked when you made it
   — the same rule objects follow — so turning the page afterwards turns the
   crop with it instead of leaving it slicing the wrong side. Everything that
   uses a crop asks for it in the frame of the moment. */
const reframe = (from, to, x, y) => {
  const [ux, uy] = unrotXY(from, x, y);
  return unrotXY(norm4(360 - to), ux, uy);
};
function cropNow(p) {
  const c = p.crop;
  if (!c) return null;
  const now = totalRot(p);
  if (norm4(c.rot || 0) === now) return c;
  const [ax, ay] = reframe(c.rot || 0, now, c.x0, c.y0);
  const [bx, by] = reframe(c.rot || 0, now, c.x1, c.y1);
  return { x0: Math.min(ax, bx), x1: Math.max(ax, bx),
           y0: Math.min(ay, by), y1: Math.max(ay, by), rot: now };
}
const cropOf = p => cropNow(p) || { x0: 0, y0: 0, x1: 1, y1: 1 };

function frontPage() {
  let best = 0, bestSeen = -1;
  S.pageBox.forEach((p, i) => {
    const top = p.el.offsetTop - stageEl.scrollTop;
    const seen = Math.min(stageEl.clientHeight, top + p.dh) - Math.max(0, top);
    if (seen > bestSeen) { bestSeen = seen; best = i; }
  });
  return best;
}

/* Eight places to take hold of, not four. Most crops are one edge — the
   shadow down the right of a scan, the header you do not want — and dragging
   a corner to do that costs you the other axis as well and a second drag to
   put it back. `CROP_GRIP` reads as a compass: 'n' is the top edge, 'nw' the
   top-left corner, and every entry says which of x0/x1 and y0/y1 it owns. */
const CROP_GRIP = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN_CROP = 0.08;
let cropSel = 'se';                       // the handle the arrows will move

function paintCrop() {
  S.pageBox.forEach(p => p.el.querySelector('.cropmask')?.remove());
  if (cropPi < 0) return;
  const p = S.pageBox[cropPi];
  if (!p) return;
  const c = p.draft || cropOf(p);
  const m = document.createElement('div');
  m.className = 'cropmask';
  const pct = v => (v * 100) + '%';
  m.innerHTML =
    `<div class="shade" style="left:0;top:0;right:0;height:${pct(c.y0)}"></div>` +
    `<div class="shade" style="left:0;bottom:0;right:0;height:${pct(1 - c.y1)}"></div>` +
    `<div class="shade" style="left:0;top:${pct(c.y0)};width:${pct(c.x0)};height:${pct(c.y1 - c.y0)}"></div>` +
    `<div class="shade" style="right:0;top:${pct(c.y0)};width:${pct(1 - c.x1)};height:${pct(c.y1 - c.y0)}"></div>` +
    `<div class="frame" style="left:${pct(c.x0)};top:${pct(c.y0)};width:${pct(c.x1 - c.x0)};height:${pct(c.y1 - c.y0)}"></div>`;
  for (const k of CROP_GRIP) {
    const h = document.createElement('div');
    const edge = k.length === 1;
    h.className = 'crophandle' + (edge ? ` edge-${k}` : '') + (k === cropSel ? ' picked' : '');
    h.dataset.k = k;
    const x = k.includes('w') ? c.x0 : k.includes('e') ? c.x1 : (c.x0 + c.x1) / 2;
    const y = k.includes('n') ? c.y0 : k.includes('s') ? c.y1 : (c.y0 + c.y1) / 2;
    h.style.left = (x * 100) + '%';
    h.style.top = (y * 100) + '%';
    h.style.marginLeft = '-17px'; h.style.marginTop = '-17px';
    m.append(h);
  }
  p.el.append(m);
}

/** Move one side of the draft, keeping the box at least MIN_CROP across. */
function cropEdge(c, k, dx, dy) {
  if (k.includes('w')) c.x0 = clamp(c.x0 + dx, 0, c.x1 - MIN_CROP);
  if (k.includes('e')) c.x1 = clamp(c.x1 + dx, c.x0 + MIN_CROP, 1);
  if (k.includes('n')) c.y0 = clamp(c.y0 + dy, 0, c.y1 - MIN_CROP);
  if (k.includes('s')) c.y1 = clamp(c.y1 + dy, c.y0 + MIN_CROP, 1);
}

const CROP_LABEL = { n: 'Top edge', s: 'Bottom edge', e: 'Right edge', w: 'Left edge',
                     nw: 'Top-left', ne: 'Top-right', sw: 'Bottom-left', se: 'Bottom-right' };
function pickCrop(k) {
  cropSel = k;
  $('#cropHint').textContent = CROP_LABEL[k] || 'Drag an edge or a corner';
  /* An edge only moves along one axis, so only that axis is offered. Two dead
     arrows beside two live ones is a worse answer to "which way does this
     go?" than showing the two that work. Corners keep all four. */
  const axis = k.length === 1 ? (k === 'n' || k === 's' ? 'y' : 'x') : null;
  $$('#cropNudge .nud').forEach(b => {
    const mine = b.classList.contains('nud-y') ? 'y' : 'x';
    b.hidden = !!axis && axis !== mine;
  });
  paintCrop();
}

/* The same idea as the arrows beside a text box: a finger is not precise
   enough to trim four millimetres off a margin, and neither is a trackpad.
   One press is a fifth of a percent of the page; held down, or with Shift,
   it strides. The arrow keys do it too while the crop bar is open. */
function nudgeCrop(dir, far) {
  if (cropPi < 0) return;
  const p = S.pageBox[cropPi];
  if (!p?.draft) return;
  const step = far ? 0.01 : 0.002;
  const [dx, dy] = NUDGE[dir];
  cropEdge(p.draft, cropSel, dx * step, dy * step);
  paintCrop();
}
$('#cropNudge').addEventListener('pointerdown', e => {
  const b = e.target.closest('.nud'); if (!b) return;
  e.preventDefault();
  const dir = b.dataset.d, pid = e.pointerId;
  nudgeCrop(dir, false);
  const t0 = performance.now();
  let timer = null;
  const hold = setTimeout(() => { timer = setInterval(() => nudgeCrop(dir, performance.now() - t0 > 900), 55); }, 340);
  const off = ev => {
    if (ev && ev.pointerId !== pid) return;
    clearTimeout(hold); if (timer) clearInterval(timer);
    window.removeEventListener('pointerup', off);
    window.removeEventListener('pointercancel', off);
  };
  window.addEventListener('pointerup', off);
  window.addEventListener('pointercancel', off);
});

function openCrop() {
  if (!S.pdf) return;
  select(null);
  closeRotate(); closePen();
  cropPi = frontPage();
  const p = S.pageBox[cropPi];
  p.draft = { ...cropOf(p) };
  $('#cropbar').hidden = false;
  $('#editor').classList.add('cropping');
  showCrop(p);                            // show it whole again while you work
  pickCrop(cropSel);
  revealPage(cropPi);
}
function closeCrop() {
  const p = S.pageBox[cropPi];
  if (p) delete p.draft;
  cropPi = -1;
  $('#cropbar').hidden = true;
  $('#editor').classList.remove('cropping');
  if (p) showCrop(p);
  paintCrop();
}

/** Put a page in view — the crop bar is no use if the page is off screen.

    Measured, not calculated: offsetTop here is relative to the positioned
    ancestor rather than to the scrolling box, so it carries the height of
    the bars above the stage with it, and scrolling by it puts the top of the
    page — and the two handles on it — up underneath the header. */
function revealPage(i) {
  const p = S.pageBox[i];
  if (!p) return;
  requestAnimationFrame(() => {
    const pr = p.el.getBoundingClientRect(), sr = stageEl.getBoundingClientRect();
    stageEl.scrollTop = Math.max(0, stageEl.scrollTop + (pr.top - sr.top) - 22);
  });
}

pagesEl.addEventListener('pointerdown', e => {
  const h = e.target.closest('.crophandle');
  if (!h || cropPi < 0) return;
  e.preventDefault(); e.stopPropagation();
  const p = S.pageBox[cropPi], k = h.dataset.k, pid = e.pointerId;
  pickCrop(k);
  const r = p.el.getBoundingClientRect();
  const move = ev => {
    if (ev.pointerId !== pid) return;
    const x = clamp((ev.clientX - r.left) / r.width, 0, 1);
    const y = clamp((ev.clientY - r.top) / r.height, 0, 1);
    const c = p.draft;
    if (k.includes('w')) c.x0 = Math.min(x, c.x1 - MIN_CROP);
    if (k.includes('e')) c.x1 = Math.max(x, c.x0 + MIN_CROP);
    if (k.includes('n')) c.y0 = Math.min(y, c.y1 - MIN_CROP);
    if (k.includes('s')) c.y1 = Math.max(y, c.y0 + MIN_CROP);
    paintCrop();
  };
  const up = ev => {
    if (ev && ev.pointerId !== pid) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}, true);

$('#cropApply').addEventListener('click', () => {
  const p = S.pageBox[cropPi];
  if (!p) return closeCrop();
  const c = p.draft;
  push();
  p.crop = (c.x0 < 0.002 && c.y0 < 0.002 && c.x1 > 0.998 && c.y1 > 0.998)
    ? null : { ...c, rot: totalRot(p) };
  closeCrop();
  layoutPages();
  saveSoon();
  toast(p.crop ? 'Cropped. Nothing is thrown away — widen it any time.' : 'Showing the whole page.', 2600);
});
$('#cropCancel').addEventListener('click', closeCrop);
$('#cropReset').addEventListener('click', () => {
  const p = S.pageBox[cropPi];
  if (!p) return;
  p.draft = { x0: 0, y0: 0, x1: 1, y1: 1 };
  paintCrop();
});

/* ------------------------------------------------------------ clear a page */
function openClear() {
  if (!S.pdf) return;
  const pi = frontPage();
  const n = S.items.filter(i => i.page === pi).length;
  if (!n) return toast('There is nothing on this page yet.', 2600);
  $('#clearWhat').textContent =
    `${n} thing${n > 1 ? 's' : ''} you have added to page ${pi + 1} will be removed. ` +
    'The document itself is untouched, and you can undo it.';
  $('#clearSheet').dataset.pi = pi;
  $('#clearSheet').hidden = false;
}
$('#clearGo').addEventListener('click', () => {
  const pi = +$('#clearSheet').dataset.pi;
  push();
  S.items.filter(i => i.page === pi).forEach(i => { elOf(i.id)?.remove(); });
  S.items = S.items.filter(i => i.page !== pi);
  S.sel = null; syncBars(); hintsSoon(); saveSoon();
  $('#clearSheet').hidden = true;
  toast('Page cleared.', 2400);
});

/* ---------------------------------------------------------- done screen */
let lastBlob = null;
const canShareFiles = () => {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob()], 'a.pdf', { type: 'application/pdf' })] })); }
  catch (_) { return false; }
};

$('#btnFinish').addEventListener('click', async () => {
  document.activeElement?.blur?.();
  select(null);
  busy(true, 'Building your PDF…');
  try {
    lastBlob = await buildPdf();
  } catch (e) {
    console.error(e);
    busy(false);
    return toast('Something went wrong building the PDF. Try removing the last object you added.', 5000);
  }
  busy(false);
  const reds = S.items.filter(i => i.type === 'redact').length;
  const filled = allFields().filter(f => fieldChanged(f.name)).length;
  $('#doneNote').textContent = reds
    ? `Everything you added is now part of the document. ${reds} blackout${reds > 1 ? 's were' : ' was'} baked permanently into the page.`
    : filled
      ? 'Everything you added is now part of the document, and the form fields are flattened so they can’t be typed over.'
      : 'Everything you added is now part of the document. Nothing was uploaded.';
  $('#saveName').value = outName();
  $('#btnShare').hidden = !canShareFiles();
  $('#editor').hidden = true;
  $('#done').hidden = false;
  confetti();
});

$('#btnContinue').addEventListener('click', () => {
  stopConfetti();
  $('#done').hidden = true; $('#editor').hidden = false;
  /* The editor was display:none, so nothing in it has been measured for a
     while. Settle the viewport and the layout before the frame is painted,
     and let the pages repaint themselves — a redraw is free when nothing has
     changed, and it is what keeps coming back from Finish from looking like
     the document broke. */
  fitViewport();
  layoutPages();
  /* Forget the pixels, not just the layout. The editor has been display:none
     and a backgrounded canvas can lose its backing store while it is hidden,
     so a redraw that trusts its own cache paints nothing and leaves your text
     and ticks floating on a blank page. Throw the belief away and look again
     once it has settled. */
  S.pageBox.forEach(forget);
  renderVisible();
  healing = 0;
  setTimeout(healPages, 400);
});
$('#btnHome').addEventListener('click', () => { stopConfetti(); closeDoc(); });
$('#btnNewDoc').addEventListener('click', () => {
  stopConfetti();
  closeDoc();
  $('#fileInput').click();          // still inside the click, so the picker opens
});

/* ------------------------------------------------------------- confetti
   A small reward for finishing, drawn in about forty lines: paper
   rectangles thrown upward, pulled down by gravity, spinning and flipping
   edge-on as they fall. Skipped entirely when the reader asked for less
   motion. */
const CONFETTI = ['#1b4fd8', '#0f8a5f', '#f5a524', '#c8202a', '#8b5cf6', '#ec4899', '#06b6d4'];
let confettiRun = 0;

function stopConfetti() {
  confettiRun++;
  const cv = $('#confetti');
  if (cv) cv.hidden = true;
}

function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = $('#confetti');
  if (!cv) return;
  cv.hidden = false;                            // lay it out before measuring
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) { cv.hidden = true; return; }
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const bits = [];
  const n = Math.round(clamp(W / 4.5, 70, 140));
  for (let i = 0; i < n; i++) {
    bits.push({
      x: W * (0.12 + Math.random() * 0.76),
      y: H * 0.26 + Math.random() * 24,
      vx: (Math.random() - 0.5) * 7.5,
      vy: -5.5 - Math.random() * 8,
      w: 5 + Math.random() * 5,
      h: 8 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.32,
      spin: 0.05 + Math.random() * 0.18,
      phase: Math.random() * 6,
      c: CONFETTI[(Math.random() * CONFETTI.length) | 0],
    });
  }

  const run = ++confettiRun;
  const t0 = performance.now();
  const step = now => {
    if (run !== confettiRun) return;
    const t = now - t0;
    ctx.clearRect(0, 0, W, H);
    let alive = 0;
    for (const b of bits) {
      b.vy += 0.30;                              // gravity
      b.vx *= 0.995;                             // a little drag
      b.x += b.vx; b.y += b.vy;
      b.rot += b.vr; b.phase += b.spin;
      if (b.y > H + 40) continue;
      alive++;
      ctx.save();
      ctx.globalAlpha = clamp(1 - (t - 1700) / 1100, 0, 1);
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.scale(1, Math.abs(Math.cos(b.phase)) * 0.8 + 0.2);   // twisting paper
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (alive && t < 3200) requestAnimationFrame(step);
    else { ctx.clearRect(0, 0, W, H); cv.hidden = true; }
  };
  requestAnimationFrame(step);
}

/* A file name has to survive being handed to another app. Downloading it
   here is forgiving — the browser writes whatever you ask — but a name goes
   on a journey after that: an Android share hands it to a mail app, which
   puts it in a MIME header, which travels, and something along that road
   quietly drops the attachment. Em dashes and smart quotes come through from
   the original document's name without anyone typing them, so the trip
   starts broken and the first sign of it is "couldn't download attachment"
   at the far end. Keep the name to characters that cannot be argued about. */
function finalName() {
  const raw = ($('#saveName').value || outName());
  let n = raw
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // café → cafe
    .replace(/[‐-―]/g, '-')                     // dashes of every width
    .replace(/[‘’“”]/g, '')           // smart quotes
    .replace(/\.pdf$/i, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s._-]+|[\s._-]+$/g, '');
  if (n.length > 60) n = n.slice(0, 60).replace(/[\s._-]+$/, '');
  return (n || 'Document') + '.pdf';
}
$('#btnSave').addEventListener('click', () => {
  if (!lastBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(lastBlob);
  a.download = finalName();
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('Saved to your device.');
});
$('#btnShare').addEventListener('click', async () => {
  if (!lastBlob) return;
  const name = finalName();
  /* Hand over a file read back out in full rather than the blob itself. A
     blob is a promise of bytes; the receiving app gets a moment to read them
     and if anything about that hand-off goes wrong it attaches an empty file,
     which only shows up as a failed download for whoever opens the mail. */
  const buf = await lastBlob.arrayBuffer();
  if (!buf.byteLength) return toast('The PDF came out empty — press Finish again.', 5000);
  const file = new File([buf], name, { type: 'application/pdf' });
  try {
    if (navigator.canShare && !navigator.canShare({ files: [file] })) throw new Error('unsupported');
    await navigator.share({ files: [file] });      // no title: some mail apps
  } catch (e) {                                    // treat it as a text share
    if (e.name === 'AbortError') return;
    toast('That app would not take the file. Use Save PDF, then attach it from your files.', 6000);
  }
});


/* ================================================ SIMPLE VIEW
   The same document, laid out as one tall column of questions.

   Nothing is converted. A card writes into exactly the object the page view
   already draws — a declared field's value, a text item pinned to a blank
   line, a mark inside a tick box — so Review is a change of view, and the
   export path never learns this screen exists. */

const simEl = () => $('#simple');
let SIM = { qs: [], scanned: false, built: false };
let simSignTarget = null;

/* ---- reading and writing one question, whatever kind it is ---- */
const simLineItem = q => S.items.find(i => i.page === q.page && i.lineKey === q.key);

function simGet(q) {
  if (q.kind === 'field') return S.fields[q.f.name];
  if (q.kind === 'line') { const it = simLineItem(q); return it ? (it.text || '') : ''; }
  return markInBox(q.page, q.B)?.type || null;
}

function simSetLine(q, v) {
  let it = simLineItem(q);
  if (!it) {
    if (!v) return;
    const p = S.pageBox[q.page], fs = q.L.fs;
    it = { id: uid(), page: q.page, rot: totalRot(p), type: 'text',
           x: clamp(q.L.x0 + 0.006, 0, .97),
           y: clamp(q.L.y - fs * (BASELINE + 0.06), 0, .99),
           fs, color: COLORS[0], text: '', lineKey: q.key };
    markFieldHistory();
    S.items.push(it);
    itemEl(it);
    hintsSoon();
  }
  it.text = v;
  const d = elOf(it.id);
  if (d && d.firstChild) d.firstChild.textContent = v;
  saveSoon();
}

function simSetCell(q, v) {
  let it = simLineItem(q);
  if (!it) {
    if (!v) return;
    markFieldHistory();
    it = textInCell(q.page, q.C, q.key, false);
  }
  it.text = v;
  const d = elOf(it.id);
  if (d && d.firstChild) d.firstChild.textContent = v;
  saveSoon();
}

function simSetBox(q, type) {
  const cur = markInBox(q.page, q.B);
  if (cur && cur.type === type) return;
  markFieldHistory();
  if (cur) removeItem(cur.id);
  if (type) placeInBox(q.page, q.B, type, false);
  select(null);
  saveSoon();
}

/* ---- placing a signature straight onto its line, no tapping about ---- */
function placeSigOnLine(pi, L, sig) {
  const p = S.pageBox[pi];
  const rot = totalRot(p);
  const [Wl, Hl] = localDims(p.lw, p.lh, rot);
  const ar = sig.ar;
  const w = sigOnLine(p, L, ar);
  const h = (w * Wl * ar) / Hl;
  const it = {
    id: uid(), page: pi, rot, type: 'sig',
    x: clamp(L.x0 + 0.008, 0, 1 - w), y: clamp(L.y - h - 0.004, 0, 1),
    w, ar, src: sig.src, gen: sig.gen || null,
    stampMode: sig.stamp ? 'datetime' : 'none',
  };
  push();
  S.items.push(it);
  itemEl(it);
  if (it.stampMode !== 'none') addStamp(it);
  saveSoon();
  return it;
}
const simSigItem = q => S.items.find(i => i.type === 'sig' && i.page === q.page && i.sigLine === q.key);

/* ---- the cards ---- */
function qCard(q, i) {
  const d = document.createElement('div');
  d.className = 'q-card';
  d.dataset.q = q.key;

  const labelText = (txt, forId) => {
    const l = document.createElement(forId ? 'label' : 'span');
    l.className = 'q-label';
    if (forId) l.htmlFor = forId;
    l.innerHTML = `<span class="q-num">${q.n}.</span> `;
    l.append(document.createTextNode(txt));
    return l;
  };

  /* a tick box, declared or drawn — one tap, and a way to swap the mark */
  if (q.kind === 'box' || (q.kind === 'field' && q.f.type === 'check')) {
    const on = () => q.kind === 'box' ? !!simGet(q) : !!S.fields[q.f.name];
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'q-toggle';
    row.append(labelText(q.label));
    const mark = document.createElement('span');
    mark.className = 'q-mark';
    mark.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4.5 12.5 9.5 17.5 20 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    row.append(mark);
    d.append(row);

    let alt = null;
    if (q.kind === 'box') {
      alt = document.createElement('button');
      alt.type = 'button';
      alt.className = 'q-alt';
      alt.hidden = true;
    }
    const paint = () => {
      const v = q.kind === 'box' ? simGet(q) : (on() ? 'check' : null);
      d.classList.toggle('is-on', !!v);
      mark.innerHTML = v === 'x'
        ? `<svg viewBox="0 0 24 24"><path d="M5.5 5.5 18.5 18.5 M18.5 5.5 5.5 18.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>`
        : `<svg viewBox="0 0 24 24"><path d="M4.5 12.5 9.5 17.5 20 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      if (alt) {
        alt.hidden = !v;
        alt.textContent = v === 'x' ? 'Use a checkmark instead' : 'Use an ✗ instead';
      }
    };
    row.addEventListener('click', () => {
      if (q.kind === 'box') simSetBox(q, simGet(q) ? null : 'check');
      else { markFieldHistory(); setField(q.f, !S.fields[q.f.name]); }
      paint();
    });
    if (alt) {
      d.append(alt);
      alt.addEventListener('click', () => { simSetBox(q, simGet(q) === 'x' ? 'check' : 'x'); paint(); });
    }
    paint();
    return d;
  }

  /* a radio group is one question with several answers */
  if (q.kind === 'field' && q.f.type === 'radio') {
    d.append(labelText(q.groupLabel || q.label));
    const wrap = document.createElement('div');
    wrap.className = 'q-opts';
    q.group.forEach(g => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'q-opt';
      b.textContent = g.label || g.f.on;
      b.addEventListener('click', () => {
        markFieldHistory();
        setField(g.f, S.fields[g.f.name] === g.f.on ? '' : g.f.on);
        [...wrap.children].forEach((c, k) =>
          c.classList.toggle('is-on', S.fields[q.f.name] === q.group[k].f.on));
      });
      b.classList.toggle('is-on', S.fields[q.f.name] === g.f.on);
      wrap.append(b);
    });
    d.append(wrap);
    return d;
  }

  /* a dropdown the document declared */
  if (q.kind === 'field' && q.f.type === 'choice') {
    const id = 'qc' + i;
    d.append(labelText(q.label, id));
    const sel = document.createElement('select');
    sel.id = id;
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = '—';
    sel.append(blank);
    q.f.options.forEach((label, k) => {
      const o = document.createElement('option');
      o.value = q.f.optionValues[k] ?? label; o.textContent = label;
      sel.append(o);
    });
    sel.value = S.fields[q.f.name] ?? '';
    sel.addEventListener('change', () => { markFieldHistory(); setField(q.f, sel.value); });
    d.append(sel);
    return d;
  }

  /* somewhere to sign */
  if (q.sign && q.kind === 'line') {
    d.append(labelText(q.label));
    const row = document.createElement('div');
    row.className = 'q-sign';
    const prev = document.createElement('div');
    prev.className = 'q-sig-prev';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost sm';
    const paint = () => {
      const sig = simSigItem(q);
      prev.innerHTML = '';
      if (sig) { const im = new Image(); im.src = sig.src; im.alt = 'Your signature'; prev.append(im); }
      btn.textContent = sig ? 'Change' : 'Add signature';
    };
    btn.addEventListener('click', () => { simSignTarget = { q, paint }; openSig(); });
    row.append(prev, btn);
    d.append(row);
    paint();
    return d;
  }

  /* everything else is words on a line, or in a table cell */
  const id = 'qi' + i;
  d.append(labelText(q.label, id));
  const multi = q.kind === 'field' && q.f.multiline;
  const inp = document.createElement(multi ? 'textarea' : 'input');
  if (!multi) inp.type = 'text';
  inp.id = id;
  inp.spellcheck = false;
  if (q.kind === 'field' && q.f.maxLen) inp.maxLength = q.f.maxLen;
  inp.value = simGet(q) ?? '';
  inp.addEventListener('input', () => {
    markFieldHistory();
    if (q.kind === 'field') setField(q.f, inp.value);
    else if (q.kind === 'cell') simSetCell(q, inp.value);
    else simSetLine(q, inp.value);
  });

  if (q.dateish && !multi) {
    const row = document.createElement('div');
    row.className = 'q-row';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'q-chip';
    chip.textContent = 'Today';
    chip.addEventListener('click', () => {
      inp.value = FMTS[0].f(new Date());
      inp.dispatchEvent(new Event('input'));
    });
    row.append(inp, chip);
    d.append(row);
  } else d.append(inp);
  return d;
}

/* ---- building the list ---- */
function groupQuestions(qs) {
  const out = [];
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    if (q.kind === 'field' && q.f.type === 'radio') {
      const name = q.f.name;
      const group = [];
      let j = i;
      while (j < qs.length && qs[j].kind === 'field' && qs[j].f?.name === name) group.push(qs[j++]);
      // the group's own question is whatever labels the first widget from further out
      out.push({ ...q, group,
                 groupLabel: group.length > 1 ? (q.askLabel || labelLeftOf(q)) : q.label });
      i = j - 1;
      continue;
    }
    out.push(q);
  }
  return out;
}
/* last resort for an unlabelled group: the field's own name, made readable */
const labelLeftOf = q => {
  const n = q.f?.name;
  if (!n) return q.label;
  const t = n.replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

async function buildSimple() {
  busy(true, 'Reading the form…');
  try {
    const r = await readQuestions({
      ocr: true,
      note: (msg, n, total) => busy(true, total > 1 ? `${msg} (page ${n} of ${total})` : msg),
    });
    SIM.qs = groupQuestions(r.questions);
    SIM.qs.forEach((q, i) => {
      q.n = i + 1;                                 // a radio group is one question
      if (/^Blank \d+$/.test(q.label)) q.label = `Blank ${q.n}`;
    });
    SIM.scanned = r.scanned;
  } finally { busy(false); }

  const list = $('#simList');
  list.innerHTML = '';
  let page = -1;
  SIM.qs.forEach((q, i) => {
    if (q.page !== page && S.pageBox.length > 1) {
      page = q.page;
      const h = document.createElement('p');
      h.className = 'q-page';
      h.textContent = `Page ${page + 1} of ${S.pageBox.length}`;
      list.append(h);
    }
    list.append(qCard(q, i));
  });

  const n = SIM.qs.length;
  $('#simMeta').textContent = n
    ? `${n} thing${n > 1 ? 's' : ''} to fill in · stays on this device`
    : 'Nothing obvious to fill in';
  const unnamed = SIM.qs.filter(q => /^Blank \d+$/.test(q.label)).length;
  $('#simEndNote').textContent = unnamed && unnamed === SIM.qs.length
    ? 'The labels could not be read off this page, so the blanks are numbered in the order they appear. They still work.'
    : 'Everything you type here lands on the real page. Review it before you save.';
  SIM.built = true;
}

/* ---- moving between the two views ---- */
function showSimple() {
  $('#pick').hidden = true;
  $('#editor').hidden = true;
  $('#done').hidden = true;
  $('#home').hidden = true;
  simEl().hidden = false;
  fitViewport();
  if (!SIM.built) buildSimple();
}
function showPage() {
  $('#pick').hidden = true;
  simEl().hidden = true;
  $('#done').hidden = true;
  $('#home').hidden = true;
  $('#editor').hidden = false;
  fitViewport();
  layoutPages(); renderVisible();
}

$('#simBack').addEventListener('click', () => {
  const touched = S.items.length || allFields().some(f => fieldChanged(f.name));
  if (touched) toast('Draft kept on this device — pick it up any time.');
  simEl().hidden = true;
  closeDoc();
});
$('#simReview').addEventListener('click', showPage);
/* Simple view now lives at the far end of the tool row rather than in the
   header, so the tool handler calls this by name. */
function goSimple() {
  if (SIM.built) rebuildSimpleValues();
  showSimple();
}

/* Coming back from the page view, the cards have to show what is now on the
   page — you may have typed into a field or ticked a box while you were
   there. Rebuilding from state is cheaper than trying to track it. */
function rebuildSimpleValues() {
  const list = $('#simList');
  if (!list.children.length) return;
  SIM.built = false;
  buildSimple();
}
$('#simDone').addEventListener('click', showPage);
$('#simToPage').addEventListener('click', showPage);

/* ---- the chooser ----
   Show it the moment the file opens, then fill in what was found. Reading
   the form takes a second on a long document and there is nothing to gain
   from making someone watch a spinner before they can even choose. */
async function askView(name) {
  $('#pickName').textContent = name;
  $('#pickMeta').textContent =
    `${S.pdf.numPages} page${S.pdf.numPages > 1 ? 's' : ''} · nothing is uploaded`;
  $('#pickSimpleSub').textContent = 'Reading the form…';
  $('#pickNote').textContent = '';
  $('#home').hidden = true;
  $('#editor').hidden = true;
  simEl().hidden = true;
  $('#pick').hidden = false;

  let r;
  try { r = await readQuestions(); } catch (_) { r = { questions: [], scanned: false }; }
  if ($('#pick').hidden) return;                 // they already chose
  const n = r.questions.length;
  const named = r.questions.filter(q => !/^Blank \d+$/.test(q.label)).length;
  $('#pickSimpleSub').textContent = n
    ? `${n} thing${n > 1 ? 's' : ''} to fill in, one at a time`
    : 'One question at a time, filling the screen';
  $('#pickNote').textContent =
    !n ? 'No blanks were found in this document — page view lets you put text anywhere.'
    : r.scanned ? 'This is a scan. Simple view will read the labels off the page — that takes a few seconds the first time.'
    : named < n ? `${named} of ${n} blanks could be named from the document’s own text.`
    : '';
}

function showPick(name, counts) {
  $('#pickName').textContent = name;
  $('#pickMeta').textContent = counts.meta;
  $('#pickSimpleSub').textContent = counts.sub;
  $('#pickNote').textContent = counts.note;
  $('#home').hidden = true;
  $('#editor').hidden = true;
  simEl().hidden = true;
  $('#pick').hidden = false;
}
$('#pickSimple').addEventListener('click', showSimple);
$('#pickPage').addEventListener('click', showPage);
$('#pickCancel').addEventListener('click', () => { $('#pick').hidden = true; closeDoc(); });

/* ============================================================ DRAFTS / OPEN */
async function checkResume() {
  try {
    const d = await DB.get('doc');
    if (d && Date.now() - (d.ts || 0) > DRAFT_TTL) { await DB.del('doc'); }
    const fresh = await DB.get('doc');
    const anyField = v => v !== '' && v !== false && v != null;
    const has = fresh && fresh.bytes &&
      ((fresh.items?.length || 0) > 0 || Object.values(fresh.fields || {}).some(anyField));
    $('#resume').hidden = !has;
    if (has) {
      $('#resumeName').textContent = fresh.name;
      const days = Math.max(0, 7 - Math.floor((Date.now() - fresh.ts) / 86400000));
      $('#resumeWhen').textContent = `Continue your last document? Kept ${days} more day${days === 1 ? '' : 's'}.`;
    }
  } catch (_) {}
}
$('#btnResume').addEventListener('click', async () => {
  busy(true, 'Opening…');
  try {
    const d = await DB.get('doc');
    if (d) await loadDoc(d.bytes, d.name, d.items, d.rots, d.fields, d.crops);
  } catch (_) { toast('That draft could not be restored.'); }
  finally { busy(false); }
});
$('#btnDiscard').addEventListener('click', async () => { await DB.del('doc'); checkResume(); toast('Draft deleted.'); });
$('#btnWipe').addEventListener('click', async () => {
  await DB.del('doc'); await DB.del('sigs');
  checkResume();
  toast('All local document data and saved signatures deleted.');
});
$('#btnWhy').addEventListener('click', () => { $('#whySheet').hidden = false; });

/* incoming files: Android share target + desktop file handlers */
async function checkShared() {
  if (!/[?&]shared=1/.test(location.search)) return false;
  history.replaceState(null, '', location.pathname);
  try {
    const c = await caches.open('fillandsign-share');
    const r = await c.match('shared.pdf');
    if (!r) return false;
    const name = decodeURIComponent(r.headers.get('X-Name') || 'Shared.pdf');
    const buf = await r.arrayBuffer();
    await c.delete('shared.pdf');
    busy(true, 'Opening…');
    await loadDoc(buf, name, [], null);
    askView(name);
    busy(false);
    return true;
  } catch (_) { return false; }
}
if ('launchQueue' in window) {
  launchQueue.setConsumer(async lp => {
    if (!lp.files?.length) return;
    openFile(await lp.files[0].getFile());
  });
}

/* ---------------------------------------------------------------- startup */
(async function init() {
  if (!(await checkShared())) await checkResume();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (_) {}
  }
})();

window.__fs = { S, loadDoc, buildPdf, FMTS, pageLines, findLine, allFields, fieldChanged,
                pageBoxes, findBox, ensureScan, spotsForPage, spotsOf, moveSpot, KB, fitViewport,
                pageBg, forget, paintHints, findHint, textOnLine,
                readQuestions, pageWords, labelFor, pageCells, scanVRules, textInCell,
                wordsOrOcr, ocrPage,
                buildSimple, showSimple, showPage, askView, SIMof: () => SIM,
                scanLines, findCells, totalRot, scanBoxes, layoutPages, revealFocused,
                scanPanels, scanCanvas, shotsToPdf, SCANof: () => SCAN, select, finalName, renderVisible,
                openPen, closePen,
                openCrop, closeCrop, nudgeCrop, pickCrop, syncRail, turn, openRotate, cropOf };
