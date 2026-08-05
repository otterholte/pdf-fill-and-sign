/* Shrink — make an image file smaller, on your own device.
   Built by Eli Otterholt. otterholteli@gmail.com

   Everything here runs in the page. The file is decoded by the browser,
   redrawn onto a canvas at a smaller size, and re-encoded. There is no
   server, no upload, no storage — close the tab and nothing of it remains. */

'use strict';

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), ms);
}

/* Human sizes. Below a megabyte people think in KB, above it in MB. */
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  const mb = n / (1024 * 1024);
  return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
}

/* ------------------------------------------------------------- settings */
const LEVELS = {
  light:    { max: 2560, q: 0.82 },
  balanced: { max: 1920, q: 0.72 },
  max:      { max: 1280, q: 0.56 },
};
let level = 'balanced';
let useTarget = false;
let targetMb = 1;

/* ---------------------------------------------------------------- encode */
const cv = document.createElement('canvas');
const cx = cv.getContext('2d', { alpha: true });

const blobOf = (type, q) => new Promise(res => cv.toBlob(res, type, q));

/** draw the bitmap at `scale` and encode it */
async function render(bmp, scale, type, q) {
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  cv.width = w; cv.height = h;
  cx.clearRect(0, 0, w, h);
  if (type === 'image/jpeg') { cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); }
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(bmp, 0, 0, w, h);
  const b = await blobOf(type, q);
  await new Promise(requestAnimationFrame);          // let the page breathe
  return b || new Blob();
}

/** Does this image actually use its alpha channel? Sampling a grid is
    enough — a transparent background shows up in the first few dozen taps. */
function hasAlpha(bmp) {
  const n = 96;
  const s = Math.min(1, n / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  cv.width = w; cv.height = h;
  cx.clearRect(0, 0, w, h);
  cx.drawImage(bmp, 0, 0, w, h);
  try {
    const d = cx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  } catch (_) { /* tainted canvas cannot happen for a local file */ }
  return false;
}

const supportsWebp = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  return c.toDataURL('image/webp').startsWith('data:image/webp');
})();

/** Squeeze to a byte budget: quality first, dimensions only if it must. */
async function toTarget(bmp, target, type) {
  const cap = 4096;
  let scale = Math.min(1, cap / Math.max(bmp.width, bmp.height));
  let out = await render(bmp, scale, type, 0.8);

  if (out.size <= target) {
    for (const q of [0.9, 0.95]) {                   // room to spare — spend it on quality
      const b = await render(bmp, scale, type, q);
      if (b.size <= target) out = b; else break;
    }
    return out;
  }

  /* Quality first at the current size; if even the lowest quality is too
     big, the picture itself has to get smaller. File size tracks pixel
     count, so the measured overshoot says roughly how far to drop. */
  let smallest = out;
  for (let pass = 0; pass < 6; pass++) {
    let lo = 0.32, hi = 0.8, best = null;
    for (let i = 0; i < 5; i++) {
      const q = (lo + hi) / 2;
      const b = await render(bmp, scale, type, q);
      if (b.size < smallest.size) smallest = b;
      if (b.size <= target) { best = b; lo = q; } else hi = q;
    }
    if (best) return best;

    const floor = await render(bmp, scale, type, 0.32);
    if (floor.size < smallest.size) smallest = floor;
    if (floor.size <= target) return floor;

    const next = scale * clamp(Math.sqrt(target / floor.size) * 0.94, 0.3, 0.86);
    if (Math.max(bmp.width, bmp.height) * next < 180) break;
    scale = next;
  }
  return smallest;                                   // as close as it can get
}

const outName = (name, type) => {
  const ext = type === 'image/webp' ? '.webp' : '.jpg';
  return name.replace(/\.[^.]+$/, '') + '-small' + ext;
};

/** the whole job for one file */
async function shrinkOne(rec) {
  const file = rec.file;
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    try { bmp = await createImageBitmap(file); }
    catch (_) {
      rec.error = /heic|heif/i.test(file.type + file.name)
        ? 'This browser cannot open HEIC photos. Export it as a JPEG first.'
        : 'This file could not be opened as an image.';
      return rec;
    }
  }

  const keepAlpha = supportsWebp && hasAlpha(bmp);
  const type = keepAlpha ? 'image/webp' : 'image/jpeg';

  let blob;
  if (useTarget) {
    blob = await toTarget(bmp, Math.round(targetMb * 1024 * 1024), type);
  } else {
    const L = LEVELS[level];
    const scale = Math.min(1, L.max / Math.max(bmp.width, bmp.height));
    blob = await render(bmp, scale, type, L.q);
  }

  /* An already-tuned JPEG can come back bigger — and shaving a few percent
     off one is not worth the quality it costs. Below a tenth, hand back what
     they gave us and say so. */
  if (blob.size >= file.size * 0.9 && !useTarget) {
    rec.blob = file; rec.type = file.type; rec.untouched = true;
  } else if (blob.size >= file.size && useTarget && file.size <= targetMb * 1024 * 1024) {
    rec.blob = file; rec.type = file.type; rec.untouched = true;
  } else {
    rec.blob = blob; rec.type = type;
  }
  rec.w = bmp.width; rec.h = bmp.height;
  rec.name = rec.untouched ? file.name : outName(file.name, rec.type);
  rec.missed = useTarget && rec.blob.size > targetMb * 1024 * 1024;
  bmp.close?.();
  return rec;
}

/* ------------------------------------------------------------------ list */
const recs = [];
let seq = 0;

function cardEl(rec) {
  const d = document.createElement('div');
  d.className = 'card is-busy';
  d.dataset.id = rec.id;
  d.innerHTML = `
    <img class="thumb" alt="">
    <div class="card-text">
      <div class="card-name"></div>
      <div class="card-size"><span class="was"></span></div>
      <div class="bar"><i style="width:0"></i></div>
    </div>
    <div class="card-act">
      <button class="icon-btn js-save" aria-label="Save">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 11l4.5 4.5 4.5-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <button class="icon-btn js-drop" aria-label="Remove">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>`;
  d.querySelector('.card-name').textContent = rec.file.name;
  d.querySelector('.was').textContent = fmtSize(rec.file.size) + ' · working…';
  d.querySelector('.js-save').addEventListener('click', () => saveOne(rec));
  d.querySelector('.js-drop').addEventListener('click', () => dropOne(rec));
  rec.thumbUrl = URL.createObjectURL(rec.file);
  d.querySelector('.thumb').src = rec.thumbUrl;
  $('#cards').append(d);
  return d;
}

function paintCard(rec) {
  const d = $(`.card[data-id="${rec.id}"]`);
  if (!d) return;
  d.classList.remove('is-busy');
  const size = d.querySelector('.card-size');
  const bar = d.querySelector('.bar i');

  if (rec.error) {
    size.innerHTML = `<span class="bad"></span>`;
    size.firstChild.textContent = rec.error;
    bar.style.width = '0';
    d.querySelector('.js-save').disabled = true;
    return;
  }

  d.querySelector('.card-name').textContent = rec.name;
  const cut = clamp(Math.round(100 - (rec.blob.size / rec.file.size) * 100), 0, 99);
  if (rec.untouched) {
    size.innerHTML = `<span class="was">${fmtSize(rec.file.size)}</span> <span class="warn">· already about as small as it gets</span>`;
    bar.style.width = '4%';
  } else {
    size.innerHTML =
      `<span class="was">${fmtSize(rec.file.size)}</span> → ` +
      `<span class="now">${fmtSize(rec.blob.size)}</span> ` +
      `<span class="cut">${cut}% smaller</span>` +
      (rec.missed ? ` <span class="warn">· smallest possible</span>` : '');
    bar.style.width = clamp(cut, 3, 100) + '%';
  }
}

function tally() {
  const done = recs.filter(r => r.blob && !r.error);
  $('#results').hidden = recs.length === 0;
  if (!done.length) { $('#tally').textContent = recs.length ? 'Working…' : ''; return; }
  const was = done.reduce((a, r) => a + r.file.size, 0);
  const now = done.reduce((a, r) => a + r.blob.size, 0);
  const cut = clamp(Math.round(100 - (now / was) * 100), 0, 99);
  $('#tally').innerHTML = done.length === 1
    ? `${fmtSize(was)} → ${fmtSize(now)} · <em>${cut}% smaller</em>`
    : `${done.length} images · ${fmtSize(was)} → ${fmtSize(now)} · <em>${cut}% smaller</em>`;
  $('#btnSaveAll').textContent = done.length === 1 ? 'Save image' : `Save all ${done.length}`;
  $('#btnShareAll').hidden = !canShare(done);
}

const canShare = done => {
  try {
    return !!navigator.canShare && navigator.canShare({
      files: done.map(r => new File([r.blob], r.name, { type: r.type })),
    });
  } catch (_) { return false; }
};

/* --------------------------------------------------------------- actions */
let running = false;
async function runQueue() {
  if (running) return;
  running = true;
  try {
    for (const rec of recs) {
      if (rec.blob || rec.error) continue;
      await shrinkOne(rec);
      paintCard(rec);
      tally();
    }
  } finally { running = false; }
}

function add(files) {
  const imgs = [...files].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif|tiff?)$/i.test(f.name));
  if (!imgs.length) return toast('Those files are not images.');
  for (const f of imgs) {
    const rec = { id: 'r' + (++seq), file: f };
    recs.push(rec);
    cardEl(rec);
  }
  $('#results').hidden = false;
  tally();
  runQueue();
}

/** redo everything at the new setting */
function recompute() {
  if (!recs.length) return;
  recs.forEach(r => {
    r.blob = null; r.error = null; r.untouched = false; r.missed = false;
    const d = $(`.card[data-id="${r.id}"]`);
    if (d) {
      d.classList.add('is-busy');
      d.querySelector('.js-save').disabled = false;
      d.querySelector('.card-size').innerHTML = `<span class="was">${fmtSize(r.file.size)} · working…</span>`;
      d.querySelector('.bar i').style.width = '0';
    }
  });
  tally();
  runQueue();
}

function download(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 20000);
}

function saveOne(rec) {
  if (!rec.blob) return toast('Still working on that one.');
  download(rec.blob, rec.name);
}

function dropOne(rec) {
  const i = recs.indexOf(rec);
  if (i >= 0) recs.splice(i, 1);
  if (rec.thumbUrl) URL.revokeObjectURL(rec.thumbUrl);
  $(`.card[data-id="${rec.id}"]`)?.remove();
  tally();
  if (!recs.length) $('#results').hidden = true;
}

/* ----------------------------------------------------------------- wiring */
document.querySelectorAll('.lev').forEach(b => b.addEventListener('click', () => {
  level = b.dataset.lev;
  document.querySelectorAll('.lev').forEach(x => x.classList.toggle('is-on', x === b));
  if (useTarget) { useTarget = false; $('#useTarget').checked = false; $('#targetIn').hidden = true; }
  recompute();
}));

$('#useTarget').addEventListener('change', e => {
  useTarget = e.target.checked;
  $('#targetIn').hidden = !useTarget;
  document.querySelectorAll('.lev').forEach(x => x.classList.toggle('is-on', !useTarget && x.dataset.lev === level));
  recompute();
});

let mbT;
$('#targetMb').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (!isFinite(v) || v <= 0) return;
  targetMb = clamp(v, 0.02, 50);
  clearTimeout(mbT);
  mbT = setTimeout(() => { if (useTarget) recompute(); }, 550);
});

$('#btnOpen').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', e => { add(e.target.files); e.target.value = ''; });

$('#btnClear').addEventListener('click', () => {
  recs.forEach(r => r.thumbUrl && URL.revokeObjectURL(r.thumbUrl));
  recs.length = 0;
  $('#cards').innerHTML = '';
  $('#results').hidden = true;
});

$('#btnSaveAll').addEventListener('click', async () => {
  const done = recs.filter(r => r.blob && !r.error);
  if (!done.length) return toast('Nothing finished yet.');
  for (const r of done) {
    download(r.blob, r.name);
    await new Promise(res => setTimeout(res, 220));   // browsers throttle a burst
  }
});

$('#btnShareAll').addEventListener('click', async () => {
  const done = recs.filter(r => r.blob && !r.error);
  if (!done.length) return;
  const files = done.map(r => new File([r.blob], r.name, { type: r.type }));
  try { await navigator.share({ files }); }
  catch (err) { if (err?.name !== 'AbortError') toast('Sharing is not available here — use Save instead.'); }
});

/* drop anywhere on the page */
const drop = $('#drop');
['dragenter', 'dragover'].forEach(k => document.addEventListener(k, e => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault(); drop.classList.add('over');
}));
['dragleave', 'drop'].forEach(k => document.addEventListener(k, e => {
  if (k === 'drop') e.preventDefault();
  if (k === 'dragleave' && e.relatedTarget) return;
  drop.classList.remove('over');
}));
document.addEventListener('drop', e => {
  const f = e.dataTransfer?.files;
  if (f?.length) add(f);
});

/* paste a screenshot straight in */
document.addEventListener('paste', e => {
  const f = [...(e.clipboardData?.files || [])];
  if (f.length) { e.preventDefault(); add(f); }
});

/* a shared or opened image, when installed as an app */
if ('launchQueue' in window) {
  try {
    window.launchQueue.setConsumer(async lp => {
      if (!lp?.files?.length) return;
      const files = await Promise.all(lp.files.map(h => h.getFile()));
      add(files);
    });
  } catch (_) {}
}

/* keep working with no signal */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.__shrink = { recs, shrinkOne, toTarget, LEVELS, fmtSize,
                    set: (l, t, mb) => { level = l; useTarget = t; targetMb = mb; } };
