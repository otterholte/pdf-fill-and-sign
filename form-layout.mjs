/* Local form geometry. No model, network request, form-specific coordinates, or
   stored answers. All coordinates exposed to the editor are normalized. */
const overlap = (a0, a1, b0, b1) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const middle = (a) => (a.y0 + a.y1) / 2;

export function detectRules(image) {
  const { width: W, height: H, data } = image;
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < ink.length; i++)
    ink[i] =
      Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) < 215 ? 1 : 0;
  function run(vertical) {
    const length = vertical ? H : W,
      count = vertical ? W : H;
    const minimum = Math.max(
      18,
      Math.round(length * (vertical ? 0.03 : 0.045)),
    );
    const segments = [];
    for (let row = 0; row < count; row++) {
      let start = -1,
        last = -1,
        hits = 0;
      for (let col = 0; col <= length + 2; col++) {
        const dark =
          col < length && ink[vertical ? col * W + row : row * W + col];
        if (dark) {
          if (start < 0) start = col;
          last = col;
          hits++;
        } else if (start >= 0 && col - last > 2) {
          if (last - start + 1 >= minimum && hits / (last - start + 1) > 0.88)
            segments.push({ row, start, end: last });
          start = -1;
          hits = 0;
        }
      }
    }
    const bands = [];
    for (const s of segments) {
      const b = bands.findLast(
        (b) =>
          s.row - b.r1 <= 3 &&
          s.row >= b.r0 &&
          overlap(s.start, s.end, b.start, b.end) >
            0.78 * Math.min(s.end - s.start, b.end - b.start),
      );
      if (b) {
        b.r1 = s.row;
        b.start = Math.min(b.start, s.start);
        b.end = Math.max(b.end, s.end);
      } else bands.push({ r0: s.row, r1: s.row, start: s.start, end: s.end });
    }
    return bands
      .filter((b) => b.r1 - b.r0 < Math.max(8, minimum * 0.3))
      .map((b) =>
        vertical
          ? { x0: b.r0 / W, x1: b.r1 / W, y0: b.start / H, y1: b.end / H }
          : { x0: b.start / W, x1: b.end / W, y0: b.r0 / H, y1: b.r1 / H },
      );
  }
  const horizontal = run(false)
    .sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0))
    .filter(
      (r, i, all) =>
        !all
          .slice(0, i)
          .some(
            (b) =>
              Math.abs(middle(r) - middle(b)) < 3 / H &&
              r.x0 >= b.x0 - 0.002 &&
              r.x1 <= b.x1 + 0.002,
          ),
    );
  return { horizontal, vertical: run(true), width: W, height: H };
}

/** Establish rows before joining words; sorting by tiny baseline differences
    first used to concatenate distant labels and drop half a question. */
export function phraseWords(words, rules = { vertical: [] }) {
  const rows = [];
  for (const w of [...words].sort((a, b) => a.cy - b.cy || a.x0 - b.x0)) {
    let row = rows.findLast(
      (r) => Math.abs(r.cy - w.cy) < Math.max(r.h, w.h) * 0.55,
    );
    if (!row) rows.push((row = { cy: w.cy, h: w.h, words: [] }));
    row.words.push(w);
    row.h = Math.max(row.h, w.h);
  }
  return rows.flatMap((row) => {
    const phrases = [];
    for (const w of row.words.sort((a, b) => a.x0 - b.x0)) {
      const prev = phrases.at(-1);
      const divided =
        prev &&
        rules.vertical.some(
          (v) =>
            v.x0 > prev.x1 && v.x0 < w.x0 && row.cy >= v.y0 && row.cy <= v.y1,
        );
      if (prev && !divided && w.x0 - prev.x1 < Math.max(prev.h, w.h) * 1.2) {
        prev.s += " " + w.s;
        prev.x1 = w.x1;
        prev.h = Math.max(prev.h, w.h);
      } else phrases.push({ ...w });
    }
    return phrases;
  });
}

export function detectRings(image) {
  const { width: W, height: H, data } = image,
    seen = new Uint8Array(W * H);
  const queue = new Int32Array(W * H),
    out = [];
  const dark = (i) => data[i * 4] < 210;
  for (let seed = 0; seed < seen.length; seed++) {
    if (seen[seed] || !dark(seed)) continue;
    let head = 0,
      tail = 1;
    queue[0] = seed;
    seen[seed] = 1;
    let l = W,
      r = 0,
      t = H,
      b = 0;
    while (head < tail) {
      const i = queue[head++],
        x = i % W,
        y = (i / W) | 0;
      l = Math.min(l, x);
      r = Math.max(r, x);
      t = Math.min(t, y);
      b = Math.max(b, y);
      for (const n of [
        x > 0 ? i - 1 : -1,
        x + 1 < W ? i + 1 : -1,
        y > 0 ? i - W : -1,
        y + 1 < H ? i + W : -1,
        x > 0 && y > 0 ? i - W - 1 : -1,
        x + 1 < W && y > 0 ? i - W + 1 : -1,
        x > 0 && y + 1 < H ? i + W - 1 : -1,
        x + 1 < W && y + 1 < H ? i + W + 1 : -1,
      ])
        if (n >= 0 && !seen[n] && dark(n)) {
          seen[n] = 1;
          queue[tail++] = n;
        }
    }
    const w = r - l + 1,
      h = b - t + 1;
    if (
      h < H * 0.009 ||
      h > H * 0.022 ||
      w / h < 0.78 ||
      w / h > 1.22 ||
      tail / (w * h) > 0.58
    )
      continue;
    let center = 0;
    for (let y = t + Math.round(h * 0.3); y < b - h * 0.3; y++)
      for (let x = l + Math.round(w * 0.3); x < r - w * 0.3; x++)
        if (dark(y * W + x)) center++;
    if (center > 2) continue;
    // Round outlines have clear corners; squares stay on the existing box path.
    let corners = 0;
    for (const [x, y] of [
      [l, t],
      [r, t],
      [l, b],
      [r, b],
    ])
      if (dark(y * W + x)) corners++;
    if (corners >= 3) continue;
    out.push({
      x0: l / W,
      x1: r / W,
      y0: t / H,
      y1: b / H,
      cx: (l + r) / 2 / W,
      cy: (t + b) / 2 / H,
      w: w / W,
      h: h / H,
      shape: "circle",
    });
  }
  return out;
}

const clean = (s) =>
  (s || "")
    .replace(/[|_]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:.,-]+|[\s:.,-]+$/g, "")
    .trim();
const meaningful = (w) => /[a-z]{2}/i.test(w.s);
const contents = (words, r) =>
  words.filter(
    (w) =>
      meaningful(w) &&
      w.cy > r.y0 + 0.001 &&
      w.cy < r.y1 - 0.001 &&
      w.x0 >= r.x0 - 0.002 &&
      w.x1 <= r.x1 + 0.002,
  );
const said = (words) =>
  clean(
    phraseWords(words)
      .map((w) => w.s)
      .join(" "),
  );
export function fieldType(label, kind = "text") {
  if (kind === "box") return "choice";
  if (/\bsignature\b|\bsign here\b/i.test(label)) return "signature";
  if (/\be-?mail\b/i.test(label)) return "email";
  if (/\bphone\b|\btelephone\b|\bmobile\b/i.test(label)) return "tel";
  if (/\bdate\b|\bbirth\b|\bd\.?o\.?b\b/i.test(label)) return "date";
  return "text";
}

/** Refine existing scan evidence using printed structure. No answer text is
    consulted. The old pixel scanner remains the fallback for unruled pages. */
export function analyzeForm(rawWords, rules, base, rings = []) {
  const words = rawWords.filter(meaningful),
    phrases = phraseWords(words, rules);
  const hs = rules.horizontal,
    vs = rules.vertical;
  const sections = [];
  for (const h of hs.filter((h) => h.x1 - h.x0 > 0.55)) {
    const title = phrases.find(
      (w) =>
        w.x0 > h.x0 &&
        w.x0 < h.x0 + 0.08 &&
        w.cy > h.y1 + 0.003 &&
        w.cy < h.y1 + 0.02 &&
        w.x1 < h.x0 + 0.38,
    );
    const enclosed = vs.some(
      (v) =>
        Math.abs(v.x0 - h.x0) < 0.005 &&
        Math.abs(v.y0 - h.y0) < 0.006 &&
        v.y1 > h.y0 + 0.035,
    );
    if (
      title &&
      enclosed &&
      !sections.some((s) => Math.abs(s.y - title.cy) < 0.02)
    )
      sections.push({ label: clean(title.s), y: title.cy, x0: h.x0, x1: h.x1 });
  }
  sections.sort((a, b) => a.y - b.y);
  const sectionAt = (y) => sections.findLast((s) => s.y < y)?.label || "";
  const cellsAll = (base.cellsAll || base.cells || []).map((c) => ({
    ...c,
    ...(c.box || {}),
  }));
  const lines = [],
    cells = [];
  const occupied = [];
  function addCell(rect, label, source = "grid", extras = {}) {
    const c = {
      ...rect,
      w: rect.x1 - rect.x0,
      h: rect.y1 - rect.y0,
      cx: (rect.x0 + rect.x1) / 2,
      cy: middle(rect),
      label: clean(label),
      source,
      section: sectionAt(middle(rect)),
      ...extras,
    };
    c.inputType = fieldType(c.label);
    c.align = c.align || (c.w < 0.14 ? "center" : "left");
    c.multiline = extras.multiline ?? c.h > 0.025;
    if (
      c.w > 0.035 &&
      c.h > 0.009 &&
      !cells.some(
        (b) =>
          overlap(c.x0, c.x1, b.x0, b.x1) > 0.9 * c.w &&
          overlap(c.y0, c.y1, b.y0, b.y1) > 0.9 * c.h,
      )
    )
      cells.push(c);
  }
  // Same-column blank cells establish a table block, even if header rules are faint.
  const blanks = cellsAll.filter(
    (c) =>
      c.x1 - c.x0 < 0.5 &&
      c.y1 - c.y0 > 0.019 &&
      contents(words, c).length === 0,
  );
  for (const c of blanks) {
    const col = blanks.filter(
      (b) =>
        Math.abs(b.x0 - c.x0) < 0.008 &&
        Math.abs(b.x1 - c.x1) < 0.008 &&
        sectionAt(middle(b)) === sectionAt(middle(c)),
    );
    if (col.length < 2) continue;
    const first = Math.min(...col.map((b) => b.y0));
    const header = said(
      contents(words, {
        x0: c.x0 - 0.005,
        x1: c.x1 + 0.005,
        y0: first - 0.024,
        y1: first,
      }),
    );
    if (!header) continue;
    const rowLabelCells = cellsAll.filter(
      (b) =>
        b.x1 <= c.x0 + 0.004 &&
        overlap(b.y0, b.y1, c.y0, c.y1) > 0.5 * (c.y1 - c.y0) &&
        contents(words, b).length,
    );
    const rowLabel = rowLabelCells.sort((a, b) => a.x0 - b.x0)[0];
    let row = rowLabel ? said(contents(words, rowLabel)) : "";
    if (/^(from|to|ta)\b/i.test(row) || !row)
      row = "Entry " + (col.sort((a, b) => a.y0 - b.y0).indexOf(c) + 1);
    addCell(
      {
        x0: c.x0 + 0.002,
        x1: c.x1 - 0.002,
        y0: c.y0 + 0.002,
        y1: c.y1 - 0.002,
      },
      row ? `${row} — ${header}` : header,
      "grid",
      { columnLabel: header, rowLabel: row },
    );
    occupied.push(c);
  }
  // Caption-at-left cells: short date subrows, or full-width prose answers.
  for (const c of cellsAll) {
    const width = c.x1 - c.x0,
      height = c.y1 - c.y0;
    if (height > 0.05) continue;
    const own = contents(words, c);
    if (!own.length) continue;
    const row = phraseWords(own, rules).filter(
      (w) => w.cy > c.y1 - 0.025 && w.cy < c.y1 - 0.002,
    );
    if (width < 0.5 && !/^(from|to|ta)$/i.test(said(own))) continue;
    for (let i = 0; i < row.length; i++) {
      const label = row[i];
      if (sectionAt(label.cy + 0.001) === clean(label.s)) continue;
      const right = row[i + 1]?.x0 || c.x1;
      if (right - label.x1 < 0.055) continue;
      addCell(
        {
          x0: label.x1 + 0.012,
          x1: right - 0.01,
          y0:
            width < 0.5
              ? c.y0 + 0.001
              : Math.max(c.y0 + 0.002, label.cy - 0.009),
          y1: c.y1 - 0.001,
        },
        label.s,
        "inline",
        { align: "left", multiline: false },
      );
    }
  }
  // Preserve isolated captioned inputs that are not part of a repeated table.
  for (const original of base.cells || []) {
    const cap = original.cap;
    if (!cap || original.body || original.w > 0.5) continue;
    if (
      cells.some(
        (c) =>
          c.columnLabel &&
          c.x0 > original.x1 &&
          overlap(c.y0, c.y1, original.y0, original.y1) > 0.5 * original.h,
      )
    )
      continue;
    const label = said(contents(words, cap));
    if (
      !label ||
      sections.some(
        (s) =>
          s.label === label ||
          (s.y > cap.y0 && s.y < cap.y1 && original.x0 < s.x0 + 0.08),
      )
    )
      continue;
    if (
      cells.some(
        (c) =>
          overlap(c.x0, c.x1, original.x0, original.x1) > 0.5 * original.w &&
          overlap(c.y0, c.y1, original.y0, original.y1) > 0.5 * original.h,
      )
    )
      continue;
    addCell(
      {
        x0: original.x0 + 0.002,
        x1: original.x1 - 0.002,
        y0: original.y0 + 0.002,
        y1: original.y1 - 0.002,
      },
      label,
      "caption",
    );
  }
  // Open underlines are answers; closed table and section edges are not.
  for (const h of hs) {
    const y = h.y0,
      width = h.x1 - h.x0;
    if (width < 0.045 || sections.some((s) => Math.abs(s.y - y) < 0.012))
      continue;
    const upright = (x) =>
      vs.some(
        (v) =>
          Math.abs(v.x0 - x) < 0.005 && v.y0 < y + 0.003 && v.y1 > y - 0.003,
      );
    if (upright(h.x0) && upright(h.x1)) continue;
    if (
      cellsAll.some(
        (c) =>
          h.x0 >= c.x0 - 0.005 &&
          h.x1 <= c.x1 + 0.005 &&
          (Math.abs(c.y0 - y) < 0.005 || Math.abs(c.y1 - y) < 0.005),
      )
    )
      continue;
    if (
      phrases.some(
        (w) =>
          overlap(w.x0, w.x1, h.x0, h.x1) > width * 0.15 &&
          Math.abs(w.cy - y) < w.h * 0.5,
      )
    )
      continue;
    const left = phrases
      .filter(
        (w) =>
          w.x1 <= h.x0 + 0.006 &&
          h.x0 - w.x1 < 0.045 &&
          y - w.cy > -0.002 &&
          y - w.cy < 0.016,
      )
      .sort((a, b) => b.x1 - a.x1)[0];
    if (!left && width > 0.5) continue;
    if (
      sections.length &&
      (h.x0 < Math.min(...sections.map((s) => s.x0)) - 0.01 ||
        h.x1 > Math.max(...sections.map((s) => s.x1)) + 0.01)
    )
      continue;
    const label = clean(left?.s || "");
    const fs = Math.min(0.012, Math.max(0.0095, left?.h * 1.15 || 0.0105));
    lines.push({
      x0: Math.max(h.x0, left ? left.x1 + 0.003 : 0),
      x1: h.x1,
      y,
      fs,
      clr: 0.022,
      label,
      section: sectionAt(y),
      inputType: fieldType(label),
      source: "underline",
      confidence: label ? "high" : "review",
    });
  }
  // Only rings on a printed question/option row become controls. This excludes
  // punched holes, the letter O in a heading, and decorative circles.
  const seeded = rings.filter((r) =>
    phrases.some(
      (w) =>
        Math.abs(w.cy - r.cy) < 0.009 &&
        ((w.x0 >= r.x1 - 0.004 && w.x0 - r.x1 < 0.04) ||
          (/\?/.test(w.s) && r.x0 - w.x1 < 0.035 && r.x0 > w.x1)),
    ),
  );
  const boxes = rings.filter(
    (r) =>
      seeded.includes(r) ||
      seeded.some(
        (b) => Math.abs(b.cy - r.cy) < 0.006 && Math.abs(b.cx - r.cx) < 0.09,
      ),
  );
  for (const r of boxes) {
    const next = boxes
      .filter((b) => Math.abs(b.cy - r.cy) < 0.008 && b.cx > r.cx)
      .sort((a, b) => a.cx - b.cx)[0];
    r.label = said(
      words.filter(
        (w) =>
          Math.abs(w.cy - r.cy) < 0.008 &&
          w.x0 > r.cx &&
          w.x1 < Math.min(next?.x0 || 1, r.x1 + 0.055),
      ),
    );
    r.label = r.label.replace(/^[oO0()\s]+(?=[A-Za-z])/, "");
    if (/^(yes|no)$/i.test(r.label)) r.label = r.label.toUpperCase();
    const left = phrases
      .filter(
        (w) =>
          w.x1 < r.x0 + 0.005 &&
          r.x0 - w.x1 < 0.65 &&
          Math.abs(w.cy - r.cy) < 0.009 &&
          /\?/.test(w.s),
      )
      .sort((a, b) => b.x1 - a.x1)[0];
    r.askLabel = left?.s || "";
    r.section = sectionAt(r.cy);
    r.groupId = left
      ? `choice:${left.x0.toFixed(4)}:${left.cy.toFixed(4)}`
      : null;
  }
  // Keep independently detected square controls, but do not duplicate rings.
  boxes.push(
    ...(base.boxes || []).filter(
      (b) =>
        !b.guessed &&
        !boxes.some(
          (r) =>
            Math.hypot(
              (b.cx - r.cx) * rules.width,
              (b.cy - r.cy) * rules.height,
            ) < 20,
        ) &&
        !words.some(
          (w) =>
            Math.abs(w.cy - b.cy) < 0.006 &&
            overlap(w.x0, w.x1, b.x0, b.x1) > (b.x1 - b.x0) * 0.5,
        ),
    ),
  );
  return { ...base, lines, cells, boxes, sections, structured: true };
}

export function readingOrder(spots) {
  const rows = [];
  for (const s of [...spots].sort((a, b) => a.cy - b.cy || a.x - b.x)) {
    const row = rows.at(-1),
      tol = Math.max(0.007, Math.max(row?.h || 0, s.h) * 0.8);
    if (row && s.cy - row.cy <= tol) {
      row.items.push(s);
      row.h = Math.max(row.h, s.h);
    } else rows.push({ cy: s.cy, h: s.h, items: [s] });
  }
  const right = (s) => s.C?.x1 || s.L?.x1 || s.B?.x1 || s.x + 0.01;
  return rows.flatMap((row) =>
    row.items.sort((a, b) => {
      const sameColumn =
        overlap(a.x, right(a), b.x, right(b)) >
        0.7 * Math.min(right(a) - a.x, right(b) - b.x);
      return sameColumn && Math.abs(a.cy - b.cy) > 0.004
        ? a.cy - b.cy
        : a.x - b.x;
    }),
  );
}

// A shared document text size avoids enlarging short answers in tall cells or
// inheriting inconsistent OCR label sizes. Bounds may shrink it; never grow it.
export const ANSWER_FONT_SIZE = 10;

/** One layout algorithm for screen and PDF. Never clips or silently discards
    content: callers must surface overflow and stop export when it cannot fit. */
export function fitFieldText(text, options, measure) {
  const {
    width,
    height,
    fontSize = ANSWER_FONT_SIZE,
    minFontSize = 6.75,
    glyphHeight = 1.25,
    lineHeight = 1.25,
    multiline = true,
  } = options;
  for (
    let size = fontSize;
    size >= Math.min(minFontSize, fontSize) - 0.01;
    size -= 0.25
  ) {
    const lines = [];
    for (const paragraph of String(text || "").split("\n")) {
      if (!multiline) {
        lines.push(paragraph);
        continue;
      }
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        const candidate = line ? line + " " + word : word;
        if (line && measure(candidate, size) > width) {
          lines.push(line);
          line = word;
        } else line = candidate;
      }
      lines.push(line);
    }
    const used = (glyphHeight + (lines.length - 1) * lineHeight) * size;
    if (
      used <= height + 0.01 &&
      lines.every((line) => measure(line, size) <= width + 0.01)
    )
      return { lines, size, height: used, overflow: false };
  }
  return {
    lines: String(text || "").split("\n"),
    size: Math.min(minFontSize, fontSize),
    height: height,
    overflow: true,
  };
}
