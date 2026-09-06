/* Number formats are inferred from labels and measured marks, never a form map. */
const kindOf = (label) =>
  /social security|\bssn\b/i.test(label)
    ? "ssn"
    : /phone|telephone|mobile|fax/i.test(label)
      ? "phone"
      : /\b(date|birth|dob)\b/i.test(label)
        ? "date"
        : /\b(ein|employer identification)\b/i.test(label)
          ? "ein"
          : /\bzip\b/i.test(label)
            ? "postal"
            : null;
const capacities = {
  ssn: [3, 2, 4],
  phone: [3, 3, 4],
  ein: [2, 7],
  postal: [5, 4],
  date: [2, 2, 4],
};
export function numberFormat(field, rules) {
  const kind = kindOf(field.label || "");
  if (!kind) return null;
  const r =
    field.y !== undefined
      ? { ...field, y0: field.y - 0.018, y1: field.y }
      : field;
  const cuts = (rules.guides || rules.vertical || [])
    .filter(
      (v) =>
        v.x0 > r.x0 + 0.006 &&
        v.x0 < r.x1 - 0.006 &&
        Math.min(v.y1, r.y1) - Math.max(v.y0, r.y0) > (r.y1 - r.y0) * 0.4,
    )
    .map((v) => (v.x0 + v.x1) / 2)
    .sort((a, b) => a - b)
    .filter((x, i, a) => !i || x - a[i - 1] > 0.003);
  let counts = capacities[kind];
  if (kind === "phone" && cuts.length === 3) counts = [1, 3, 3, 4];
  if (kind === "date") return null; // Date order must come from explicit printed hints.
  if (cuts.length === counts.reduce((a, b) => a + b, 0) - 1)
    counts = Array(cuts.length + 1).fill(1);
  if (cuts.length !== counts.length - 1) return null;
  const xs = [r.x0, ...cuts, r.x1],
    widths = counts.map((_, i) => xs[i + 1] - xs[i]);
  const unit =
    widths.reduce((a, b) => a + b, 0) / counts.reduce((a, b) => a + b, 0);
  if (
    widths.some(
      (w, i) => w / counts[i] < unit * 0.45 || w / counts[i] > unit * 1.8,
    )
  )
    return null;
  return {
    kind,
    hint:
      kind === "ssn"
        ? "123-45-6789"
        : kind === "phone"
          ? "123-456-7890"
          : counts.map((n) => "0".repeat(n)).join("-"),
    parts: counts.map((capacity, i) => ({
      x0: xs[i] + 0.0015,
      x1: xs[i + 1] - 0.0015,
      y0: r.y0,
      y1: r.y1,
      capacity,
    })),
    source: "printed guides",
  };
}
export function placeholderFields(words) {
  const candidates = words.filter((w) => /^(MM|DD|YYYY|YY|HH|SS)$/i.test(w.s));
  const tokens = candidates.filter(
    (w) =>
      !candidates.some(
        (v) =>
          v !== w &&
          v.s[0].toUpperCase() === w.s[0].toUpperCase() &&
          Math.abs(v.cy - w.cy) < 0.004 &&
          v.x0 <= w.x0 &&
          v.x1 >= w.x1 &&
          v.x1 - v.x0 > w.x1 - w.x0 + 0.003,
      ),
  );
  const result = [];
  for (const first of tokens) {
    if (!/^(MM|DD|YY|YYYY)$/i.test(first.s)) continue;
    const row = tokens
      .filter(
        (w) =>
          Math.abs(w.cy - first.cy) < Math.max(w.h, first.h) * 0.5 &&
          w.x0 >= first.x0,
      )
      .sort((a, b) => a.x0 - b.x0);
    const a = row.slice(0, 3),
      names = a.map((w) => w.s.toUpperCase());
    if (
      a.length !== 3 ||
      new Set(names.map((n) => n[0])).size !== 3 ||
      !names.includes("MM") ||
      !names.includes("DD") ||
      !names.some((n) => /^YY/.test(n))
    )
      continue;
    if (
      a.slice(1).some((w, i) => w.x0 - a[i].x1 > Math.max(first.h * 4.5, 0.025))
    )
      continue;
    if (
      result.some(
        (f) =>
          Math.abs(f.x0 - first.x0) < 0.003 && Math.abs(f.cy - first.cy) < 0.01,
      )
    )
      continue;
    const y0 = Math.min(...a.map((w) => w.cy)) - 0.007,
      y1 = Math.max(...a.map((w) => w.cy)) + 0.007;
    const left = words
      .filter(
        (w) =>
          w.x1 < first.x0 &&
          first.x0 - w.x1 < 0.3 &&
          Math.abs(w.cy - first.cy) < 0.01 &&
          /[a-z]{3}/i.test(w.s),
      )
      .sort((a, b) => b.x1 - a.x1)[0];
    const parts = a.map((w) => ({
      x0: w.x0 - 0.0015,
      x1: w.x1 + 0.0015,
      y0,
      y1,
      capacity: w.s.length,
      token: w.s.toUpperCase(),
      erase: true,
      eraseBox: {
        x0: w.x0 - 0.001,
        x1: w.x1 + 0.001,
        y0: w.cy - w.h / 2 - 0.001,
        y1: w.cy + w.h / 2 + 0.001,
        bg: w.bg || [244, 244, 244],
      },
      bg: w.bg || [244, 244, 244],
    }));
    result.push({
      x0: parts[0].x0,
      x1: parts.at(-1).x1,
      y0,
      y1,
      w: parts.at(-1).x1 - parts[0].x0,
      h: y1 - y0,
      cx: (parts[0].x0 + parts.at(-1).x1) / 2,
      cy: (y0 + y1) / 2,
      label: left ? (/date/i.test(left.s) ? left.s : left.s + " date") : "Date",
      inputType: "date",
      align: "center",
      multiline: false,
      source: "format placeholder",
      format: {
        kind: "date",
        hint: names.join("/"),
        parts,
        source: "printed placeholders",
      },
    });
  }
  return result;
}
export function splitNumber(value, format) {
  const s = String(value || "").trim(),
    parts = format.parts;
  if (!s)
    return { values: parts.map(() => ""), invalid: false, incomplete: false };
  if (/[^\d\s()+./-]/.test(s))
    return {
      values: [],
      invalid: true,
      incomplete: false,
      message: `Use ${format.hint}.`,
    };
  const groups = s.split(/[\s()+./-]+/).filter(Boolean);
  let values;
  if (groups.length === parts.length)
    values = groups.map((g, i) =>
      format.kind === "date" && /^(MM|DD)$/.test(parts[i].token)
        ? g.padStart(parts[i].capacity, "0")
        : g,
    );
  else {
    let digits = s.replace(/\D/g, "");
    if (
      format.kind === "phone" &&
      digits.length === 11 &&
      parts.reduce((n, p) => n + p.capacity, 0) === 10 &&
      digits[0] === "1"
    )
      digits = digits.slice(1);
    let offset = 0;
    values = parts.map((p) => {
      const v = digits.slice(offset, offset + p.capacity);
      offset += p.capacity;
      return v;
    });
    if (digits.length > offset)
      return {
        values: [],
        invalid: true,
        incomplete: false,
        message: "Too many digits for the printed spaces.",
      };
  }
  let invalid = values.some((v, i) => v.length > parts[i].capacity),
    incomplete = values.some((v, i) => v.length !== parts[i].capacity);
  if (!invalid && !incomplete && format.kind === "date") {
    const get = (t) => Number(values[parts.findIndex((p) => p.token === t)]),
      month = get("MM"),
      day = get("DD"),
      year = parts.some((p) => p.token === "YYYY")
        ? get("YYYY")
        : 2000 + get("YY");
    if (
      year < 1 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > new Date(year, month, 0).getDate()
    )
      invalid = true;
  }
  return {
    values,
    invalid,
    incomplete,
    message: invalid
      ? "Check the value and printed format."
      : incomplete
        ? `Expected ${format.hint}.`
        : "",
  };
}
export function formatLayout(
  value,
  format,
  { W, H, fontSize, minFontSize = 6.75, glyphHeight = 0.925, measure },
) {
  const parsed = splitNumber(value, format),
    values = parsed.values;
  let size = fontSize;
  const fits = (s) =>
    format.parts.every(
      (p, i) =>
        measure(values[i] || "", s) <= (p.x1 - p.x0) * W - 1 &&
        (p.y1 - p.y0) * H >= glyphHeight * s + 0.6,
    );
  while (size > minFontSize && !fits(size))
    size = Math.max(minFontSize, size - 0.25);
  const invalid = parsed.invalid,
    overflow = invalid || parsed.incomplete || !fits(size);
  const runs = format.parts.map((p, i) => ({
    text: values[i] || "",
    x: (p.x0 + p.x1) / 2 - measure(values[i] || "", size) / W / 2,
    inkTop: (p.y0 + p.y1) / 2 - (glyphHeight * size) / H / 2,
    part: p,
  }));
  return {
    size,
    overflow,
    invalid,
    incomplete: parsed.incomplete,
    message: parsed.message,
    segmented: true,
    runs,
    lines: [String(value)],
    height: glyphHeight * size,
    patches: format.parts
      .filter((p) => p.erase && (value || "").trim())
      .map((p) => p.eraseBox || p),
  };
}
export function connectNumberLines(lines, words = []) {
  const used = new Set(),
    fields = [];
  for (const line of lines) {
    const kind = kindOf(line.label || "");
    if (!kind || kind === "date" || used.has(line)) continue;
    const counts = capacities[kind],
      row = lines
        .filter(
          (l) => l.x0 >= line.x0 - 0.001 && Math.abs(l.y - line.y) < 0.004,
        )
        .sort((a, b) => a.x0 - b.x0)
        .slice(0, counts.length);
    if (
      row.length !== counts.length ||
      row
        .slice(1)
        .some(
          (l, i) =>
            l.x0 - row[i].x1 > 0.035 || (l.label && /[a-z]{3}/i.test(l.label)),
        )
    )
      continue;
    const widths = row.map((l) => l.x1 - l.x0),
      unit =
        widths.reduce((a, b) => a + b, 0) / counts.reduce((a, b) => a + b, 0);
    if (
      widths.some(
        (w, i) => w / counts[i] < unit * 0.55 || w / counts[i] > unit * 1.5,
      )
    )
      continue;
    const parts = row.map((l, i) => ({
      x0: l.x0 + 0.0015,
      x1: l.x1 - 0.0015,
      y0: l.y - 0.016,
      y1: l.y - 0.001,
      capacity: counts[i],
    }));
    const x0 = parts[0].x0,
      x1 = parts.at(-1).x1,
      y0 = Math.min(...parts.map((p) => p.y0)),
      y1 = Math.max(...parts.map((p) => p.y1));
    fields.push({
      x0,
      x1,
      y0,
      y1,
      w: x1 - x0,
      h: y1 - y0,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      label: line.label,
      inputType: kind === "phone" ? "tel" : "text",
      multiline: false,
      align: "center",
      source: "segmented underline",
      format: {
        kind,
        hint: counts.map((n) => "0".repeat(n)).join("-"),
        parts,
        source: "separate underlines",
      },
    });
    row.forEach((l) => used.add(l));
  }
  return { fields, used };
}

// OCR can merge repeated placeholder letters. Measure the five ink groups
// (token, separator, token, separator, token) and count year stems directly.
export function dateHintGeometry(image, rect, text) {
  const names = text
    ? text.toUpperCase().match(/M+|D+|Y+/g) || []
    : ["?", "?", "?"];
  if (
    text &&
    (names.length !== 3 || new Set(names.map((s) => s[0])).size !== 3)
  )
    return [];
  const { width: W, height: H, data } = image,
    { left, right, top, bottom } = rect;
  const rw = right - left,
    rh = bottom - top,
    mask = new Uint8Array(rw * rh),
    seen = new Uint8Array(rw * rh),
    queue = new Int32Array(rw * rh);
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++)
      mask[y * rw + x] = data[((y + top) * W + x + left) * 4] < 128 ? 1 : 0;
  // JPEG/renderer fringes can bridge the gap between a slash and its token.
  // Remove only isolated specks, retaining connected glyphs and separators.
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || seen[seed]) continue;
    let head = 0,
      tail = 1,
      t = rh,
      b = 0;
    queue[0] = seed;
    seen[seed] = 1;
    while (head < tail) {
      const i = queue[head++],
        x = i % rw,
        y = Math.floor(i / rw);
      t = Math.min(t, y);
      b = Math.max(b, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            yy = y + dy,
            n = yy * rw + xx;
          if (xx >= 0 && xx < rw && yy >= 0 && yy < rh && mask[n] && !seen[n]) {
            seen[n] = 1;
            queue[tail++] = n;
          }
        }
    }
    if (tail < Math.max(4, rh * 0.35) || b - t + 1 < rh * 0.15)
      for (let i = 0; i < tail; i++) mask[queue[i]] = 0;
  }
  const ink = (x, y) => mask[(y - top) * rw + x - left];
  const cols = [];
  for (let x = left; x < right; x++) {
    let n = 0;
    for (let y = top; y < bottom; y++) if (ink(x, y)) n++;
    if (n >= 2) cols.push(x);
  }
  if (!cols.length) return [];
  const groups = [];
  let start = cols[0],
    last = start;
  for (const x of cols.slice(1)) {
    if (x - last > Math.max(3, (bottom - top) * 0.3)) {
      groups.push([start, last + 1]);
      start = x;
    }
    last = x;
  }
  groups.push([start, last + 1]);
  if (groups.length !== 5) return [];
  const result = [];
  for (let i = 0; i < 3; i++) {
    const [l, r] = groups[i * 2];
    let t = bottom,
      b = top;
    for (let y = top; y < bottom; y++)
      for (let x = l; x < r; x++)
        if (ink(x, y)) {
          t = Math.min(t, y);
          b = Math.max(b, y + 1);
        }
    if (b - t < 4) return [];
    let s = names[i][0].repeat(2);
    let stems = 0,
      was = false;
    for (let x = l; x < r; x++) {
      let n = 0;
      for (let y = Math.round(t + (b - t) * 0.65); y < b; y++)
        if (ink(x, y)) n++;
      const on = n >= 2;
      if (on && !was) stems++;
      was = on;
    }
    if (names[i][0] === "Y") {
      if (stems !== 2 && stems !== 4) return [];
      s = "Y".repeat(stems);
    }
    result.push({
      s,
      stems,
      x0: l / W,
      x1: r / W,
      cy: (t + b) / 2 / H,
      h: (b - t) / H,
      confidence: 90,
    });
  }
  return result;
}
