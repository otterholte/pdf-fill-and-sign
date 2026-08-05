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
const DEF = { fs: 0.0165, stampFs: 0.0105, mark: 0.026, sigW: 0.26, redW: 0.30, redH: 0.028 };
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
  zoom: 1, baseW: 0, past: [], future: [], renderTok: 0,
};

const pagesEl = $('#pages');
const stageEl = $('#stage');

/* ------------------------------------------------------------------ history */
const snap = () => JSON.stringify({ i: S.items, r: S.pageBox.map(p => p.userRot) });
function restore(str) {
  const o = JSON.parse(str);
  S.items = o.i;
  o.r.forEach((r, i) => { if (S.pageBox[i]) S.pageBox[i].userRot = r; });
  S.sel = null;
  layoutPages(); paintItems(); syncBars(); renderVisible(); saveSoon();
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
        name: S.name, bytes: S.bytes, items: S.items,
        rots: S.pageBox.map(p => p.userRot), ts: Date.now(),
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
  const f = [...(e.dataTransfer?.files || [])].find(x => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
  if (f) openFile(f); else toast('That file is not a PDF.');
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

async function openFile(file) {
  if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) return toast('That file is not a PDF.');
  if (file.size > MAX_BYTES) {
    return toast('This document is too large to complete on this device. Try using a smaller PDF or another device.', 6000);
  }
  busy(true, 'Opening…');
  try {
    const buf = await file.arrayBuffer();
    await loadDoc(buf, file.name || 'Document.pdf', [], null);
  } catch (err) {
    console.error(err);
    const locked = err?.name === 'PasswordException' || /password/i.test(err?.message || '');
    toast(locked
      ? 'This PDF is locked. Ask the sender for an unlocked copy and try again.'
      : 'This PDF could not be opened. Please ask the sender for a new copy.', 6000);
  } finally { busy(false); }
}

async function loadDoc(buf, name, items, rots) {
  S.bytes = buf.slice(0);
  S.name = name;
  S.items = items || [];
  S.sel = null; S.tool = null; S.past = []; S.future = []; S.zoom = 1;
  syncHistory();

  S.pdf = await pdfjsLib.getDocument({ data: buf.slice(0), isEvalSupported: false }).promise;

  $('#docName').textContent = name;
  $('#docPages').textContent = `${S.pdf.numPages} page${S.pdf.numPages > 1 ? 's' : ''} · stays on this device`;
  $('#home').hidden = true;
  $('#done').hidden = true;
  $('#editor').hidden = false;

  await buildPages(rots);
  syncBars();
  saveSoon();
}

function closeDoc() {
  $('#editor').hidden = true;
  $('#done').hidden = true;
  $('#home').hidden = false;
  pagesEl.innerHTML = '';
  try { S.pdf?.destroy?.(); } catch (_) {}
  S.pdf = null; S.bytes = null; S.items = []; S.sel = null; S.tool = null; lastBlob = null;
  checkResume();
}
$('#btnBack').addEventListener('click', () => {
  if (S.items.length) toast('Draft kept on this device — pick it up any time.');
  closeDoc();
});

/* ================================================================ RENDERING */
const fitWidth = () => Math.min(stageEl.clientWidth - 20, 980);
const totalRot = p => (((p.baseRot + p.userRot) % 360) + 360) % 360;

async function buildPages(rots) {
  pagesEl.innerHTML = '';
  S.pageBox = [];
  S.baseW = fitWidth();

  for (let i = 1; i <= S.pdf.numPages; i++) {
    const page = await S.pdf.getPage(i);
    const un = page.getViewport({ scale: 1, rotation: 0 });
    const el = document.createElement('div');
    el.className = 'page'; el.dataset.i = i - 1;
    const cv = document.createElement('canvas');
    const layer = document.createElement('div');
    layer.className = 'layer';
    const num = document.createElement('div');
    num.className = 'page-num'; num.textContent = `${i}/${S.pdf.numPages}`;
    el.append(cv, num, layer);
    pagesEl.append(el);
    S.pageBox.push({
      page, el, cv, layer,
      uw: un.width, uh: un.height,
      baseRot: ((page.rotate || 0) % 360 + 360) % 360,
      userRot: (rots && rots[i - 1]) || 0,
    });
  }
  layoutPages();
  paintItems();
  renderVisible();
}

function layoutPages() {
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
  });
  relayoutItems();
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

async function renderVisible() {
  const tok = ++S.renderTok;
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
  const top = stageEl.scrollTop - stageEl.clientHeight;
  const bot = stageEl.scrollTop + stageEl.clientHeight * 2;

  for (const p of S.pageBox) {
    if (tok !== S.renderTok) return;
    const y = p.el.offsetTop;
    if (y + p.dh < top || y > bot) continue;
    const key = p.dw + ':' + totalRot(p);
    if (p.renderKey === key) continue;
    try {
      p.task?.cancel();
      const target = Math.round(p.dw * dpr);
      const vp = p.page.getViewport({ scale: target / (totalRot(p) % 180 ? p.uh : p.uw), rotation: totalRot(p) });
      p.cv.width = Math.round(vp.width);
      p.cv.height = Math.round(vp.height);
      p.renderKey = key;
      p.task = p.page.render({ canvasContext: p.cv.getContext('2d', { alpha: false }), viewport: vp });
      await p.task.promise;
    } catch (_) { p.renderKey = null; }
  }
}
stageEl.addEventListener('scroll', renderSoon, { passive: true });

let resizeT;
window.addEventListener('resize', () => {
  if (!S.pdf) return;
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { S.baseW = fitWidth(); layoutPages(); renderVisible(); }, 180);
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

  // double tap / double click to zoom
  let lastT = 0, lastX = 0, lastY = 0;
  stageEl.addEventListener('pointerup', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.it')) { lastT = 0; return; }
    const now = performance.now();
    if (now - lastT < 320 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 32) {
      const r = stageEl.getBoundingClientRect();
      zoomTo(S.zoom > 1.2 ? 1 : 2.4, e.clientX - r.left, e.clientY - r.top);
      lastT = 0;
    } else { lastT = now; lastX = e.clientX; lastY = e.clientY; }
  });
})();

/* ================================================================== ITEMS */
const isText = it => it.type === 'text';
const textOf = it => (it.date ? renderDate(it) : it.text);

function itemEl(it) {
  const p = S.pageBox[it.page];
  const d = document.createElement('div');
  d.className = 'it it-' + it.type + (it.date ? ' it-date' : '');
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
      ? `<svg viewBox="0 0 24 24"><path d="M4.5 12.5 9.5 17.5 20 6" fill="none" stroke="${it.color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg viewBox="0 0 24 24"><path d="M5.5 5.5 18.5 18.5 M18.5 5.5 5.5 18.5" fill="none" stroke="${it.color}" stroke-width="2.2" stroke-linecap="round"/></svg>`;
  }

  const h = document.createElement('div');
  h.className = 'handle';
  d.append(h);
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
    d.style.width = ''; d.style.height = '';
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
  S.pageBox.forEach(p => (p.layer.innerHTML = ''));
  S.items.forEach(it => {
    const d = itemEl(it);
    if (S.sel === it.id) d.classList.add('sel');
  });
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
  S.sel = id;
  $$('.it').forEach(d => d.classList.toggle('sel', d.dataset.id === id));
  syncBars();
}

function syncBars() {
  const it = getSel();
  $('#selbar').hidden = !it;
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
}

/* -------------------------------------------------------------- toolbar */
$$('.tool').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.tool;
  if (t === 'sig') { S.tool = null; reflectTool(); openSig(); return; }
  if (t === 'rotate') { S.tool = null; reflectTool(); openRotate(); return; }
  S.tool = S.tool === t ? null : t;
  pendingSig = null;
  reflectTool();
}));
const PROMPT = {
  text: 'Tap the page to add a text box',
  date: 'Tap the page to add the date',
  check: 'Tap the page to add a checkmark',
  x: 'Tap the page to add an X',
  redact: 'Drag on the page to black something out',
};
function reflectTool() {
  $$('.tool').forEach(b => b.classList.toggle('is-on', b.dataset.tool === S.tool));
  $$('.page').forEach(p => p.classList.toggle('arm', !!S.tool || !!pendingSig));
  const on = !!S.tool || !!pendingSig;
  $('#placing').hidden = !on;
  if (on) $('#placingText').textContent = pendingSig ? 'Tap the page to place your signature' : PROMPT[S.tool];
}
$('#placingCancel').addEventListener('click', () => { S.tool = null; pendingSig = null; reflectTool(); });

/* ------------------------------------------------------- placing / editing */
let pendingSig = null;

pagesEl.addEventListener('pointerdown', e => {
  if (!e.isPrimary) return;
  const pageEl = e.target.closest('.page');
  if (!pageEl) return;

  const handle = e.target.closest('.handle');
  const itEl = e.target.closest('.it');
  if (handle && itEl) return startResize(e, itEl);
  if (itEl) return startDrag(e, itEl);

  const pi = +pageEl.dataset.i;
  const r = pageEl.getBoundingClientRect();
  // the page as the user sees it right now is the frame we place into
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;

  if (S.tool === 'redact') { e.preventDefault(); return startRubber(e, pi, x, y); }
  if (S.tool || pendingSig) { e.preventDefault(); return place(pi, x, y); }
  if (S.sel) select(null);
});

function place(pi, x, y) {
  const p = S.pageBox[pi];
  const rot = totalRot(p);
  const [Wl, Hl] = localDims(p.lw, p.lh, rot);
  const id = uid();
  let it;
  if (pendingSig) {
    const w = DEF.sigW;
    const h = (w * Wl * pendingSig.ar) / Hl;
    it = { id, page: pi, rot, type: 'sig', x: clamp(x - w / 2, 0, 1 - w), y: clamp(y - h / 2, 0, 1 - h),
           w, ar: pendingSig.ar, src: pendingSig.src, stampMode: pendingSig.stamp ? 'datetime' : 'none' };
    push(); S.items.push(it); itemEl(it);
    if (it.stampMode !== 'none') addStamp(it);
    pendingSig = null; S.tool = null; reflectTool(); select(id);
    saveSoon(); return;
  }
  if (S.tool === 'text' || S.tool === 'date') {
    it = { id, page: pi, rot, type: 'text', x: clamp(x, 0, .97), y: clamp(y - DEF.fs * .62, 0, .99),
           fs: DEF.fs, color: COLORS[0], text: '' };
    if (S.tool === 'date') it.date = { at: Date.now(), fmt: 0 };
  } else if (S.tool === 'redact') {
    it = { id, page: pi, rot, type: 'redact', x: clamp(x - DEF.redW / 2, 0, 1 - DEF.redW),
           y: clamp(y - DEF.redH / 2, 0, 1 - DEF.redH), w: DEF.redW, h: DEF.redH };
  } else {
    const s = DEF.mark;
    it = { id, page: pi, rot, type: S.tool, x: clamp(x - (s * Hl / Wl) / 2, 0, 1),
           y: clamp(y - s / 2, 0, 1 - s), size: s, color: COLORS[0] };
  }
  push();
  S.items.push(it);
  const d = itemEl(it);
  S.tool = null; reflectTool();
  select(id);
  if (isText(it) && !it.date) edit(d);
}

function addStamp(sig) {
  const [Wl, Hl] = itemFrame(sig);
  const sigH = (sig.w * Wl * sig.ar) / Hl;
  const st = {
    id: uid(), page: sig.page, rot: sig.rot, type: 'text',
    x: sig.x, y: clamp(sig.y + sigH + 0.004, 0, 1),
    fs: DEF.stampFs, color: COLORS[0],
    text: '', link: sig.id,
    date: { at: Date.now(), fmt: sig.stampMode === 'date' ? 1 : 3 },
  };
  S.items.push(st);
  itemEl(st);
  return st;
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
  const move = ev => {
    x1 = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
    y1 = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
    if (Math.abs(x1 - x0) * Wl > 6 || Math.abs(y1 - y0) * Hl > 6) moved = true;
    draw();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
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
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
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
    if (!it.text.trim()) removeItem(it.id);
    saveSoon();
  };
  t.onkeydown = ev => { if (ev.key === 'Escape') t.blur(); };
}

function removeItem(id) {
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

/* drag */
function startDrag(e, d) {
  const it = S.items.find(i => i.id === d.dataset.id);
  if (!it) return;
  const wasSel = S.sel === it.id;
  select(it.id);
  const ce = d.firstChild?.contentEditable;
  if (ce === 'true' || ce === 'plaintext-only') return;

  const p = S.pageBox[it.page];
  const spin = norm4(totalRot(p) - it.rot);
  const [Wl, Hl] = itemFrame(it);
  const sx = e.clientX, sy = e.clientY;
  const st = it.type === 'sig' && !stampOf(it)?.detached ? stampOf(it) : null;
  const o = { x: it.x, y: it.y, sx: st?.x, sy: st?.y };
  let moved = false;
  d.setPointerCapture(e.pointerId);
  e.preventDefault();

  const move = ev => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) { moved = true; push(); }
    if (!moved) return;
    const [px, py] = unspin(spin, ev.clientX - sx, ev.clientY - sy);
    const dx = px / Wl, dy = py / Hl;
    it.x = clamp(o.x + dx, -0.06, 1.03); it.y = clamp(o.y + dy, -0.03, 1.0);
    sizeItem(it, d);
    if (st) { st.x = o.sx + dx; st.y = o.sy + dy; const sd = elOf(st.id); if (sd) sizeItem(st, sd); }
  };
  const up = () => {
    d.removeEventListener('pointermove', move);
    d.removeEventListener('pointerup', up);
    d.removeEventListener('pointercancel', up);
    if (!moved && isText(it) && !it.date && wasSel) edit(d);
    if (moved) { if (it.link) it.detached = true; saveSoon(); }
  };
  d.addEventListener('pointermove', move);
  d.addEventListener('pointerup', up);
  d.addEventListener('pointercancel', up);
}

/* resize */
function startResize(e, d) {
  const it = S.items.find(i => i.id === d.dataset.id);
  if (!it) return;
  select(it.id);
  const p = S.pageBox[it.page];
  const spin = norm4(totalRot(p) - it.rot);
  const [Wl, Hl] = itemFrame(it);
  const sx = e.clientX, sy = e.clientY;
  const o = { fs: it.fs, w: it.w, h: it.h, size: it.size };
  let started = false;
  d.setPointerCapture(e.pointerId);
  e.preventDefault(); e.stopPropagation();

  const move = ev => {
    if (!started) { started = true; push(); }
    const [ppx, ppy] = unspin(spin, ev.clientX - sx, ev.clientY - sy);
    const dx = ppx / Wl, dy = ppy / Hl;
    if (isText(it)) it.fs = clamp(o.fs + dy * 0.6 + dx * 0.15, 0.005, 0.14);
    else if (it.type === 'sig') it.w = clamp(o.w + dx, 0.04, 1.2);          // aspect locked
    else if (it.type === 'redact') { it.w = clamp(o.w + dx, 0.008, 1.2); it.h = clamp(o.h + dy, 0.004, 1.0); }
    else it.size = clamp(o.size + dy, 0.006, 0.35);
    sizeItem(it, d);
  };
  const up = () => {
    d.removeEventListener('pointermove', move);
    d.removeEventListener('pointerup', up);
    d.removeEventListener('pointercancel', up);
    saveSoon();
  };
  d.addEventListener('pointermove', move);
  d.addEventListener('pointerup', up);
  d.addEventListener('pointercancel', up);
}

/* selection bar */
$$('#swatches .sw').forEach(b => b.addEventListener('click', () => {
  const it = getSel(); if (!it) return;
  push(); it.color = b.dataset.color;
  paintItems(); select(it.id);
}));
const bump = f => {
  const it = getSel(); if (!it) return;
  push();
  if (isText(it)) it.fs = clamp(it.fs * f, 0.005, 0.14);
  else if (it.type === 'sig') it.w = clamp(it.w * f, 0.04, 1.2);
  else if (it.type === 'redact') { it.w = clamp(it.w * f, 0.008, 1.2); it.h = clamp(it.h * f, 0.004, 1); }
  else it.size = clamp(it.size * f, 0.006, 0.35);
  relayoutItems(); saveSoon();
};
$('#btnBigger').addEventListener('click', () => bump(1.15));
$('#btnSmaller').addEventListener('click', () => bump(1 / 1.15));
$('#btnDelete').addEventListener('click', () => { const it = getSel(); if (it) { push(); removeItem(it.id); } });
$('#btnDupe').addEventListener('click', () => {
  const it = getSel(); if (!it) return;
  push();
  const c = { ...it, id: uid(), link: undefined, stampMode: it.type === 'sig' ? 'none' : it.stampMode,
              x: clamp(it.x + 0.03, 0, 1), y: clamp(it.y + 0.03, 0, 1) };
  if (c.date) c.date = { ...it.date };
  S.items.push(c); itemEl(c); select(c.id); saveSoon();
});

function reorder(dir) {
  const it = getSel(); if (!it) return;
  const idx = S.items.indexOf(it);
  const sib = dir > 0
    ? S.items.findIndex((x, i) => i > idx && x.page === it.page)
    : [...S.items].reduce((acc, x, i) => (i < idx && x.page === it.page ? i : acc), -1);
  if (sib < 0) return toast(dir > 0 ? 'Already in front.' : 'Already behind.');
  push();
  S.items.splice(idx, 1);
  S.items.splice(sib, 0, it);
  paintItems(); select(it.id); saveSoon();
}
$('#btnFwd').addEventListener('click', () => reorder(1));
$('#btnBack2').addEventListener('click', () => reorder(-1));

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

document.addEventListener('keydown', e => {
  if ($('#editor').hidden) return;
  if (document.activeElement?.isContentEditable || document.activeElement?.tagName === 'INPUT') return;
  if ((e.key === 'Backspace' || e.key === 'Delete') && S.sel) { e.preventDefault(); push(); removeItem(S.sel); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
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
function openRotate() {
  const i = currentPage();
  $('#rotSheet').dataset.page = i;
  $('#rotPage').textContent = `Page ${i + 1} of ${S.pageBox.length}`;
  $('#rotSheet').hidden = false;
}
$$('[data-rot]').forEach(b => b.addEventListener('click', () => {
  const deg = +b.dataset.rot;
  const all = $('#rotAll').checked;
  const i = +$('#rotSheet').dataset.page;
  push();
  (all ? S.pageBox : [S.pageBox[i]]).forEach(p => { p.userRot = deg; p.renderKey = null; });
  layoutPages(); renderVisible(); saveSoon();
  $('#rotSheet').hidden = true;
}));

/* ============================================================== SIGNATURE */
const sigSheet = $('#sigSheet');
const pad = $('#pad');
let padCtx, strokes = [], cur = null, sigColor = COLORS[0], sigTab = 'draw';
let typedFont = 'Caveat', photoBmp = null, photoOut = null;

const FONTS = [
  { name: 'Caveat', stack: `'FS Caveat', 'Segoe Script', 'Bradley Hand', cursive` },
  { name: 'Dancing', stack: `'FS Dancing', 'Snell Roundhand', 'Brush Script MT', cursive` },
];

function openSig() {
  sigSheet.hidden = false;
  setupPad(); drawFontOptions(); refreshSaved(); updateUse();
}
$$('[data-close]').forEach(b => b.addEventListener('click', () => { b.closest('.sheet-wrap').hidden = true; }));
$$('.tab').forEach(t => t.addEventListener('click', () => {
  sigTab = t.dataset.tab;
  $$('.tab').forEach(x => x.classList.toggle('is-on', x === t));
  $$('.pane').forEach(p => (p.hidden = p.dataset.pane !== sigTab));
  updateUse();
}));
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

function redrawPad() { if (!padCtx) return; padCtx.clearRect(0, 0, pad.width, pad.height); strokeAll(padCtx, strokes, sigColor, 2.6); }
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

async function buildSignature() {
  if (sigTab === 'photo') return photoOut;
  if (sigTab === 'draw') {
    const r = pad.getBoundingClientRect(), K = 3;
    const c = document.createElement('canvas');
    c.width = Math.round(r.width * K); c.height = Math.round(r.height * K);
    const ctx = c.getContext('2d'); ctx.scale(K, K);
    strokeAll(ctx, strokes, sigColor, 2.6);
    return trimCanvas(c).toDataURL('image/png');
  }
  const name = $('#typeName').value.trim();
  const f = FONTS.find(x => x.name === typedFont);
  try { await document.fonts.load(`64px ${f.stack.split(',')[0]}`, name); } catch (_) {}
  const size = 150;
  const m = document.createElement('canvas').getContext('2d');
  m.font = `${size}px ${f.stack}`;
  const c = document.createElement('canvas');
  c.width = Math.ceil(m.measureText(name).width) + size;
  c.height = Math.round(size * 2.1);
  const ctx = c.getContext('2d');
  ctx.font = `${size}px ${f.stack}`; ctx.fillStyle = sigColor; ctx.textBaseline = 'middle';
  ctx.fillText(name, size / 2, c.height / 2);
  return trimCanvas(c).toDataURL('image/png');
}

async function armSignature(src, withStamp) {
  const img = new Image(); img.src = src; await img.decode();
  pendingSig = { src, ar: img.height / img.width, stamp: withStamp };
  sigSheet.hidden = true;
  S.tool = null; reflectTool();
}
$('#sigUse').addEventListener('click', async () => {
  busy(true, 'Preparing…');
  try {
    const src = await buildSignature();
    if (!src) return;
    await armSignature(src, $('#sigStamp').checked);
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
    b.onclick = () => armSignature(src, $('#sigStamp').checked);
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
async function rasterPage(pi, items) {
  const p = S.pageBox[pi];
  const page = await S.pdf.getPage(pi + 1);
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

async function buildPdf() {
  const src = await PDFDocument.load(S.bytes.slice(0), { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);

  const byPage = S.pageBox.map(() => []);
  S.items.forEach(it => { if (!isText(it) || textOf(it).trim()) byPage[it.page].push(it); });

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
      const png = await rasterPage(i, items);
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
          const a = anchor(it, it.x, it.y + it.fs * BASELINE + k * it.fs * LINEH);
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
  }

  out.setProducer('Fill & Sign — free PDF fill and sign by Eli Otterholt');
  out.setCreator('Fill & Sign');
  return new Blob([await out.save({ useObjectStreams: false })], { type: 'application/pdf' });
}

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
  $('#doneNote').textContent = reds
    ? `Everything you added is now part of the document. ${reds} blackout${reds > 1 ? 's were' : ' was'} baked permanently into the page.`
    : 'Everything you added is now part of the document. Nothing was uploaded.';
  $('#saveName').value = outName();
  $('#btnShare').hidden = !canShareFiles();
  $('#editor').hidden = true;
  $('#done').hidden = false;
});

$('#btnContinue').addEventListener('click', () => { $('#done').hidden = true; $('#editor').hidden = false; });

function finalName() {
  let n = ($('#saveName').value || outName()).replace(/[\\/:*?"<>|]/g, '').trim() || outName();
  if (!/\.pdf$/i.test(n)) n += '.pdf';
  return n;
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
  try {
    await navigator.share({ files: [new File([lastBlob], name, { type: 'application/pdf' })], title: name });
  } catch (e) {
    if (e.name !== 'AbortError') toast('Sharing is not available here — use Save PDF instead.');
  }
});

/* ============================================================ DRAFTS / OPEN */
async function checkResume() {
  try {
    const d = await DB.get('doc');
    if (d && Date.now() - (d.ts || 0) > DRAFT_TTL) { await DB.del('doc'); }
    const fresh = await DB.get('doc');
    const has = fresh && fresh.bytes && (fresh.items?.length || 0) > 0;
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
    if (d) await loadDoc(d.bytes, d.name, d.items, d.rots);
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
$('#moreTools').addEventListener('click', e => {
  e.preventDefault();
  toast('Coming soon — email otterholteli@gmail.com in the meantime.', 3200);
});

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

window.__fs = { S, loadDoc, buildPdf, FMTS };
