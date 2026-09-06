/* The truth fixture is used ONLY to score the result and supply sample values.
   The browser never receives its coordinates. Detection runs on the uploaded JPG. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { serve } from "./server.mjs";
const root = path.resolve("tests/fixtures"),
  out = path.resolve(process.env.TEST_OUTPUT || "tests/results");
await mkdir(out, { recursive: true });
const deployedUrl = process.env.TEST_BASE_URL;
const server = deployedUrl ? null : serve(0);
if (server) await new Promise((r) => server.once("listening", r));
const url = deployedUrl
  ? new URL(deployedUrl.endsWith("/") ? deployedUrl : deployedUrl + "/").href
  : `http://127.0.0.1:${server.address().port}`;
if (deployedUrl) {
  // Refuse a stale deployment: exercise exactly the code in this checkout.
  for (const file of [
    "app.js",
    "form-layout.mjs",
    "field-formats.mjs",
    "sw.js",
  ]) {
    const response = await fetch(new URL(file, url));
    assert.ok(response.ok, `deployed ${file} is available`);
    assert.equal(
      (await response.text()).replace(/\r\n/g, "\n"),
      (await readFile(file, "utf8")).replace(/\r\n/g, "\n"),
      `deployed ${file} matches the tested checkout`,
    );
  }
}
const truth = JSON.parse(
  await readFile(path.join(root, "employment-truth.json"), "utf8"),
);
const values = JSON.parse(
  await readFile(path.join(root, "employment-values.json"), "utf8"),
);
const options = { headless: true };
if (process.env.BROWSER_CHANNEL) options.channel = process.env.BROWSER_CHANNEL;
const browser = await chromium.launch(options);
const context = await browser.newContext({
  viewport: { width: 1280, height: 1100 },
  acceptDownloads: true,
});
const external = [],
  errors = [],
  warnings = [];
await context.route("**/*", (route) => {
  const request = route.request().url();
  if (
    !request.startsWith(url) &&
    !request.startsWith("blob:") &&
    !request.startsWith("data:")
  ) {
    external.push(request);
    return route.abort();
  }
  return route.continue();
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "warning" && /OCR|scan failed/.test(m.text()))
    warnings.push(m.text());
});
try {
  await page.goto(url);
  await page.waitForFunction(() => !!window.__fs);
  await page
    .locator("#picInput")
    .setInputFiles(path.join(root, "employment-blank.jpg"));
  await page.locator("#scanPrev").waitFor({ state: "visible" });
  await page.locator("#btnScanGo").click();
  await page.locator("#cropCancel").waitFor({ state: "visible" });
  await page.locator("#cropCancel").click();
  const start = Date.now();
  await page.locator('[data-tool="simple"]').click();
  await page.waitForFunction(
    () => window.__fs.SIMof().built,
    {},
    { timeout: 90000 },
  );
  const detectionMs = Date.now() - start;
  const detected = await page.evaluate(() => {
    const a = window.__fs;
    return {
      questions: a.SIMof().qs,
      words: a.S.pageBox[0].rawWords,
      sections: a.S.pageBox[0].scanned.sections,
      spots: a.spotsForPage(0),
      heap: performance.memory?.usedJSHeapSize,
    };
  });
  await writeFile(
    path.join(out, "detected-fields.json"),
    JSON.stringify(detected, null, 2),
  );
  assert.equal(
    detected.questions.length,
    57,
    "57 distinct questions, no header fields",
  );
  assert.equal(detected.spots.length, 60, "54 text targets plus six controls");
  assert.equal(detected.sections.length, 5, "five actual sections");
  assert.equal(
    detected.questions.filter((q) => q.group).length,
    3,
    "three exclusive groups",
  );
  // Reading order must match independently labeled fields; no nearest-field
  // remapping or geometry is injected to rescue a wrong detector result.
  const coverage = [];
  for (let i = 0; i < truth.fields.length; i++) {
    const f = truth.fields[i],
      q = detected.questions[i];
    if (f.type === "radio") {
      assert.ok(q.group, `${f.id} is a choice group`);
      for (const [j, option] of ["yes", "no"].entries()) {
        const b = q.group[j].B,
          [x, y] = f.options[option];
        assert.ok(
          Math.hypot(b.cx * 795 - x, b.cy * 1000 - y) < 3,
          `${f.id}/${option} centered on circle`,
        );
      }
    } else {
      assert.ok(!q.group, `${f.id} is text`);
      const r = q.C || { x0: q.L.x0, x1: q.L.x1, y0: q.L.y - 0.014, y1: q.L.y };
      const cx = ((r.x0 + r.x1) / 2) * 795,
        cy = ((r.y0 + r.y1) / 2) * 1000,
        [l, t, right, bottom] = f.box;
      assert.ok(
        cx >= l - 3 && cx <= right + 3 && cy >= t - 4 && cy <= bottom + 3,
        `${f.id} lands inside expected answer area (${cx},${cy})`,
      );
    }
    coverage.push({ field: f.id, detectedLabel: q.label, section: q.section });
  }
  // Fill through real visible inputs and buttons, so both views share state.
  for (let i = 0; i < truth.fields.length; i++) {
    const f = truth.fields[i],
      q = detected.questions[i],
      value = values[f.id].value;
    const card = page.locator(`.q-card[data-q="${q.key}"]`);
    if (f.type === "radio") {
      const buttons = card.locator(".q-radio button");
      await buttons.nth(0).click();
      await buttons.nth(1).click();
      assert.equal(await buttons.nth(0).getAttribute("aria-pressed"), "false");
      assert.equal(await buttons.nth(1).getAttribute("aria-pressed"), "true");
      if (value === "yes") await buttons.nth(0).click();
    } else await card.locator('input[id^="qi"],textarea[id^="qi"]').fill(value);
  }
  // The Today control must work and leave its value editable.
  const dateIndex = truth.fields.findIndex(
    (f) => f.id === "available_start_date",
  );
  const dateCard = page.locator(
    `.q-card[data-q="${detected.questions[dateIndex].key}"]`,
  );
  await dateCard.getByRole("button", { name: "Today", exact: true }).click();
  assert.match(
    await dateCard.locator('input[id^="qi"]').inputValue(),
    /^\d{2}\/\d{2}\/\d{4}$/,
  );
  await dateCard
    .locator('input[id^="qi"]')
    .fill(values.available_start_date.value);
  await page.locator("#simReview").click();
  const layouts = await page.evaluate(() =>
    window.__fs.S.items
      .filter((i) => i.answer)
      .map((i) => ({
        label: i.label,
        answer: i.answer,
        text: i.text,
        ...window.__fs.answerLayout(i),
      })),
  );
  await writeFile(
    path.join(out, "text-layouts.json"),
    JSON.stringify(layouts, null, 2),
  );
  assert.equal(layouts.length, 54);
  assert.ok(
    layouts.every((l) => !l.overflow),
    "all sample answers fit",
  );
  const uniformAnswers = layouts.filter(
    (l) => Math.abs(l.size - 10) < 0.01,
  ).length;
  assert.ok(
    uniformAnswers >= 46,
    `at least 85% of answers retain the shared 10 pt size (${uniformAnswers}/54)`,
  );
  assert.ok(
    layouts.every((l) => l.size <= 10 && l.size >= 8.75),
    "only constrained answers shrink, within a narrow readable range",
  );
  const pageHeight = await page.evaluate(() => window.__fs.S.pageBox[0].uh);
  for (const layout of layouts) {
    for (const run of layout.runs) {
      assert.ok(
        run.y * pageHeight - layout.ascent >=
          layout.answer.y0 * pageHeight - 0.01,
        `${layout.label}: glyph top stays inside field`,
      );
      assert.ok(
        run.y * pageHeight + layout.descent <=
          layout.answer.y1 * pageHeight + 0.01,
        `${layout.label}: descenders stay inside field`,
      );
    }
  }
  // Exercise actual keyboard navigation, including reverse Tab.
  await page.locator("#btnNextSpot").click();
  const before = await page.evaluate(() => window.__fs.KB.key);
  await page.keyboard.press("Tab");
  assert.notEqual(await page.evaluate(() => window.__fs.KB.key), before);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => window.__fs.KB.key), before);
  await page.locator("#stage").click({ position: { x: 3, y: 3 } });
  // Existing automatically fitted answers migrate to the shared size, while
  // an explicit user resize still works and can be undone.
  const resizedId = await page.evaluate(() => {
    const a = window.__fs,
      it = a.S.items.find((i) => i.answer);
    it.maxFs = 0.005;
    a.paintItems();
    if (Math.abs(a.answerLayout(it).size - 10) > 0.01)
      throw new Error("Legacy OCR size overrode uniform typography");
    a.select(it.id);
    return it.id;
  });
  await page.locator("#btnSmaller").click();
  assert.ok(
    await page.evaluate((id) => {
      const a = window.__fs,
        it = a.S.items.find((i) => i.id === id);
      return it.fs * a.S.pageBox[0].uh < 9;
    }, resizedId),
    "explicit resize is respected",
  );
  await page.locator("#btnUndo").click();
  assert.equal(
    await page.evaluate(
      (id) =>
        window.__fs.answerLayout(window.__fs.S.items.find((i) => i.id === id))
          .size,
      resizedId,
    ),
    10,
    "undo restores uniform size",
  );
  await page.locator("#stage").click({ position: { x: 3, y: 3 } });
  // Export with the application's own pdf-lib path. No external renderer fills it.
  await page.evaluate(() =>
    window.__fs.setDocName("Local-only employment form - SAMPLE DATA.pdf"),
  );
  await page.locator("#btnFinish").click();
  await page.locator("#done").waitFor({ state: "visible" });
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#btnSave").click();
  const download = await downloadPromise;
  await download.saveAs(path.join(out, "local-only-filled-form.pdf"));
  const exportedSizes = await page.evaluate(
    async (bytes) => {
      const pdfjs = await import(new URL("vendor/pdf.min.mjs", location.href));
      const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) })
        .promise;
      try {
        const text = await (await doc.getPage(1)).getTextContent();
        return text.items
          .filter((i) => i.str?.trim())
          .map((i) => Math.hypot(i.transform[2], i.transform[3]));
      } finally {
        await doc.destroy();
      }
    },
    [...(await readFile(path.join(out, "local-only-filled-form.pdf")))],
  );
  assert.ok(
    exportedSizes.length >= 54,
    "exported PDF contains all text answers",
  );
  assert.ok(
    exportedSizes.every((size) => size >= 8.75 - 0.01 && size <= 10 + 0.01),
    "actual exported font sizes match the readable range",
  );

  await page.locator("#btnContinue").click();
  await page.screenshot({
    path: path.join(out, "page-view.png"),
    fullPage: true,
  });
  await page.locator('[data-tool="simple"]').click();
  await page.waitForFunction(() => window.__fs.SIMof().built);
  // A previous bug returned a checkbox value instead of the cell's text.
  const firstCell = truth.fields.findIndex(
    (f) => f.id === "high_school_school_location",
  );
  assert.equal(
    await page
      .locator(
        `.q-card[data-q="${detected.questions[firstCell].key}"] textarea[id^="qi"]`,
      )
      .inputValue(),
    values.high_school_school_location.value,
  );
  await page.screenshot({
    path: path.join(out, "questions-view.png"),
    fullPage: true,
  });
  // Corrections must affect both an existing answer and the saved local map.
  const firstCard = page.locator(
    `.q-card[data-q="${detected.questions[0].key}"]`,
  );
  await firstCard.locator("summary").click();
  await firstCard
    .getByLabel("Field label", { exact: true })
    .fill("Applicant name");
  await firstCard.getByLabel("Field label", { exact: true }).press("Tab");
  await firstCard
    .getByLabel("Text alignment", { exact: true })
    .selectOption("center");
  assert.equal(
    await page.evaluate(
      () =>
        window.__fs.S.items.find(
          (i) => i.lineKey === window.__fs.SIMof().qs[0].key,
        )?.answer.align,
    ),
    "center",
  );
  await firstCard
    .getByLabel("Text alignment", { exact: true })
    .selectOption("left");
  // A manually moved answer must release old bounds and any overflow warning.
  await page.evaluate(() => {
    const a = window.__fs,
      it = a.S.items.find((i) => i.answer);
    it.overflow = true;
    it.x += 0.025;
    a.paintItems();
    if (it.answer || it.overflow)
      throw new Error("Moving an answer retained automatic bounds/overflow");
  });
  const originalPdfBytes = await page.evaluate(() => [
    ...new Uint8Array(window.__fs.S.bytes),
  ]);
  // A separate clean fixture exercises existing AcroForm widgets and a real
  // signature line; the supplied employment form has no signature field.
  const fixture = await page.evaluate(async () => {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create(),
      p = doc.addPage([612, 792]),
      font = await doc.embedFont(StandardFonts.Helvetica);
    p.drawText("LOCAL SIGNATURE TEST - SAMPLE DATA", {
      x: 45,
      y: 735,
      size: 16,
      font,
    });
    p.drawText("Full name", { x: 45, y: 620, size: 11, font });
    const form = doc.getForm(),
      name = form.createTextField("full_name");
    name.addToPage(p, { x: 160, y: 610, width: 270, height: 23, fontSize: 11 });
    p.drawText("I confirm this sample", { x: 68, y: 578, size: 11, font });
    form
      .createCheckBox("confirmed")
      .addToPage(p, { x: 45, y: 575, width: 13, height: 13 });
    for (const [label, y] of [
      ["Signature", 520],
      ["Date", 475],
    ]) {
      p.drawText(label, { x: 45, y: y + 3, size: 11, font });
      p.drawLine({
        start: { x: 160, y },
        end: { x: 435, y },
        thickness: 0.7,
        color: rgb(0, 0, 0),
      });
    }
    p.node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: [45, 700, 180, 715],
          A: {
            Type: "Action",
            S: "URI",
            URI: PDFLib.PDFString.of("https://example.com"),
          },
        }),
      ),
    );
    return [...(await doc.save())];
  });
  await page.evaluate(() => window.__fs.showPage());
  await page.locator("#fileInput").setInputFiles({
    name: "signature-fixture.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(fixture),
  });
  await page.locator('[data-tool="simple"]').click();
  await page.waitForFunction(
    () => window.__fs.SIMof().built,
    {},
    { timeout: 90000 },
  );
  const nativeQs = await page.evaluate(() => window.__fs.SIMof().qs);
  await writeFile(
    path.join(out, "native-fields.json"),
    JSON.stringify(nativeQs, null, 2),
  );
  assert.equal(
    nativeQs.filter((q) => q.kind === "field").length,
    2,
    "declared widgets remain authoritative",
  );
  assert.ok(
    nativeQs.some((q) => q.sign),
    "signature classified from its printed label",
  );
  const nameQuestion = nativeQs.find((q) => q.f?.name === "full_name");
  await page
    .locator(`.q-card[data-q="${nameQuestion.key}"] input[id^="qi"]`)
    .fill("Alex Example");
  const checkQuestion = nativeQs.find((q) => q.f?.name === "confirmed");
  await page
    .locator(`.q-card[data-q="${checkQuestion.key}"] .q-toggle`)
    .click();
  await page
    .getByRole("button", { name: "Add signature", exact: true })
    .click();
  await page.locator('[data-tab="type"]').click();
  await page.locator("#typeName").fill("Alex Example");
  await page.locator("#sigUse").click();
  await page.waitForFunction(() =>
    window.__fs.S.items.some((i) => i.type === "sig" && i.sigLine),
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.__fs.S.items.filter((i) => i.type === "sig" && i.sigLine).length,
    ),
    1,
  );
  const sigFit = await page.evaluate(() => {
    const a = window.__fs,
      it = a.S.items.find((i) => i.type === "sig"),
      q = a.SIMof().qs.find((q) => q.sign),
      p = a.S.pageBox[0];
    return (
      it.x >= q.L.x0 &&
      it.x + it.w <= q.L.x1 + 0.01 &&
      it.y + (it.w * p.uw * it.ar) / p.uh <= q.L.y
    );
  });
  assert.ok(sigFit, "signature stays above and inside its detected line");
  const dateQuestion = nativeQs.find((q) => !q.sign && q.inputType === "date");
  assert.ok(dateQuestion, "date label is classified");
  await page
    .locator(`.q-card[data-q="${dateQuestion.key}"] input[id^="qi"]`)
    .fill("September 5, 2026");
  const signatureBytes = await page.evaluate(async () => [
    ...new Uint8Array(await (await window.__fs.buildPdf()).arrayBuffer()),
  ]);
  await writeFile(
    path.join(out, "local-signature-test.pdf"),
    Buffer.from(signatureBytes),
  );
  await page.evaluate(async (bytes) => {
    const doc = await PDFLib.PDFDocument.load(new Uint8Array(bytes));
    const annots = doc.getPage(0).node.Annots()?.asArray() || [];
    if (annots.some((ref) => !doc.context.lookup(ref)))
      throw new Error("Dangling annotation in exported PDF");
    if (
      annots.length !== 1 ||
      doc.context
        .lookup(annots[0])
        .get(PDFLib.PDFName.of("Subtype"))
        .toString() !== "/Link"
    )
      throw new Error("Export did not preserve the original link annotation");
    if (doc.getForm().getFields().length)
      throw new Error("Export did not flatten native fields");
  }, signatureBytes);
  // Reload the installed shell and scan the same JPG with the browser offline.
  // OCR/core/language data must be cached, not silently fetched from a CDN.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const expected = [
      "form-layout.mjs",
      "vendor/ocr/eng.traineddata",
      "vendor/ocr/tesseract-core-simd-lstm.wasm",
    ];
    for (const asset of expected)
      if (!(await caches.match(new URL(asset, location.href).href)))
        throw new Error("Offline asset missing: " + asset);
  });
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !!window.__fs);
  await page
    .locator("#picInput")
    .setInputFiles(path.join(root, "employment-blank.jpg"));
  await page.locator("#scanPrev").waitFor({ state: "visible" });
  await page.locator("#btnScanGo").click();
  await page.locator("#cropCancel").waitFor({ state: "visible" });
  await page.locator("#cropCancel").click();
  await page.locator('[data-tool="simple"]').click();
  await page.waitForFunction(
    () => window.__fs.SIMof().built,
    {},
    { timeout: 90000 },
  );
  assert.equal(
    await page.evaluate(() => window.__fs.SIMof().qs.length),
    57,
    "fresh offline detection finds the same 57 questions",
  );
  // Reopen the exact saved document: a newly generated scan is a new document.
  await page.evaluate(() => window.__fs.showPage());
  await page.locator("#fileInput").setInputFiles({
    name: "reopened-employment.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(originalPdfBytes),
  });
  await page.locator('[data-tool="simple"]').click();
  await page.waitForFunction(
    () => window.__fs.SIMof().built,
    {},
    { timeout: 90000 },
  );
  assert.equal(
    await page.evaluate(() => window.__fs.SIMof().qs[0].label),
    "Applicant name",
    "label correction survives offline reopening",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(external, []);
  const report = {
    passed: true,
    runtimeSource: deployedUrl ? "deployed app" : "localhost",
    testedUrl: url,
    questions: 57,
    textFields: 54,
    circularOptions: 6,
    radioGroups: 3,
    sections: 5,
    geometryChecks: 60,
    sampleAnswersFit: true,
    uniformTenPointAnswers: uniformAnswers,
    smallestAnswerPt: Math.min(...layouts.map((l) => l.size)),
    largestAnswerPt: Math.max(...layouts.map((l) => l.size)),
    glyphBoundsVerified: true,
    exportedTypographyVerified: true,
    manualResizeAndUndo: true,
    signaturePlacement: true,
    nativeWidgetsPreserved: true,
    flattenedPdfReferencesValid: true,
    fieldCorrectionsPersist: true,
    manualMovementReleasesBounds: true,
    offlineRescan: true,
    uploadToQuestionsMs: detectionMs,
    detectedPageHeapMiB: detected.heap
      ? Math.round(detected.heap / 1048576)
      : null,
    externalRequests: external,
    errors,
    warnings,
    coverage,
    scope:
      "Measured on test host, not a 4 GB device. Page JS heap excludes worker/WASM/browser memory. Truth geometry is used only by Node assertions; never loaded by the application.",
  };
  await writeFile(
    path.join(out, "local-test-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ ...report, coverage: undefined }, null, 2));
} finally {
  await browser.close();
  server?.close();
}
