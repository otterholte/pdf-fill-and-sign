import test from "node:test";
import assert from "node:assert/strict";
import {
  phraseWords,
  readingOrder,
  fitFieldText,
  fieldType,
  detectRules,
  analyzeForm,
} from "../form-layout.mjs";
test("word grouping survives differing baselines without joining columns", () => {
  const words = [
    { s: "First", x0: 0.1, x1: 0.15, cy: 0.2, h: 0.01 },
    { s: "name", x0: 0.154, x1: 0.2, cy: 0.199, h: 0.01 },
    { s: "ZIP", x0: 0.65, x1: 0.7, cy: 0.199, h: 0.01 },
  ];
  assert.deepEqual(
    phraseWords(words).map((w) => w.s),
    ["First name", "ZIP"],
  );
});
test("column separators prevent merging nearby table headings", () => {
  assert.equal(
    phraseWords(
      [
        { s: "Name", x0: 0.1, x1: 0.2, cy: 0.2, h: 0.02 },
        { s: "Years", x0: 0.21, x1: 0.3, cy: 0.2, h: 0.02 },
      ],
      { vertical: [{ x0: 0.205, y0: 0.1, y1: 0.3 }] },
    ).length,
    2,
  );
});
test("date subrows keep FROM before TO while traversing a merged employer row", () => {
  const spots = [
    { id: "to", x: 0.16, cy: 0.81, h: 0.013, C: { x1: 0.3 } },
    { id: "employer", x: 0.32, cy: 0.8, h: 0.034, C: { x1: 0.59 } },
    { id: "from", x: 0.18, cy: 0.79, h: 0.013, C: { x1: 0.3 } },
  ];
  assert.deepEqual(
    readingOrder(spots).map((x) => x.id),
    ["from", "to", "employer"],
  );
});
test("multiline layout fits long names and honors every explicit line", () => {
  const fit = fitFieldText(
    "A long business name\n123 Example Road",
    { width: 110, height: 40, fontSize: 10, multiline: true },
    (s, f) => s.length * f * 0.5,
  );
  assert.equal(fit.overflow, false);
  assert.ok(fit.lines.length >= 2);
  assert.equal(fit.lines.join(" "), "A long business name 123 Example Road");
});
test("unbreakable text cannot silently clip or shrink below the minimum", () => {
  assert.equal(
    fitFieldText(
      "W".repeat(300),
      { width: 70, height: 14, fontSize: 10, minFontSize: 7, multiline: false },
      (s, f) => s.length * f * 0.8,
    ).overflow,
    true,
  );
});
test("signature classification does not turn an assigned-position field into a signature", () => {
  assert.equal(fieldType("Assigned position"), "text");
  assert.equal(fieldType("Applicant signature"), "signature");
  assert.equal(fieldType("Telephone"), "tel");
  assert.equal(fieldType("Date of birth"), "date");
});
test("pixel geometry is translation/scale based, without a known template", () => {
  const image = {
    width: 500,
    height: 650,
    data: new Uint8ClampedArray(500 * 650 * 4).fill(255),
  };
  for (let y = 200; y < 202; y++)
    for (let x = 110; x < 360; x++) {
      const i = (y * 500 + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = 0;
    }
  const rules = detectRules(image);
  assert.equal(rules.horizontal.length, 1);
  assert.ok(Math.abs(rules.horizontal[0].x0 - 0.22) < 0.003);
  assert.ok(Math.abs(rules.horizontal[0].y0 - 200 / 650) < 0.003);
});
test("a standalone line with a signature label survives structural refinement", () => {
  const words = [{ s: "Signature", x0: 0.1, x1: 0.2, cy: 0.296, h: 0.012 }];
  const scan = analyzeForm(
    words,
    {
      horizontal: [{ x0: 0.21, x1: 0.7, y0: 0.305, y1: 0.306 }],
      vertical: [],
      width: 900,
      height: 1200,
    },
    { lines: [], cells: [], cellsAll: [], boxes: [] },
  );
  assert.equal(scan.lines.length, 1);
  assert.equal(scan.lines[0].inputType, "signature");
});

test("extrapolated control positions need outline evidence", () => {
  const real = {
    x0: 0.2,
    x1: 0.22,
    y0: 0.3,
    y1: 0.32,
    cx: 0.21,
    cy: 0.31,
    w: 0.02,
    h: 0.02,
  };
  const guessed = { ...real, x0: 0.5, x1: 0.52, cx: 0.51, guessed: 1 };
  const result = analyzeForm(
    [],
    { horizontal: [], vertical: [], width: 1000, height: 1000 },
    { cells: [], boxes: [real, guessed] },
    [],
  );
  assert.equal(result.boxes.length, 1);
  assert.equal(result.boxes[0], real);
});
