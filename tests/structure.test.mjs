import test from "node:test";
import assert from "node:assert/strict";
import {
  detectRules,
  analyzeForm,
  ruleCells,
  detectRings,
} from "../form-layout.mjs";
const word = (s, x0, cy, x1 = x0 + 0.07, h = 0.009) => ({
  s,
  x0,
  x1,
  cy,
  h,
  confidence: 98,
});
function raster(W, H) {
  return {
    width: W,
    height: H,
    data: new Uint8ClampedArray(W * H * 4).fill(255),
  };
}
function ink(im, x, y, w, h) {
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++)
      for (let c = 0; c < 3; c++) im.data[(j * im.width + i) * 4 + c] = 0;
}
test("black photo margins cannot absorb interior rules", () => {
  const im = raster(600, 700);
  ink(im, 0, 0, 600, 10);
  ink(im, 0, 0, 70, 700);
  ink(im, 530, 0, 70, 700);
  ink(im, 0, 690, 600, 10);
  for (const y of [100, 140, 180, 220]) ink(im, 100, y, 400, 1);
  const rules = detectRules(im);
  for (const y of [100, 140, 180, 220])
    assert.ok(
      rules.horizontal.some(
        (h) =>
          Math.abs(h.y0 - y / 700) < 0.003 && Math.abs(h.x0 - 1 / 6) < 0.003,
      ),
    );
});
test("short square controls survive without legible nearby OCR", () => {
  const im = raster(800, 1000);
  ink(im, 200, 200, 12, 1);
  ink(im, 200, 211, 12, 1);
  ink(im, 200, 200, 1, 12);
  ink(im, 211, 200, 1, 12);
  const rings = detectRings(im),
    scan = analyzeForm([], detectRules(im), { cells: [], boxes: [] }, rings);
  assert.equal(scan.boxes.length, 1);
  assert.equal(scan.boxes[0].shape, "square");
});
test("varied unseen caption boxes and compact tables use geometry and labels", () => {
  for (let seed = 0; seed < 12; seed++) {
    const dx = seed * 0.003,
      dy = seed * 0.007,
      x = [0.08 + dx, 0.29 + dx, 0.58 + dx, 0.86 + dx],
      ys = [0.25 + dy, 0.267 + dy, 0.284 + dy, 0.301 + dy];
    const horizontal = ys.map((y) => ({
      x0: x[0],
      x1: x[3],
      y0: y,
      y1: y + 0.0006,
    }));
    const vertical = x.map((v) => ({
      x0: v,
      x1: v + 0.0006,
      y0: ys[0],
      y1: ys.at(-1),
    }));
    const words = [
      word("Item", x[0] + 0.004, ys[0] + 0.008, x[1] - 0.01),
      word("Contact A", x[1] + 0.008, ys[0] + 0.008, x[2] - 0.01),
      word("Contact B", x[2] + 0.008, ys[0] + 0.008, x[3] - 0.01),
      word("First name", x[0] + 0.004, ys[1] + 0.008, x[1] - 0.01),
      word("Last name", x[0] + 0.004, ys[2] + 0.008, x[1] - 0.01),
    ];
    const cap = { x0: 0.13 + dx, x1: 0.7 + dx, y0: 0.1 + dy, y1: 0.15 + dy };
    horizontal.push(
      ...[cap.y0, cap.y1].map((y) => ({
        x0: cap.x0,
        x1: cap.x1,
        y0: y,
        y1: y + 0.0006,
      })),
    );
    vertical.push(
      ...[cap.x0, cap.x1].map((x) => ({
        x0: x,
        x1: x + 0.0006,
        y0: cap.y0,
        y1: cap.y1,
      })),
    );
    words.push(
      word("Email address", cap.x0 + 0.01, cap.y0 + 0.009, cap.x0 + 0.15),
    );
    const scan = analyzeForm(
      words,
      { horizontal, vertical, width: 1000, height: 1300 },
      { cells: [], boxes: [] },
    );
    const inputs = scan.cells.filter((c) => c.source === "grid");
    assert.equal(inputs.length, 4, `grid seed ${seed}`);
    for (const c of inputs) {
      assert.match(c.label, /^(First|Last) name — Contact [AB]$/);
      assert.ok(c.x1 - c.x0 > 0.2);
    }
    const email = scan.cells.find((c) => c.inputType === "email");
    assert.ok(email, `caption seed ${seed}`);
    assert.ok(email.y0 > cap.y0 + 0.013);
    assert.ok(email.y1 <= cap.y1);
  }
});
test("a dotted identifier row is one answer per column", () => {
  const horizontal = [0.2, 0.22, 0.24, 0.26].map((y) => ({
    x0: 0.1,
    x1: 0.7,
    y0: y,
    y1: y,
  }));
  const vertical = [0.1, 0.3, 0.5, 0.7].map((x) => ({
    x0: x,
    x1: x,
    y0: 0.2,
    y1: 0.26,
  }));
  vertical.push(
    ...[0.36, 0.42, 0.56, 0.62].map((x) => ({
      x0: x,
      x1: x,
      y0: 0.24,
      y1: 0.26,
    })),
  );
  const words = [
    word("Details", 0.11, 0.208, 0.28),
    word("Person 1", 0.31, 0.208, 0.48),
    word("Person 2", 0.51, 0.208, 0.68),
    word("Name", 0.11, 0.228, 0.28),
    word("SSN", 0.11, 0.248, 0.28),
  ];
  const scan = analyzeForm(
    words,
    { horizontal, vertical, width: 1000, height: 1300 },
    { cells: [], boxes: [] },
  );
  const ids = scan.cells.filter((c) => /^SSN/.test(c.label));
  assert.equal(ids.length, 2);
  assert.ok(ids.every((c) => c.w > 0.19));
});
