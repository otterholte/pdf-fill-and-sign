import {
  numberFormat,
  placeholderFields,
  connectNumberLines,
} from "./field-formats.mjs";
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
  function run(vertical, guides = false) {
    const length = vertical ? H : W,
      count = vertical ? W : H;
    const minimum = Math.max(
      18,
      Math.round(length * (vertical ? (guides ? 0.006 : 0.011) : 0.025)),
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
          if (
            last - start + 1 >= minimum &&
            hits / (last - start + 1) >
              (guides
                ? 0.45
                : vertical && last - start < H * 0.03
                  ? 0.97
                  : 0.88)
          )
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
            0.78 * Math.max(s.end - s.start, b.end - b.start),
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
  const dashed = [];
  for (let y = 0; y < H; y++) {
    const runs = [];
    for (let x = 0; x < W;) {
      if (!ink[y * W + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < W && ink[y * W + x]) x++;
      runs.push({ start, end: x });
    }
    for (let i = 0; i < runs.length;) {
      let j = i + 1;
      while (
        j < runs.length &&
        runs[j].start - runs[j - 1].end <= Math.max(5, W * 0.004)
      )
        j++;
      const a = runs.slice(i, j);
      i = j;
      if (a.length < 12 || a.at(-1).end - a[0].start < W * 0.08) continue;
      const lengths = a.map((r) => r.end - r.start),
        gaps = a.slice(1).map((r, k) => r.start - a[k].end);
      const cv = (a) => {
        const mean = a.reduce((s, x) => s + x, 0) / a.length;
        return (
          Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length) /
          mean
        );
      };
      if (cv(lengths) > 0.45 || cv(gaps) > 0.4) continue;
      const previous = dashed.at(-1);
      if (
        previous &&
        y / H - previous.y1 < 3 / H &&
        Math.abs(previous.x0 - a[0].start / W) < 0.003
      ) {
        previous.y1 = y / H;
        continue;
      }
      dashed.push({
        x0: a[0].start / W,
        x1: a.at(-1).end / W,
        y0: y / H,
        y1: y / H,
        dashed: true,
      });
    }
  }
  return {
    horizontal,
    vertical: run(true),
    guides: run(true, true),
    dashed,
    width: W,
    height: H,
  };
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
    const horizontalEdge = (y) => {
      let n = 0,
        total = 0;
      for (let x = l + Math.ceil(w * 0.1); x <= r - w * 0.1; x++) {
        total++;
        if (dark(y * W + x) || dark((y === t ? y + 1 : y - 1) * W + x)) n++;
      }
      return n / total;
    };
    const verticalEdge = (x) => {
      let n = 0,
        total = 0;
      for (let y = t + Math.ceil(h * 0.1); y <= b - h * 0.1; y++) {
        total++;
        if (dark(y * W + x) || dark(y * W + (x === l ? x + 1 : x - 1))) n++;
      }
      return n / total;
    };
    const square =
      Math.min(
        horizontalEdge(t),
        horizontalEdge(b),
        verticalEdge(l),
        verticalEdge(r),
      ) > 0.9;
    out.push({
      x0: l / W,
      x1: r / W,
      y0: t / H,
      y1: b / H,
      cx: (l + r) / 2 / W,
      cy: (t + b) / 2 / H,
      w: w / W,
      h: h / H,
      shape: square ? "square" : "circle",
    });
  }
  return out;
}

/** Validate fallback controls against all four outline sides, even when an
    outline touches a table rule and is no longer an isolated component. */
export function verifyBoxes(image, boxes) {
  const { width: W, height: H, data } = image,
    pad = Math.max(1, Math.ceil(W / 1000));
  const dark = (x, y) =>
    x >= 0 && x < W && y >= 0 && y < H && data[(y * W + x) * 4] < 215;
  return boxes.filter((b) => {
    if (b.guessed) return false;
    const l = Math.round(b.x0 * W),
      r = Math.round(b.x1 * W),
      t = Math.round(b.y0 * H),
      bot = Math.round(b.y1 * H);
    const edge = (vertical, fixed, start, end) => {
      let hits = 0,
        total = 0;
      for (
        let v = Math.ceil(start + (end - start) * 0.15);
        v <= end - (end - start) * 0.15;
        v++
      ) {
        total++;
        for (let d = -pad; d <= pad; d++)
          if (dark(vertical ? fixed + d : v, vertical ? v : fixed + d)) {
            hits++;
            break;
          }
      }
      return hits / Math.max(total, 1);
    };
    return (
      Math.min(
        edge(false, t, l, r),
        edge(false, bot, l, r),
        edge(true, l, t, bot),
        edge(true, r, t, bot),
      ) > 0.8
    );
  });
}

const clean = (s) =>
  (s || "")
    .replace(/[|_]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:.,-]+|[\s:.,-]+$/g, "")
    .trim();
const meaningful = (w) => /[a-z]{2}/i.test(w.s) || /^\d{1,3}[a-z]?$/i.test(w.s);
const rowCode = (w) => /^\d{1,3}[a-z]?$/i.test(w.s);
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

/** Reconstruct adjacent cells from intersections, including open table edges.
    An implied edge needs repeated horizontal endpoints; short dotted character
    guides never qualify as full-height dividers. No page identity is used. */
export function ruleCells(rules) {
  const hs = rules.horizontal
      .filter((h) => h.y1 - h.y0 < 0.004 && h.x1 - h.x0 > 0.04)
      .sort((a, b) => a.y0 - b.y0),
    vs = rules.vertical,
    result = [];
  for (let i = 0; i < hs.length; i++) {
    const top = hs[i];
    for (const bottom of hs.slice(i + 1)) {
      const height = bottom.y0 - top.y1;
      if (height > 0.13) break;
      if (height < 0.01) continue;
      const x0 = Math.max(top.x0, bottom.x0),
        x1 = Math.min(top.x1, bottom.x1);
      if (x1 - x0 < 0.04) continue;
      const cuts = vs
        .filter(
          (v) =>
            v.x0 > x0 - 0.003 &&
            v.x0 < x1 + 0.003 &&
            v.y0 <= top.y1 + 0.001 &&
            v.y1 >= bottom.y0 - 0.001,
        )
        .map((v) => (v.x0 + v.x1) / 2);
      const edge = (x) =>
        cuts.some((v) => Math.abs(v - x) < 0.004) ||
        hs.filter(
          (h) => Math.abs(h.x0 - x) < 0.003 || Math.abs(h.x1 - x) < 0.003,
        ).length >= 3;
      if (edge(x0)) cuts.push(x0);
      if (edge(x1)) cuts.push(x1);
      const xs = cuts
        .sort((a, b) => a - b)
        .filter((x, j, a) => !j || x - a[j - 1] > 0.005);
      for (let k = 0; k < xs.length - 1; k++) {
        const left = xs[k],
          right = xs[k + 1];
        if (right - left < 0.023) continue;
        if (
          hs.some(
            (h) =>
              h.y0 > top.y1 + 0.003 &&
              h.y1 < bottom.y0 - 0.003 &&
              h.x0 <= left + 0.003 &&
              h.x1 >= right - 0.003,
          )
        )
          continue;
        result.push({
          x0: left,
          x1: right,
          y0: top.y1,
          y1: bottom.y0,
          geometric: true,
        });
      }
    }
  }
  // Open-top amount boxes have short uprights ending on their underline.
  for (const h of hs) {
    const uprights = vs.filter(
      (v) =>
        v.x0 >= h.x0 - 0.002 &&
        v.x0 <= h.x1 + 0.002 &&
        v.y0 < h.y0 - 0.009 &&
        v.y1 >= h.y0 - 0.001,
    );
    for (const v of uprights) {
      if (v.y0 < h.y0 - 0.028) continue;
      const right = uprights
        .filter((b) => b.x0 > v.x1 + 0.023 && b.y0 <= v.y0 + 0.001)
        .sort((a, b) => a.x0 - b.x0)[0];
      if (!right) continue;
      const rect = {
        x0: (v.x0 + v.x1) / 2,
        x1: (right.x0 + right.x1) / 2,
        y0: v.y0,
        y1: h.y0,
        geometric: true,
      };
      rect.openTop = true;
      result.push(rect);
    }
  }
  return result.filter(
    (c, i, all) =>
      !all
        .slice(0, i)
        .some(
          (b) =>
            Math.abs(c.x0 - b.x0) < 0.003 &&
            Math.abs(c.x1 - b.x1) < 0.003 &&
            Math.abs(c.y0 - b.y0) < 0.003 &&
            Math.abs(c.y1 - b.y1) < 0.003,
        ),
  );
}

/** Refine existing scan evidence using printed structure. No answer text is
    consulted. The old pixel scanner remains the fallback for unruled pages. */
export function analyzeForm(rawWords, rules, base, rings = []) {
  const words = rawWords.filter(meaningful),
    phrases = phraseWords(words, rules);
  const hs = rules.horizontal,
    vs = rules.vertical;
  const sections = [];
  const textHeights = words.map((w) => w.h).sort((a, b) => a - b);
  const normalHeight =
    textHeights[Math.floor(textHeights.length * 0.75)] || 0.01;
  for (const h of hs.filter((h) => h.x1 - h.x0 > 0.55)) {
    const title = phrases.find(
      (w) =>
        w.x0 > h.x0 &&
        w.x0 < h.x0 + 0.08 &&
        w.cy > h.y1 + 0.003 &&
        w.cy < h.y1 + 0.02 &&
        w.x1 < h.x0 + 0.38,
    );
    const enclosed = vs.find(
      (v) =>
        Math.abs(v.x0 - h.x0) < 0.005 &&
        Math.abs(v.y0 - h.y0) < 0.006 &&
        v.y1 > h.y0 + 0.035,
    );
    if (
      title &&
      ((enclosed &&
        hs.filter(
          (b) =>
            b.y0 > h.y1 + 0.02 &&
            b.y0 < Math.min(h.y0 + 0.16, enclosed.y1 - 0.001) &&
            b.x0 >= h.x0 - 0.004 &&
            b.x1 <= h.x1 + 0.004,
        ).length >= 2) ||
        (title.h > normalHeight * 1.35 &&
          title.s.split(/\s+/).length <= 4 &&
          Math.abs(
            h.x0 -
              Math.min(
                ...hs.filter((b) => b.x1 - b.x0 > 0.55).map((b) => b.x0),
              ),
          ) < 0.005)) &&
      !sections.some((s) => Math.abs(s.y - title.cy) < 0.02)
    )
      sections.push({ label: clean(title.s), y: title.cy, x0: h.x0, x1: h.x1 });
  }
  sections.sort((a, b) => a.y - b.y);
  const sectionAt = (y) => sections.findLast((s) => s.y < y)?.label || "";
  let measured = ruleCells(rules);
  // Character guides subdivide an identifier, not the logical answer. Reuse
  // adjacent table-column boundaries only when the row explicitly asks for one.
  for (const labelCell of [...measured]) {
    if (
      !/\b(ssn|social security|account number|identification|telephone)\b/i.test(
        said(contents(words, labelCell)),
      )
    )
      continue;
    const above = measured.filter(
      (b) =>
        Math.abs(b.y1 - labelCell.y0) < 0.003 &&
        b.x0 >= labelCell.x1 - 0.002 &&
        b.x1 - b.x0 > 0.06,
    );
    for (const col of above) {
      const parts = measured.filter(
        (c) =>
          Math.abs(c.y0 - labelCell.y0) < 0.002 &&
          Math.abs(c.y1 - labelCell.y1) < 0.002 &&
          c.x0 >= col.x0 - 0.002 &&
          c.x1 <= col.x1 + 0.002,
      );
      if (parts.length < 2 || parts.some((c) => contents(words, c).length))
        continue;
      measured = measured.filter((c) => !parts.includes(c));
      measured.push({
        x0: col.x0,
        x1: col.x1,
        y0: labelCell.y0,
        y1: labelCell.y1,
        geometric: true,
      });
    }
  }
  const legacyCells = (base.cellsAll || base.cells || []).map((c) => ({
    ...c,
    ...(c.box || {}),
  }));
  const cellsAll = legacyCells;
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
  // Printed captions occupy the top of a box; the answer belongs BELOW them.
  // Multiple lines of instructions filling a panel are not a text field.
  for (const c of measured) {
    const own = contents(words, c),
      height = c.y1 - c.y0;
    if (!own.length || height < 0.022 || height > 0.12) continue;
    const bottom = Math.max(...own.map((w) => w.cy + w.h / 2));
    if (bottom > c.y0 + height * 0.58 || c.y1 - bottom < 0.01) continue;
    const label = said(own);
    if (
      !label ||
      sections.some((s) => s.label === label) ||
      rings.some(
        (r) =>
          r.cx > c.x0 && r.cx < c.x1 && r.cy > bottom + 0.002 && r.cy < c.y1,
      )
    )
      continue;
    // A table's printed row labels are not top-caption answer boxes.
    if (
      c.x1 - c.x0 < 0.09 &&
      measured.some(
        (b) =>
          Math.abs(b.x0 - c.x1) < 0.003 &&
          Math.abs(b.y0 - c.y0) < 0.003 &&
          Math.abs(b.y1 - c.y1) < 0.003 &&
          rings.some(
            (r) => r.cx > b.x0 && r.cx < b.x1 && r.cy > b.y0 && r.cy < b.y1,
          ),
      )
    )
      continue;
    addCell(
      {
        x0: c.x0 + 0.002,
        x1: c.x1 - 0.002,
        y0: bottom + 0.002,
        y1: c.y1 - 0.001,
      },
      label,
      "caption",
      {
        align: /\b(zip|postal|state|ssn|social security)\b/i.test(label)
          ? "center"
          : "left",
        multiline: height > 0.055,
      },
    );
  }
  // Compact grids: use the nearest column heading and row label, keeping
  // each repeated table separate from unrelated columns elsewhere on the page.
  for (const c of measured) {
    if (contents(words, c).length || c.x1 - c.x0 < 0.035 || c.x1 - c.x0 > 0.45)
      continue;
    const codeCell = measured.find(
      (b) =>
        Math.abs(b.x1 - c.x0) < 0.004 &&
        Math.abs(b.y0 - c.y0) < 0.003 &&
        Math.abs(b.y1 - c.y1) < 0.003 &&
        b.x1 - b.x0 < 0.04,
    );
    const code = rawWords
      .filter(
        (w) =>
          (rowCode(w) || (codeCell && /^[a-z0-9]{1,3}$/i.test(w.s))) &&
          w.x1 <= c.x0 + 0.001 &&
          c.x0 - w.x1 < 0.035 &&
          w.cy > c.y0 &&
          w.cy < c.y1,
      )
      .sort((a, b) => b.cy - a.cy)[0];
    const targetY = code?.cy || c.y1 - 0.007;
    const left = words.filter(
      (w) =>
        w.x1 < (codeCell?.x0 || c.x0) - 0.001 &&
        w.x0 > c.x0 - 0.5 &&
        Math.abs(w.cy - targetY) < 0.006,
    );
    if (
      (code ||
        (codeCell &&
          measured.filter(
            (b) =>
              Math.abs(b.x0 - codeCell.x0) < 0.003 &&
              Math.abs(b.x1 - codeCell.x1) < 0.003,
          ).length >= 3)) &&
      left.length
    ) {
      const label = said(left).replace(/(?:[.·]\s*)+$/, "");
      addCell(
        {
          x0: c.x0 + 0.002,
          x1: c.x1 - 0.002,
          y0: Math.max(c.y0 + 0.001, (code?.cy || c.y1 - 0.007) - 0.007),
          y1: Math.min(c.y1 - 0.001, (code?.cy || c.y1 - 0.007) + 0.008),
        },
        `${code?.s ? code.s + " — " : ""}${label}`,
        "amount",
        { align: "right", multiline: false },
      );
      continue;
    }
    if (c.y1 - c.y0 > 0.024) continue;
    const col = measured.filter(
      (b) =>
        Math.abs(b.x0 - c.x0) < 0.004 &&
        Math.abs(b.x1 - c.x1) < 0.004 &&
        b.y0 <= c.y0 &&
        c.y0 - b.y1 < 0.09,
    );
    const headerCell = col
      .filter((b) => contents(words, b).length && b.y1 <= c.y0 + 0.002)
      .sort((a, b) => b.y1 - a.y1)[0];
    if (!headerCell) continue;
    const header = said(contents(words, headerCell));
    const rowCell = measured
      .filter(
        (b) =>
          b.x1 <= c.x0 + 0.002 &&
          c.x0 - b.x1 < 0.5 &&
          Math.abs(b.y0 - c.y0) < 0.003 &&
          Math.abs(b.y1 - c.y1) < 0.003 &&
          contents(words, b).length,
      )
      .sort((a, b) => b.x1 - a.x1)[0];
    if (!rowCell) continue;
    const row = said(contents(words, rowCell));
    addCell(
      {
        x0: c.x0 + 0.002,
        x1: c.x1 - 0.002,
        y0: c.y0 + 0.001,
        y1: c.y1 - 0.001,
      },
      `${row} — ${header}`,
      "grid",
      { columnLabel: header, rowLabel: row, align: "left", multiline: false },
    );
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
  for (const c of [
    ...cellsAll,
    ...measured.filter(
      (c) =>
        !vs.some(
          (v) =>
            v.x0 > c.x0 + 0.005 &&
            v.x0 < c.x1 - 0.005 &&
            v.y0 < middle(c) &&
            v.y1 > middle(c),
        ) &&
        !cellsAll.some(
          (b) =>
            overlap(c.x0, c.x1, b.x0, b.x1) > 0.02 &&
            overlap(c.y0, c.y1, b.y0, b.y1) > 0.5 * (c.y1 - c.y0),
        ),
    ),
  ]) {
    const width = c.x1 - c.x0,
      height = c.y1 - c.y0;
    if (height > 0.05) continue;
    const own = contents(words, c);
    if (!own.length) continue;
    if (
      Math.max(...own.map((w) => w.cy)) - Math.min(...own.map((w) => w.cy)) >
        0.01 &&
      !own.some((w) =>
        sections.some(
          (s) => s.label.includes(w.s) && Math.abs(s.y - w.cy) < 0.005,
        ),
      )
    )
      continue;
    if (
      [...rings, ...(base.boxes || [])].some(
        (b) => b.cy > c.y0 && b.cy < c.y1 && b.cx > c.x0 && b.cx < c.x1,
      )
    )
      continue;
    const row = phraseWords(own, rules).filter(
      (w) => w.cy > c.y1 - 0.025 && w.cy < c.y1 - 0.002,
    );
    if (width < 0.5 && !/^(from|to|ta)$/i.test(said(own))) continue;
    for (let i = 0; i < row.length; i++) {
      const label = row[i];
      if (sectionAt(label.cy + 0.001) === clean(label.s)) continue;
      const printedRight = rawWords
        .filter(
          (w) =>
            w.x0 > label.x1 + 0.012 &&
            Math.abs(w.cy - label.cy) < 0.006 &&
            w.x1 < c.x1 + 0.002,
        )
        .sort((a, b) => a.x0 - b.x0)[0]?.x0;
      const right = Math.min(row[i + 1]?.x0 || c.x1, printedRight || c.x1);
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
  for (const h of [...hs, ...(rules.dashed || [])]) {
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
      measured.some(
        (c) =>
          overlap(c.x0, c.x1, h.x0, h.x1) > 0.02 &&
          (Math.abs(c.y0 - y) < 0.003 || Math.abs(c.y1 - y) < 0.003),
      )
    )
      continue;
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
          Math.abs(w.cy - y) < w.h * 0.65,
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
    if (!left && (width > 0.5 || (!h.dashed && width < 0.08))) continue;
    if (y < 0.03 || y > 0.97 || h.y1 - h.y0 > 0.004) continue;
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
  const seeded = rings.filter(
    (r) =>
      !(
        r.shape === "circle" &&
        rawWords.some(
          (w) =>
            w.x0 < r.cx &&
            w.x1 > r.cx &&
            Math.abs(w.cy - r.cy) < r.h * 0.6 &&
            meaningful(w),
        )
      ) &&
      phrases.some(
        (w) =>
          Math.abs(w.cy - r.cy) < 0.009 &&
          ((w.x0 >= r.x1 - 0.004 && w.x0 - r.x1 < 0.04) ||
            (/\?/.test(w.s) && r.x0 - w.x1 < 0.035 && r.x0 > w.x1)),
      ),
  );
  const boxes = rings.filter(
    (r) =>
      !rawWords.some(
        (w) =>
          w.x0 < r.x0 - 0.003 &&
          w.x1 > r.x1 + 0.003 &&
          Math.abs(w.cy - r.cy) < r.h * 0.6,
      ) &&
      (r.shape === "square" ||
        seeded.includes(r) ||
        seeded.some(
          (b) => Math.abs(b.cy - r.cy) < 0.006 && Math.abs(b.cx - r.cx) < 0.09,
        )),
  );
  for (const r of boxes) {
    const next = boxes
      .filter((b) => Math.abs(b.cy - r.cy) < 0.008 && b.cx > r.cx)
      .sort((a, b) => a.cx - b.cx)[0];
    const enclosure = measured
      .filter((c) => r.cx > c.x0 && r.cx < c.x1 && r.cy > c.y0 && r.cy < c.y1)
      .sort(
        (a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0),
      )[0];
    const optionRight = Math.min(next?.x0 || 1, enclosure?.x1 || 1, r.x1 + 0.6);
    const optionRow = phraseWords(
      words.filter(
        (w) =>
          Math.abs(w.cy - r.cy) < 0.007 &&
          w.x0 > r.x1 - 0.001 &&
          w.x1 < optionRight,
      ),
      rules,
    );
    r.label = said(
      words.filter(
        (w) =>
          Math.abs(w.cy - r.cy) < 0.008 &&
          w.x0 > r.cx &&
          w.x1 <
            Math.min(optionRight, optionRow[0]?.x1 + 0.001 || r.x1 + 0.055),
      ),
    );
    r.label = r.label.replace(/^[()\s]+/, "");
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
        !rawWords.some(
          (w) =>
            (w.confidence || 0) > 90 &&
            /^[a-z]{3,}$/i.test(w.s) &&
            Math.abs(w.cy - b.cy) < 0.005 &&
            w.x0 < b.x0 + 0.002 &&
            w.x1 > b.x1 + 0.006,
        ) &&
        !boxes.some(
          (r) =>
            Math.hypot(
              (b.cx - r.cx) * rules.width,
              (b.cy - r.cy) * rules.height,
            ) < 20,
        ),
    ),
  );
  // An explicit "check only one" instruction makes nearby option rows
  // exclusive. Boxes elsewhere (such as independent table credits) stay separate.
  const exclusive = phrases.find((w) => /check only/i.test(w.s));
  if (exclusive) {
    const range = hs
      .filter((h) => h.y0 > exclusive.cy)
      .sort((a, b) => a.y0 - b.y0)[0];
    const options = boxes.filter(
      (b) =>
        b.cx > exclusive.x1 &&
        b.cy > exclusive.cy - 0.025 &&
        b.cy < exclusive.cy + 0.025 &&
        b.cy < (range?.y0 || 1),
    );
    if (options.length >= 2 && options.length <= 8)
      for (const b of options) {
        b.groupId = `exclusive:${exclusive.cy.toFixed(4)}`;
        b.askLabel = sectionAt(b.cy) || "Choose one";
      }
  }
  for (const b of boxes) {
    const column = cells
      .filter(
        (c) =>
          c.columnLabel &&
          c.y1 < b.y0 &&
          b.y0 - c.y1 < 0.13 &&
          b.cx > c.x0 &&
          b.cx < c.x1,
      )
      .sort((a, b) => b.y1 - a.y1)[0];
    if (column) {
      b.columnLabel = column.columnLabel;
      b.label = `${column.columnLabel} — ${b.label || "Check box"}`;
    }
  }
  const connected = connectNumberLines(lines, rawWords);
  cells.push(...connected.fields);
  for (let i = lines.length - 1; i >= 0; i--)
    if (connected.used.has(lines[i])) lines.splice(i, 1);
  for (const f of [...cells, ...lines]) {
    const format = numberFormat(f, rules);
    if (format) {
      f.format = format;
      f.multiline = false;
    }
  }
  for (const f of placeholderFields(rawWords)) {
    if (
      !cells.some(
        (c) =>
          overlap(c.x0, c.x1, f.x0, f.x1) > 0.8 * f.w &&
          overlap(c.y0, c.y1, f.y0, f.y1) > 0.8 * f.h,
      )
    )
      cells.push(f);
  }
  return {
    ...base,
    lines,
    cells,
    boxes,
    sections,
    structuralCells: measured,
    structured: true,
  };
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
