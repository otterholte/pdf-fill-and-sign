import { chromium } from "playwright";
import { serve } from "./server.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const fixture = process.env.MIXED_FIXTURE || "mixed-layout";
const truth = JSON.parse(
  await readFile(`tests/fixtures/${fixture}-truth.json`, "utf8"),
);
const out = process.env.TEST_OUTPUT || "tests/results/mixed";
await mkdir(out, { recursive: true });
const remote = process.env.TEST_BASE_URL,
  server = remote ? null : serve(0);
if (server) await new Promise((r) => server.once("listening", r));
const url = remote || `http://127.0.0.1:${server.address().port}/`;
if (remote)
  for (const f of ["app.js", "form-layout.mjs", "field-formats.mjs", "sw.js"])
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
  viewport: { width: 1280, height: 1200 },
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
    .setInputFiles(`tests/fixtures/${fixture}-blank.png`);
  await page.locator("#btnScanGo").click();
  await page.locator("#cropCancel").click();
  await page.locator('[data-tool="simple"]').click();
  await page.waitForFunction(
    () => window.__fs.SIMof().built,
    {},
    { timeout: 120000 },
  );
  const data = await page.evaluate(() => ({
    qs: window.__fs.SIMof().qs,
    words: window.__fs.S.pageBox[0].rawWords,
    rules: window.__fs.S.pageBox[0].formRules,
    scan: window.__fs.S.pageBox[0].scanned,
  }));
  await writeFile(`${out}/detected.json`, JSON.stringify(data, null, 2));

  const questions = data.qs,
    used = new Set(),
    matched = new Map();
  for (const f of truth.fields) {
    const re = new RegExp(f.label, "i");
    const q = questions.find(
      (q) => !used.has(q.key) && re.test(q.groupLabel || q.label),
    );
    assert.ok(q, `missing ${f.label}`);
    used.add(q.key);
    matched.set(f, q);
    if (f.kind === "radio") {
      assert.equal(q.group?.length, 2);
      continue;
    }
    const r = q.C ||
      q.B || { x0: q.L?.x0, x1: q.L?.x1, y0: q.L?.y - 0.018, y1: q.L?.y };
    const [l, t, rr, b] = f.rect,
      cx = ((r.x0 + r.x1) / 2) * truth.width,
      cy = ((r.y0 + r.y1) / 2) * truth.height;
    assert.ok(
      cx >= l - 5 && cx <= rr + 5 && cy >= t - 6 && cy <= b + 6,
      `${f.label} must land in its actual blank`,
    );
    if (f.tokens)
      assert.deepEqual(
        r.format?.parts.map((p) => p.token),
        f.tokens,
        "printed date order",
      );
    if (f.parts) {
      assert.deepEqual(
        r.format?.parts.map((p) => p.capacity),
        /employee|code|account/i.test(f.label)
          ? Array(f.parts.length).fill(1)
          : f.tokens
            ? f.tokens.map((t) => t.length)
            : /phone/i.test(f.label)
              ? [3, 3, 4]
              : [3, 2, 4],
      );
      r.format.parts.forEach((p, i) => {
        const a = f.parts[i];
        assert.ok(
          p.x0 * truth.width >= a[0] - 4 &&
            p.x1 * truth.width <= a[2] + 4 &&
            p.y0 * truth.height >= a[1] - 5 &&
            p.y1 * truth.height <= a[3] + 4,
          `segment ${i} of ${f.label} stays in its box`,
        );
      });
    }
  }
  assert.equal(
    used.size,
    questions.length,
    "no spurious header, border, or duplicate fields",
  );
  await ctx.setOffline(true);
  for (const f of truth.fields) {
    const q = matched.get(f),
      card = page.locator(`.q-card[data-q="${q.key}"]`);
    if (f.kind === "radio") {
      const opts = card.locator(".q-radio button");
      await opts.first().click();
      await opts.last().click();
      assert.equal(await opts.first().getAttribute("aria-pressed"), "false");
      assert.equal(await opts.last().getAttribute("aria-pressed"), "true");
      continue;
    }
    if (f.kind === "box") {
      await card.locator(".q-toggle").click();
      continue;
    }
    if (f.kind === "signature") {
      assert.ok(q.sign);
      await card
        .getByRole("button", { name: "Add signature", exact: true })
        .click();
      await page.locator('[data-tab="type"]').click();
      await page.locator("#typeName").fill("Alex Example");
      await page.locator("#sigUse").click();
      continue;
    }
    const inp = card.locator('input[id^="qi"],textarea[id^="qi"]');
    await inp.fill(f.value);
    if ((q.C || q.L)?.format?.kind === "characters") {
      assert.equal(await inp.getAttribute("inputmode"), "text");
      await inp.fill(f.value + "EXCESS");
      assert.equal(await inp.getAttribute("aria-invalid"), "true");
      assert.equal(await inp.inputValue(), f.value + "EXCESS");
      await inp.fill(f.value);
      assert.equal(await inp.getAttribute("aria-invalid"), "false");
    }
  }
  await page.locator("#simReview").click();
  const layouts = await page.evaluate(() =>
    window.__fs.S.items
      .filter((i) => i.answer)
      .map((i) => ({
        label: i.label,
        text: i.text,
        format: i.answer.format,
        ...window.__fs.answerLayout(i),
      })),
  );
  await writeFile(`${out}/layouts.json`, JSON.stringify(layouts, null, 2));
  assert.ok(
    layouts.every((l) => !l.overflow),
    "all sample values fit: " +
      JSON.stringify(
        layouts
          .filter((l) => l.overflow)
          .map((l) => ({ label: l.label, text: l.text, format: l.format })),
      ),
  );
  assert.equal(
    await page.evaluate(
      () => window.__fs.S.items.filter((i) => i.type === "sig").length,
    ),
    1,
  );
  await writeFile(`${out}/layouts.json`, JSON.stringify(layouts, null, 2));
  await page.evaluate(() =>
    window.__fs.setDocName("Local mixed layout test - FICTIONAL.pdf"),
  );
  await page.locator("#btnFinish").click();
  await page.locator("#done").waitFor({ state: "visible" });
  const promise = page.waitForEvent("download");
  await page.locator("#btnSave").click();
  await (await promise).saveAs(`${out}/filled.pdf`);
  const exported = await page.evaluate(
    async (bytes) => {
      const lib = await import("./vendor/pdf.min.mjs"),
        doc = await lib.getDocument({ data: new Uint8Array(bytes) }).promise,
        p = await doc.getPage(1),
        t = await p.getTextContent();
      const result = {
        width: p.view[2],
        height: p.view[3],
        items: t.items
          .filter((i) => i.str?.trim())
          .map((i) => ({
            s: i.str,
            x: i.transform[4],
            y: i.transform[5],
            w: i.width,
          })),
      };
      await doc.destroy();
      return result;
    },
    [...(await readFile(`${out}/filled.pdf`))],
  );
  for (const l of layouts.filter((l) => l.format))
    for (const r of l.runs)
      assert.ok(
        exported.items.some(
          (i) =>
            i.s === r.text &&
            Math.abs(i.x / exported.width - r.x) < 0.002 &&
            Math.abs(1 - i.y / exported.height - r.y) < 0.002,
        ),
        "exported segment matches measured position",
      );
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    fixture,
    logicalQuestions: questions.length,
    physicalControls: questions
      .filter((q) => q.kind === "box")
      .reduce((n, q) => n + (q.group?.length || 1), 0),
    segmentedFields: layouts.filter((l) => l.format).length,
    allExpectedFieldsVerified: true,
    allAnswersFit: true,
    signature: true,
    offlineFillAndExport: true,
    exportedSegmentsVerified: true,
    external,
    errors,
  };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  await browser.close();
  server?.close();
}
