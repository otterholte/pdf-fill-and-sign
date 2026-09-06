import { chromium } from "playwright";
import { serve } from "./server.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const out = process.env.TEST_OUTPUT || "tests/results/formats";
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
    .setInputFiles("tests/fixtures/number-formats-blank.png");
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
  const qs = data.qs.filter((q) => (q.C || q.L)?.format);
  assert.equal(
    qs.length,
    5,
    "SSN, phone, EIN and two differently ordered dates",
  );
  assert.deepEqual(
    qs.filter((q) => q.C?.format.kind === "date").map((q) => q.C.format.hint),
    ["YYYY/MM/DD", "DD/MM/YYYY"],
  );
  for (const q of qs) {
    const f = (q.C || q.L).format,
      inp = page.locator(`.q-card[data-q="${q.key}"] input[id^="qi"]`);
    let value =
      f.kind === "ssn"
        ? "000-12-3456"
        : f.kind === "phone"
          ? "+1 (212) 555-0100"
          : f.kind === "ein"
            ? "12-3456789"
            : f.parts
                .map((p) =>
                  p.token === "YYYY" ? "2025" : p.token === "MM" ? "03" : "14",
                )
                .join("/");
    await inp.fill(value + "123456");
    assert.equal(await inp.getAttribute("aria-invalid"), "true");
    assert.equal(
      await inp.inputValue(),
      value + "123456",
      "invalid input is not silently truncated",
    );
    await inp.fill(value);
    assert.equal(await inp.getAttribute("aria-invalid"), "false");
  }
  const first = page.locator(`.q-card[data-q="${qs[0].key}"]`);
  await first.locator("summary").click();
  await first.getByLabel("Use printed number format").uncheck();
  assert.equal(
    await first.locator('input[id^="qi"]').getAttribute("placeholder"),
    null,
  );
  await first.locator("summary").click();
  await first.getByLabel("Use printed number format").check();
  assert.equal(
    await first.locator('input[id^="qi"]').getAttribute("placeholder"),
    "123-45-6789",
  );
  await ctx.setOffline(true);
  await page.locator("#simReview").click();
  await page.evaluate(
    (key) =>
      window.__fs.enterSpot(window.__fs.SIMof().qs.find((q) => q.key === key)),
    qs[0].key,
  );
  const editor = page.locator(".number-editor");
  await editor.fill("000-98-7654");
  await editor.press("Tab");
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("number-editor"),
  );
  await page.locator(".number-editor").press("Escape");
  const layouts = await page.evaluate(() =>
    window.__fs.S.items
      .filter((i) => i.answer?.format)
      .map((i) => ({
        id: i.id,
        text: i.text,
        format: i.answer.format,
        ...window.__fs.answerLayout(i),
      })),
  );
  assert.equal(layouts.length, 5);
  assert.ok(layouts.every((l) => !l.overflow));
  for (const l of layouts)
    assert.deepEqual(
      l.runs.map((r) => r.text.length),
      l.format.parts.map((p) => p.capacity),
    );
  // The page preview uses positioned spans, including while the inline editor updates.
  assert.equal(
    await page.locator(".number-part").count(),
    layouts.reduce((n, l) => n + l.runs.length, 0),
  );
  await page.screenshot({ path: `${out}/preview.png`, fullPage: true });
  await page.evaluate(() =>
    window.__fs.setDocName("Local number format regression - SAMPLE.pdf"),
  );
  await page.locator("#btnFinish").click();
  await page.locator("#done").waitFor({ state: "visible" });
  const promise = page.waitForEvent("download");
  await page.locator("#btnSave").click();
  await (await promise).saveAs(`${out}/number-formats-filled.pdf`);
  const exported = await page.evaluate(
    async (bytes) => {
      const lib = await import("./vendor/pdf.min.mjs"),
        doc = await lib.getDocument({ data: new Uint8Array(bytes) }).promise;
      const p = await doc.getPage(1),
        text = await p.getTextContent();
      const data = {
        width: p.view[2],
        height: p.view[3],
        items: text.items
          .filter((i) => i.str?.trim())
          .map((i) => ({
            s: i.str,
            x: i.transform[4],
            y: i.transform[5],
            w: i.width,
          })),
      };
      await doc.destroy();
      return data;
    },
    [...(await readFile(`${out}/number-formats-filled.pdf`))],
  );
  for (const l of layouts)
    for (const r of l.runs)
      assert.ok(
        exported.items.some(
          (i) =>
            i.s === r.text &&
            Math.abs(i.x / exported.width - r.x) < 0.002 &&
            Math.abs(1 - i.y / exported.height - r.y) < 0.002,
        ),
        "PDF stores each segment at the same measured position",
      );
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    formattedFields: 5,
    orders: qs
      .filter((q) => q.C?.format.kind === "date")
      .map((q) => q.C.format.hint),
    external,
    errors,
    screenAndPdfGroupsVerified: true,
    inlineTabEditing: true,
    formatOverride: true,
    offlineFillAndExport: true,
  };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  await browser.close();
  server?.close();
}
