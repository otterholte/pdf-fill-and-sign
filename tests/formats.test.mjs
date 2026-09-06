import test from "node:test";
import assert from "node:assert/strict";
import {
  numberFormat,
  placeholderFields,
  formatLayout,
  splitNumber,
  connectNumberLines,
  dateHintGeometry,
} from "../field-formats.mjs";
const measure = (s, f) => s.length * f * 0.56;
function field(label, counts, offset = 0.1, unit = 0.025) {
  let x = offset;
  const cuts = [];
  for (const n of counts.slice(0, -1)) {
    x += n * unit;
    cuts.push({ x0: x, x1: x, y0: 0.2, y1: 0.23 });
  }
  return {
    f: {
      label,
      x0: offset,
      x1: offset + counts.reduce((a, b) => a + b) * unit,
      y0: 0.2,
      y1: 0.23,
    },
    r: { vertical: cuts },
  };
}
test("SSN, phone, EIN and ZIP groups follow moved/scaled physical guides", () => {
  for (const [label, counts, value, want] of [
    ["SSN", [3, 2, 4], "123-45-6789", ["123", "45", "6789"]],
    ["Phone", [3, 3, 4], "+1 (212) 555-0100", ["212", "555", "0100"]],
    ["EIN", [2, 7], "12-3456789", ["12", "3456789"]],
    ["ZIP", [5, 4], "12345-6789", ["12345", "6789"]],
  ])
    for (const offset of [0.08, 0.3]) {
      const { f, r } = field(label, counts, offset),
        format = numberFormat(f, r);
      assert.ok(format);
      assert.deepEqual(splitNumber(value, format).values, want);
      const fit = formatLayout(value, format, {
        W: 612,
        H: 792,
        fontSize: 10,
        measure,
      });
      assert.equal(fit.overflow, false);
      for (const run of fit.runs) {
        assert.ok(run.x >= run.part.x0);
        assert.ok(run.x + measure(run.text, fit.size) / 612 <= run.part.x1);
      }
    }
});
test("ambiguous free text gets no forced numeric format", () => {
  const { f, r } = field("Applicant name", [3, 2, 4]);
  assert.equal(numberFormat(f, r), null);
  assert.equal(numberFormat({ ...f, label: "Date" }, r), null);
});
test("partial and excessive numbers are reported without silently discarding input", () => {
  const { f, r } = field("SSN", [3, 2, 4]),
    fmt = numberFormat(f, r);
  assert.equal(splitNumber("12345", fmt).incomplete, true);
  assert.equal(splitNumber("1234567890", fmt).invalid, true);
  assert.equal(splitNumber("123-45-67890", fmt).invalid, true);
  assert.equal(splitNumber("123abc", fmt).invalid, true);
  assert.equal(splitNumber("", fmt).invalid, false);
});
test("date order and slash gaps come from explicit placeholder positions", () => {
  for (const order of [
    ["MM", "DD", "YYYY"],
    ["DD", "MM", "YYYY"],
    ["YYYY", "MM", "DD"],
  ]) {
    let x = 0.2;
    const words = order.map((s) => {
      const w = { s, x0: x, x1: x + s.length * 0.012, cy: 0.3, h: 0.01 };
      x = w.x1 + 0.009;
      return w;
    });
    const f = placeholderFields(words)[0];
    assert.ok(f);
    assert.deepEqual(
      f.format.parts.map((p) => p.token),
      order,
    );
    const values = order.map((t) =>
        t === "MM" ? "02" : t === "DD" ? "29" : "2024",
      ),
      parsed = splitNumber(values.join("/"), f.format);
    assert.equal(parsed.invalid, false);
    const fit = formatLayout(values.join("/"), f.format, {
      W: 612,
      H: 792,
      fontSize: 10,
      measure,
    });
    assert.equal(fit.patches.length, 3);
    assert.equal(fit.runs.map((r) => r.text).join(""), values.join(""));
    assert.ok(fit.runs.every((r) => !r.text.includes("/")));
    for (let i = 0; i < 2; i++)
      assert.ok(
        fit.patches[i].x1 < fit.patches[i + 1].x0,
        "printed slash remains uncovered",
      );
    assert.equal(
      splitNumber(
        order
          .map((t) => (t === "MM" ? "02" : t === "DD" ? "30" : "2025"))
          .join("/"),
        f.format,
      ).invalid,
      true,
    );
  }
});
test("separate phone underlines become one field, with no neighboring label swallowed", () => {
  const lines = [
    { label: "Phone", x0: 0.2, x1: 0.29, y: 0.4 },
    { label: "", x0: 0.31, x1: 0.4, y: 0.4 },
    { label: "", x0: 0.42, x1: 0.54, y: 0.4 },
  ];
  const r = connectNumberLines(lines);
  assert.equal(r.fields.length, 1);
  assert.equal(r.used.size, 3);
  assert.deepEqual(
    r.fields[0].format.parts.map((p) => p.capacity),
    [3, 3, 4],
  );
  assert.ok(
    connectNumberLines(
      lines.map((l, i) => ({ ...l, label: i === 1 ? "Postal code" : l.label })),
    ).fields.every((f) => f.label !== "Phone"),
  );
});

test("repeated date columns on different rows remain distinct", () => {
  const row = (y) =>
    ["MM", "DD", "YYYY"].map((s, i) => ({
      s,
      x0: 0.2 + i * 0.05,
      x1: 0.22 + i * 0.05,
      cy: y,
      h: 0.012,
    }));
  assert.equal(placeholderFields([...row(0.2), ...row(0.5)]).length, 2);
});
test("image evidence recovers repeated year letters without copying OCR bounding boxes", () => {
  const glyphs = {
    M: ["10001", "11011", "10101", "10001", "10001", "10001", "10001"],
    D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    "/": ["00001", "00001", "00010", "00100", "01000", "10000", "10000"],
  };
  for (const count of [2, 4]) {
    const width = 240,
      height = 25,
      data = new Uint8ClampedArray(width * height * 4).fill(255);
    let x = 4;
    for (const word of ["MM", "/", "DD", "/", "Y".repeat(count)]) {
      for (const ch of word) {
        for (let y = 0; y < 7; y++)
          for (let k = 0; k < 5; k++)
            if (glyphs[ch][y][k] === "1")
              for (let a = 0; a < 2; a++)
                for (let b = 0; b < 2; b++) {
                  const i = ((3 + y * 2 + a) * width + x + k * 2 + b) * 4;
                  data[i] = data[i + 1] = data[i + 2] = 0;
                }
        x += 12;
      }
      x += 9;
    }
    const result = dateHintGeometry(
      { width, height, data },
      { left: 0, right: width, top: 0, bottom: 20 },
      "MM DD YY",
    );
    assert.deepEqual(
      result.map((r) => r.s),
      ["MM", "DD", "Y".repeat(count)],
    );
    assert.ok(result.every((r) => r.h === 14 / height));
  }
});
