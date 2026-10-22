import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PDFDocument, StandardFonts, PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { generateLiquidationReferencePdfExport } from "../services/liquidationPdf.js";
import { normalizeLiquidationRecord, sanitizeLiquidationPayload, type LiquidationFormPayload } from "../services/liquidationRecords.js";

async function referencePdf(sizes: Array<[number, number]> = [[612, 792]], marker = "TEMPLATE MARKER"): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [width, height] of sizes) {
    const page = pdf.addPage([width, height]);
    page.drawText(marker, { x: 10, y: height - 15, size: 7, font });
    page.drawLine({ start: { x: 10, y: 20 }, end: { x: width - 10, y: 20 }, thickness: 0.5 });
  }
  return Buffer.from(await pdf.save());
}

async function withReference(run: (bytes: Buffer, location: string) => Promise<void>, sizes?: Array<[number, number]>): Promise<void> {
  const previous = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ipas-liquidation-pdf-test-"));
  try {
    const bytes = await referencePdf(sizes);
    const location = path.join(directory, "reference_files", "liquidation_form_reference.pdf");
    fs.mkdirSync(path.dirname(location)); fs.writeFileSync(location, bytes);
    process.chdir(directory);
    await run(bytes, location);
  } finally {
    process.chdir(previous);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const payload = (fields: Partial<LiquidationFormPayload> = {}) => sanitizeLiquidationPayload({
  employeeName: "IPAS Test", reportDate: "2026-10-22", designation: "Engineer", base: "Iloilo", purpose: "Site visit",
  cashAdvance: "4000", preparedByName: "Prepared", preparedByTitle: "FE", checkedByName: "Checked", checkedByTitle: "SFE",
  reviewedByName: "Reviewed", reviewedByTitle: "Manager", notedByName: "Noted", notedByTitle: "Head",
  approvedByName: "Approved", approvedByTitle: "Director",
  items: [normalizeLiquidationRecord({ transactionDate: "2026-10-22", time: "8 AM to 9 AM", from: "ILOILO", to: "ROXAS",
    modeOfTransportation: "Bus", amount: "2500.50", perDiem: "500", breakfast: "50.25", lunch: "100", dinner: "150",
    others: "25", remarks: "Bus Fare" })], ...fields,
});

function pageDrawing(pdf: PDFDocument, index = 0): Buffer {
  const contents = pdf.getPage(index).node.Contents();
  const references = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return Buffer.concat(references.map((reference) => {
    const stream = pdf.context.lookup(reference);
    assert.ok(stream instanceof PDFRawStream);
    return Buffer.from(decodePDFRawStream(stream).decode());
  }));
}
function includesText(drawing: Buffer, value: string): boolean {
  return drawing.toString().toLowerCase().includes(Buffer.from(value, "latin1").toString("hex"));
}
async function rendered(fields: Partial<LiquidationFormPayload> = {}) {
  const buffer = await generateLiquidationReferencePdfExport(payload(fields));
  const pdf = await PDFDocument.load(buffer);
  return { buffer, pdf, drawing: pageDrawing(pdf) };
}

test("reference export produces a readable PDF with the template page dimensions and background", async () => withReference(async () => {
  const { buffer, pdf, drawing } = await rendered();
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 612, height: 792 });
  assert.ok(includesText(drawing, "TEMPLATE MARKER"));
}));

test("header and row drawing retain the shared date/time format and all expense contributions", async () => withReference(async () => {
  const { drawing } = await rendered();
  for (const text of ["IPAS Test", "Engineer", "Iloilo", "Site visit", "22-Oct-26", "8 AM - 9 AM", "ILOILO", "ROXAS",
    "Bus", "Bus Fare", "2,500.50", "500.00", "50.25", "100.00", "150.00", "3,325.75", "4,000.00", "674.25"]) {
    assert.ok(includesText(drawing, text), text);
  }
}));

test("positive, negative and zero settlements retain their existing labels and money output", async () => withReference(async () => {
  const items = [normalizeLiquidationRecord({ amount: "100" })];
  for (const [cashAdvance, label, amount] of [["200", "Return to CO", "100.00"], ["50", "Reimbursement", "50.00"],
    ["100", "Return to CO", "-"]]) {
    const { drawing } = await rendered({ items, cashAdvance });
    assert.ok(includesText(drawing, label), label); assert.ok(includesText(drawing, amount), amount);
  }
}));

test("signatory names and titles remain present in the generated drawing content", async () => withReference(async () => {
  const { drawing } = await rendered();
  for (const text of ["Prepared", "FE", "Checked", "SFE", "Reviewed", "Manager", "Noted", "Head", "Approved", "Director"]) {
    assert.ok(includesText(drawing, text), text);
  }
}));

test("long headers, route fields and remarks retain successful bounded-text rendering", async () => withReference(async () => {
  const { pdf, drawing } = await rendered({ employeeName: "Long employee name ".repeat(12), purpose: "Detailed site visit purpose ".repeat(14),
    designation: "Senior Field Engineer ".repeat(8), preparedByTitle: "Senior Field Engineer for multiple regions",
    items: [normalizeLiquidationRecord({ from: "LONG ORIGIN ".repeat(12), to: "LONG DESTINATION ".repeat(12),
      modeOfTransportation: "Intercity passenger transport", remarks: "Receipt needs additional review ".repeat(12), amount: "2500.50" })] });
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(/NaN|Infinity/.test(drawing.toString()), false);
}));

test("rendering leaves the original template bytes and caller payload unchanged", async () => withReference(async (template, location) => {
  const input = payload(); const previous = JSON.stringify(input);
  await generateLiquidationReferencePdfExport(input);
  assert.deepEqual(fs.readFileSync(location), template);
  assert.equal(JSON.stringify(input), previous);
}));

test("additional template pages retain their dimensions and original drawing bytes", async () => withReference(async (template) => {
  const original = await PDFDocument.load(template);
  const { pdf } = await rendered();
  assert.equal(pdf.getPageCount(), 2);
  assert.deepEqual(pdf.getPage(1).getSize(), { width: 300, height: 400 });
  assert.deepEqual(pageDrawing(pdf, 1), pageDrawing(original, 1));
}, [[612, 792], [300, 400]]));

test("each export reads the current reference PDF rather than reusing an earlier template", async () => withReference(async (_template, location) => {
  assert.ok(includesText((await rendered()).drawing, "TEMPLATE MARKER"));
  fs.writeFileSync(location, await referencePdf(undefined, "UPDATED TEMPLATE"));
  const { drawing } = await rendered();
  assert.ok(includesText(drawing, "UPDATED TEMPLATE"));
  assert.equal(includesText(drawing, "TEMPLATE MARKER"), false);
}));

test("the existing 43 visible-row limit and totals over all input items remain unchanged", async () => withReference(async () => {
  const items = Array.from({ length: 44 }, (_, index) => normalizeLiquidationRecord({ from: `ROW${String(index + 1).padStart(2, "0")}`, amount: "1" }));
  const { drawing } = await rendered({ items, cashAdvance: "100" });
  assert.ok(includesText(drawing, "ROW01")); assert.ok(includesText(drawing, "ROW43"));
  assert.equal(includesText(drawing, "ROW44"), false);
  assert.ok(includesText(drawing, "44.00")); assert.ok(includesText(drawing, "56.00"));
}));

test("missing and invalid reference PDF files retain their existing failures", async () => withReference(async (_template, location) => {
  fs.unlinkSync(location);
  await assert.rejects(generateLiquidationReferencePdfExport(payload()), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  fs.writeFileSync(location, "not a PDF");
  await assert.rejects(generateLiquidationReferencePdfExport(payload()), /PDF/);
}));
