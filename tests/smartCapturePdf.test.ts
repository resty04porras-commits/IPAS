import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PDFDocument, PDFArray, PDFRawStream, PDFName, PDFDict, decodePDFRawStream } from "pdf-lib";
import { drawPdfText, wrapPdfText, generateOfficialSmartCapturePdfExport, generateSmartCapturePdfExport } from "../services/smartCapturePdf.js";
import { writeZipEntries } from "../services/zipArchive.js";
import type { AccountabilityFormPayload, IntakeRecord } from "../types/accountability.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const item = (number = 1): IntakeRecord => ({ sourceName: "monitor.jpg", components: `ASSET${String(number).padStart(2, "0")}`,
  description: "ACER K222HQL", hardwareId: "MTR-2021-044", serial: "MMT1LSS00983607E9B4220", remarks: "Working" });
const payload = (fields: Partial<AccountabilityFormPayload> = {}): AccountabilityFormPayload => ({
  employeeName: "IPAS Verification", employeeId: "EMP-123", designation: "Engineer", department: "IICTD",
  effectiveDate: "2026-10-22", signature: "Printed Signature", processedBy: "Processor", processedDate: "2026-10-22",
  checkedBy: "Checker", checkedDate: "2026-10-21", verifiedBy: "Verifier", verifiedTitle: "Administrator",
  verifiedDate: "2026-10-20", notedBy: "Noter", notedTitle: "Department Head", notedDate: "2026-10-19",
  items: [item()], ...fields,
});

async function inTemporaryFolder(run: (templatePath: string) => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ipas-smart-capture-pdf-test-"));
  const templatePath = path.join(directory, "public", "forms", "accountability-form-template.xlsx");
  try {
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    process.chdir(directory);
    await run(templatePath);
  } finally {
    process.chdir(previous);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function inspect(bytes: Buffer) {
  const pdf = await PDFDocument.load(bytes);
  const page = pdf.getPage(0);
  const contents = page.node.Contents();
  const references = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const drawing = Buffer.concat(references.map((reference) => {
    const stream = pdf.context.lookup(reference);
    assert.ok(stream instanceof PDFRawStream);
    return Buffer.from(decodePDFRawStream(stream).decode());
  })).toString();
  const resources = page.node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
  const images = (resources?.entries() || []).map(([, reference]) => pdf.context.lookup(reference))
    .filter((object) => object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image");
  return { pdf, drawing, images, has: (text: string) => drawing.toLowerCase().includes(Buffer.from(text).toString("hex")) };
}
const render = async (fields: Partial<AccountabilityFormPayload> = {}) => inspect(await generateOfficialSmartCapturePdfExport(payload(fields)));

test("text wrapping preserves empty input, whitespace normalization and unbroken identifiers", () => {
  const font = { widthOfTextAtSize: (text: string) => text.length };
  assert.deepEqual(wrapPdfText("", font, 1, 5), [""]);
  assert.deepEqual(wrapPdfText("  one\n two   three  ", font, 1, 7), ["one two", "three"]);
  assert.deepEqual(wrapPdfText("MMT1LSS00983607E9B4220 next", font, 1, 5), ["MMT1LSS00983607E9B4220", "next"]);
});

test("shared text drawing returns the final line position for downstream layout", () => {
  const calls: Array<{ text: string; y: number }> = [];
  const page = { drawText: (text: string, options: { y: number }) => calls.push({ text, y: options.y }) };
  const font = { widthOfTextAtSize: (text: string) => text.length };
  assert.equal(drawPdfText(page, "one two three", 10, 100, { font, size: 5, maxWidth: 7, lineHeight: 9 }), 91);
  assert.deepEqual(calls, [{ text: "one two", y: 100 }, { text: "three", y: 91 }]);
});

test("official export produces a Letter PDF and the fallback header when the workbook is absent", async () => inTemporaryFolder(async () => {
  const result = await render();
  assert.equal(result.pdf.getPageCount(), 1);
  assert.deepEqual(result.pdf.getPage(0).getSize(), { width: 612, height: 792 });
  assert.equal(result.images.length, 0);
  assert.ok(result.has("LifeBank")); assert.ok(result.has("EQUIPMENT ACCOUNTABILITY FORM"));
}));

test("employee information, exact asset identifiers and acknowledgements survive PDF export", async () => inTemporaryFolder(async () => {
  const result = await render();
  for (const text of ["IPAS Verification", "EMP-123", "Engineer", "IICTD", "ASSET01", "ACER K222HQL",
    "MTR-2021-044", "MMT1LSS00983607E9B4220", "Working", "ACKNOWLEDGEMENT"]) assert.ok(result.has(text), text);
}));

test("all signatories, titles and UTC dates remain in the PDF", async () => inTemporaryFolder(async () => {
  const result = await render();
  for (const text of ["Processor", "Checker", "Verifier", "Administrator", "Noter", "Department Head",
    "October 22, 2026", "October 21, 2026", "October 20, 2026", "October 19, 2026"]) assert.ok(result.has(text), text);
}));

test("blank dates and non-date text retain the existing rendering behavior", async () => inTemporaryFolder(async () => {
  const result = await render({ effectiveDate: "Pending", processedDate: "", checkedDate: "", verifiedDate: "", notedDate: "" });
  assert.ok(result.has("Pending")); assert.equal(result.has("Invalid Date"), false);
}));

test("the official table retains its existing 24-row limit", async () => inTemporaryFolder(async () => {
  const result = await render({ items: Array.from({ length: 25 }, (_, index) => item(index + 1)) });
  assert.ok(result.has("ASSET01")); assert.ok(result.has("ASSET24"));
  assert.equal(result.has("ASSET25"), false); assert.equal(result.pdf.getPageCount(), 1);
}));

test("empty item lists and wrapped remarks still produce readable drawing streams", async () => inTemporaryFolder(async () => {
  const empty = await render({ items: [] }); assert.ok(empty.has("ACKNOWLEDGEMENT"));
  const long = await render({ items: [{ ...item(), remarks: "Needs additional review of the attached asset label and condition" }] });
  assert.equal(/NaN|Infinity/.test(long.drawing), false);
  assert.ok(long.has("Needs additional")); assert.ok(long.has("ACKNOWLEDGEMENT"));
}));

test("header PNG is read from the workbook and the template bytes are left intact", async () => inTemporaryFolder(async (location) => {
  const template = writeZipEntries([{ name: "xl/media/image1.png", data: png }]);
  fs.writeFileSync(location, template);
  const result = await render();
  assert.equal(result.images.length, 1); assert.equal(result.has("LifeBank"), false);
  assert.deepEqual(fs.readFileSync(location), template);
}));

test("corrupt workbook and corrupt embedded logo both retain the fallback header", async () => inTemporaryFolder(async (location) => {
  for (const bytes of [Buffer.from("not a workbook"), writeZipEntries([{ name: "xl/media/image1.png", data: Buffer.from("not a PNG") }])]) {
    fs.writeFileSync(location, bytes);
    const result = await render(); assert.ok(result.has("LifeBank")); assert.equal(result.images.length, 0);
  }
}));

test("valid signature PNG is embedded while invalid signature input is tolerated", async () => inTemporaryFolder(async () => {
  const signed = await render({ signatureDataUrl: `data:image/png;base64,${png.toString("base64")}` });
  assert.equal(signed.images.length, 1); assert.ok(signed.has("Processor"));
  for (const signatureDataUrl of ["invalid", "data:image/png;base64,bm90IGEgcG5n"]) {
    const result = await render({ signatureDataUrl }); assert.equal(result.images.length, 0); assert.ok(result.has("Processor"));
  }
}));

test("rendering leaves the caller payload unchanged", async () => inTemporaryFolder(async () => {
  const input = payload(); const before = JSON.stringify(input);
  await generateOfficialSmartCapturePdfExport(input);
  assert.equal(JSON.stringify(input), before);
}));

test("alternate renderer keeps its portrait dimensions, 12-row limit and printed signature", async () => inTemporaryFolder(async () => {
  const result = await inspect(await generateSmartCapturePdfExport(payload({ items: Array.from({ length: 13 }, (_, index) => item(index + 1)) })));
  assert.deepEqual(result.pdf.getPage(0).getSize(), { width: 595, height: 842 });
  assert.ok(result.has("ASSET12")); assert.equal(result.has("ASSET13"), false);
  assert.ok(result.has("Printed Signature")); assert.ok(result.has("Form Details"));
}));

test("alternate renderer preserves embedded signatures and the invalid-image text fallback", async () => inTemporaryFolder(async () => {
  const valid = await inspect(await generateSmartCapturePdfExport(payload({ signatureDataUrl: `data:image/png;base64,${png.toString("base64")}` })));
  assert.equal(valid.images.length, 1);
  const invalid = await inspect(await generateSmartCapturePdfExport(payload({ signatureDataUrl: "data:image/png;base64,bm90IGEgcG5n" })));
  assert.equal(invalid.images.length, 0); assert.ok(invalid.has("Printed Signature"));
}));
