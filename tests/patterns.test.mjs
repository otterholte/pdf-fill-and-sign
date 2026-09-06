import test from "node:test";
import assert from "node:assert/strict";
import { analyzeForm, ruleCells } from "../form-layout.mjs";
import { boxedFormats, splitNumber, yearHintToken } from "../field-formats.mjs";
const word = (s, x0, x1, cy, h = 0.012) => ({
  s,
  x0,
  x1,
  cy,
  h,
  confidence: 98,
});
const rules = (rects) => ({
  width: 1000,
  height: 1300,
  horizontal: rects.flatMap((c) =>
    [c.y0, c.y1].map((y) => ({ x0: c.x0, x1: c.x1, y0: y, y1: y })),
  ),
  vertical: rects.flatMap((c) =>
    [c.x0, c.x1].map((x) => ({ x0: x, x1: x, y0: c.y0, y1: c.y1 })),
  ),
});

test("aligned independent underlines are never table cells, even with distant labels", () => {
  for (let k = 0; k < 14; k++) {
    const x = 0.28 + k * 0.009,
      hs = [0.2, 0.3, 0.4].map((y) => ({ x0: x, x1: 0.94, y0: y, y1: y }));
    const rs = { horizontal: hs, vertical: [], width: 1000, height: 1300 };
    assert.equal(ruleCells(rs).length, 0);
    const scan = analyzeForm(
      hs.map((h, i) =>
        word(
          ["Contact name:", "Email address:", "Street address:"][i],
          0.05,
          0.22,
          h.y0 - 0.014,
        ),
      ),
      rs,
      { cells: [], boxes: [] },
    );
    assert.equal(scan.lines.length, 3);
    assert.ok(scan.lines.every((l) => l.label && l.x0 === x));
  }
});
test("external response-box labels work across box sizes and locations", () => {
  for (let k = 0; k < 12; k++) {
    const c = {
        x0: 0.06 + k * 0.002,
        x1: 0.93 - k * 0.012,
        y0: 0.2 + k * 0.013,
        y1: 0.35 + k * 0.023,
      },
      rs = rules([c]);
    const scan = analyzeForm(
      [word("Additional notes:", c.x0, c.x0 + 0.17, c.y0 - 0.017)],
      rs,
      { cells: [], boxes: [] },
    );
    const field = scan.cells.find((f) => f.label === "Additional notes");
    assert.ok(field, `size ${k}`);
    assert.equal(field.multiline, true);
    assert.ok(field.y0 > c.y0 && field.y1 < c.y1);
    assert.equal(scan.lines.length, 0);
  }
});
test("boxed date components use printed order above or below, never an assumed locale", () => {
  for (const tokens of [
    ["MM", "DD", "YYYY"],
    ["DD", "MM", "YYYY"],
    ["YYYY", "MM", "DD"],
    ["DD", "MM", "YY"],
  ])
    for (const above of [true, false])
      for (const offset of [0, 0.1]) {
        let x = 0.27 + offset;
        const boxes = tokens.map((t) => {
          const b = { x0: x, x1: x + t.length * 0.021, y0: 0.3, y1: 0.33 };
          x = b.x1 + 0.035;
          return b;
        });
        const words = [
          word("Start date:", 0.05, 0.2, 0.315),
          ...boxes.map((b, i) =>
            word(tokens[i], b.x0 + 0.01, b.x1 - 0.01, above ? 0.283 : 0.347),
          ),
        ];
        const formats = boxedFormats(boxes, words);
        assert.equal(formats.length, 1);
        assert.equal(formats[0].label, "Start date:");
        assert.deepEqual(
          formats[0].format.parts.map((p) => p.token),
          tokens,
        );
        assert.ok(
          formats[0].format.parts.every(
            (p) => !p.erase && p.y0 > 0.3 && p.y1 < 0.33,
          ),
        );
      }
});
test("equal character boxes accept letters and leading zeroes, reject overflow without truncating input", () => {
  for (const n of [4, 6, 8, 12]) {
    const boxes = Array.from({ length: n }, (_, i) => ({
      x0: 0.3 + i * 0.04,
      x1: 0.34 + i * 0.04,
      y0: 0.4,
      y1: 0.435,
    }));
    const [f] = boxedFormats(boxes, [word("Account ID:", 0.07, 0.23, 0.415)]);
    assert.equal(f.format.kind, "characters");
    assert.equal(f.format.parts.length, n);
    const value = "0A" + "B".repeat(n - 2),
      parsed = splitNumber(value, f.format);
    assert.equal(parsed.invalid, false);
    assert.equal(parsed.values.join(""), value);
    assert.equal(splitNumber(value + "X", f.format).invalid, true);
    assert.equal(splitNumber("A", f.format).incomplete, false);
    assert.equal(
      boxedFormats(boxes, [word("Instructions", 0.07, 0.23, 0.415)]).length,
      0,
    );
  }
});
test("letter O inside an option cannot be reintroduced as a fallback control", () => {
  const words = [word("Option", 0.3, 0.37, 0.5), word("A", 0.38, 0.39, 0.5)];
  const r = {
    x0: 0.3,
    x1: 0.313,
    y0: 0.494,
    y1: 0.506,
    cx: 0.3065,
    cy: 0.5,
    w: 0.013,
    h: 0.012,
    shape: "circle",
  };
  const scan = analyzeForm(
    words,
    { horizontal: [], vertical: [], width: 1000, height: 1300 },
    { cells: [], boxes: [r] },
    [r],
  );
  assert.equal(scan.boxes.length, 0);
});
test("year placeholder width is checked against two or four actual lower stems", () => {
  for (const count of [2, 3, 4]) {
    const W = 100,
      H = 30,
      data = new Uint8ClampedArray(W * H * 4).fill(255);
    for (let c = 0; c < count; c++)
      for (let y = 8; y < 22; y++)
        for (let x = 5 + c * 10; x < 8 + c * 10; x++) data[(y * W + x) * 4] = 0;
    assert.equal(
      yearHintToken(
        { width: W, height: H, data },
        word("YY", 0, 0.8, 0.5, 0.5),
      ),
      count === 4 ? "YYYY" : "YY",
    );
  }
});

test("OCR merging a circle with No does not discard the actual choice", () => {
  const ring = (x) => ({
    x0: x,
    x1: x + 0.018,
    y0: 0.4,
    y1: 0.414,
    cx: x + 0.009,
    cy: 0.407,
    w: 0.018,
    h: 0.014,
    shape: "circle",
  });
  const rs = { horizontal: [], vertical: [], width: 1000, height: 1300 };
  const scan = analyzeForm(
    [
      word("Available?", 0.02, 0.18, 0.407),
      word("Yes", 0.23, 0.26, 0.407),
      word("Ono", 0.28, 0.33, 0.407),
    ],
    rs,
    { cells: [], boxes: [] },
    [ring(0.2), ring(0.28)],
  );
  assert.equal(scan.boxes.length, 2);
});
