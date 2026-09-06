import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { serve } from "./server.mjs";
const out = process.env.TEST_OUTPUT || "tests/results/dense";
await mkdir(out, { recursive: true });
const truth = JSON.parse(
  await readFile("tests/fixtures/dense-truth.json", "utf8"),
);
const remote = process.env.TEST_BASE_URL,
  server = remote ? null : serve(0);
if (server) await new Promise((r) => server.once("listening", r));
const url = remote || `http://127.0.0.1:${server.address().port}/`;
if (remote)
  for (const f of ["app.js", "form-layout.mjs", "sw.js"])
    assert.equal(
      (await (await fetch(new URL(f, url))).text()).replace(/\r\n/g, "\n"),
      (await readFile(f, "utf8")).replace(/\r\n/g, "\n"),
    );
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL
    ? { channel: process.env.BROWSER_CHANNEL }
    : {}),
});
const ctx = await browser.newContext({
  viewport: { width: 1350, height: 1200 },
  acceptDownloads: true,
});
const external = [],
  errors = [];
await ctx.route("**/*", (r) => {
  if (
    !r.request().url().startsWith(url) &&
    !r.request().url().startsWith("blob:") &&
    !r.request().url().startsWith("data:")
  ) {
    external.push(r.request().url());
    return r.abort();
  }
  return r.continue();
});
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__fs);
  await page
    .locator("#picInput")
    .setInputFiles("tests/fixtures/dense-blank.png");
  await page.locator("#btnScanGo").click();
  await page.locator("#cropCancel").click();
  const start = Date.now();
  await page.locator('[data-tool="simple"]').click();
  await page.waitForFunction(
    () => window.__fs.SIMof().built,
    {},
    { timeout: 120000 },
  );
  const ms = Date.now() - start;
  const data = await page.evaluate(() => {
    const a = window.__fs,
      p = a.S.pageBox[0];
    return {
      qs: a.SIMof().qs,
      scan: p.scanned,
      words: p.rawWords,
      rules: p.formRules,
      rings: p.formRings,
      spots: a.spotsForPage(0),
      heap: performance.memory?.usedJSHeapSize,
    };
  });
  await writeFile(`${out}/detection.json`, JSON.stringify(data, null, 2));
  const found = [],
    missed = [],
    used = new Set();
  for (const f of truth.fields) {
    const candidates = data.spots
      .map((s, i) => ({ s, i }))
      .filter(
        ({ s, i }) => !used.has(i) && (f.type === "box") === (s.kind === "box"),
      );
    const match = candidates.find(({ s }) => {
      if (f.type === "box")
        return (
          Math.hypot(s.B.cx * 1280 - f.center[0], s.B.cy * 1280 - f.center[1]) <
          4
        );
      const c = s.C || { x0: s.L.x0, x1: s.L.x1, y0: s.L.y - 0.013, y1: s.L.y };
      const [l, t, r, b] = f.rect,
        cx = (c.x0 + c.x1) * 640,
        cy = (c.y0 + c.y1) * 640;
      return (
        cx >= l - 3 &&
        cx <= r + 3 &&
        cy >= t - 3 &&
        cy <= b + 3 &&
        c.x0 * 1280 >= l - 5 &&
        c.x1 * 1280 <= r + 5
      );
    });
    if (match) {
      used.add(match.i);
      found.push(f.id);
    } else missed.push(f.id);
  }
  const falsePositives = data.spots
    .filter((s, i) => !used.has(i))
    .map((s) => ({
      label: (s.C || s.L || s.B)?.label,
      kind: s.kind,
      x: s.x,
      y: s.cy,
    }));
  const coverage = {
    expected: truth.fields.length,
    matched: found.length,
    recall: found.length / truth.fields.length,
    precision: found.length / data.spots.length,
    missed,
    falsePositives,
  };
  console.log(JSON.stringify(coverage, null, 2));
  for (const q of data.qs) {
    const card = page.locator(`.q-card[data-q="${q.key}"]`);
    if (q.group) {
      const buttons = card.locator(".q-radio button");
      await buttons.first().click();
      await buttons.last().click();
      assert.equal(await buttons.first().getAttribute("aria-pressed"), "false");
    } else if (q.kind === "box") await card.locator(".q-toggle").click();
    else {
      const label = q.label || "",
        c = q.C || q.L;
      const value =
        c.source === "amount"
          ? "123.00"
          : /social security|\bssn\b/i.test(label)
            ? "000-00-0000"
            : /zip|postal/i.test(label)
              ? "00000"
              : /state/i.test(label)
                ? "CO"
                : /first name/i.test(label)
                  ? "Alex"
                  : /last name/i.test(label)
                    ? "Example"
                    : /date|beginning|ending/i.test(label)
                      ? "01/01"
                      : "Sample";
      await card.locator('input[id^="qi"],textarea[id^="qi"]').fill(value);
    }
  }
  await page.locator("#simReview").click();
  const layouts = await page.evaluate(() =>
    window.__fs.S.items
      .filter((i) => i.answer)
      .map((i) => ({
        label: i.label,
        answer: i.answer,
        ...window.__fs.answerLayout(i),
      })),
  );
  await writeFile(`${out}/layouts.json`, JSON.stringify(layouts, null, 2));
  assert.ok(
    layouts.every((l) => !l.overflow),
    "every sample answer fits its detected bounds",
  );
  const sizes = layouts.map((l) => l.size),
    sharedSize = sizes.sort(
      (a, b) =>
        sizes.filter((x) => x === b).length -
        sizes.filter((x) => x === a).length,
    )[0];
  assert.ok(
    layouts.filter((l) => l.size === sharedSize).length >= layouts.length * 0.9,
    "at least 90% of answers share one size",
  );
  assert.ok(layouts.every((l) => l.size >= 6.75 && l.size <= 10));
  await page.evaluate(() =>
    window.__fs.setDocName("Dense form - FICTIONAL PLACEMENT TEST.pdf"),
  );
  await page.locator("#btnFinish").click();
  await page.locator("#done").waitFor({ state: "visible" });
  const downloading = page.waitForEvent("download");
  await page.locator("#btnSave").click();
  await (await downloading).saveAs(`${out}/local-dense-filled.pdf`);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  const report = {
    passed: false,
    coverage,
    detectionMs: ms,
    textAnswers: layouts.length,
    sharedFontSizePt: sharedSize,
    sharedSizeAnswers: layouts.filter((l) => l.size === sharedSize).length,
    heapMiB: Math.round(data.heap / 1024 / 1024),
    externalRequests: external,
    errors,
    scope:
      "Full-image browser OCR and geometry. Ground truth used only by Node for scoring. All sample values fictional; this tests placement, not tax calculations. Heap excludes worker/WASM/browser overhead; not a 4GB-device benchmark.",
  };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  assert.ok(
    coverage.recall >= 0.94,
    "at least 94% of independently annotated fields",
  );
  assert.ok(coverage.precision >= 0.96, "at least 96% precision");
  assert.equal(
    found.filter((id) => /^dep\d_/.test(id)).length,
    40,
    "all dependent text and control targets",
  );
  report.passed = true;
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  server?.close();
}
