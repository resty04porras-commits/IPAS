import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  getLiquidationReferenceExcelPath, formatLiquidationTableDate,
  normalizeLiquidationTableTime, generateLiquidationExcelExport,
} from "../services/liquidationWorkbook.js";
import { normalizeLiquidationRecord, sanitizeLiquidationPayload, type LiquidationFormPayload } from "../services/liquidationRecords.js";
import { readZipEntries, writeZipEntries, updateZipEntry } from "../services/zipArchive.js";

// A self-contained workbook fixture: four independently written XLSX sheets,
// enough valid style definitions for the existing form, and named drawing text.
// Actual public templates are compared separately in the compiled-app checks.
function makeTemplate(): Buffer {
  const book = XLSX.utils.book_new();
  for (const name of ["Reference", "Notes", "History"]) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Keep reference values"], [name]]), name);
  }
  const data = XLSX.utils.aoa_to_sheet(Array.from({ length: 61 }, () => Array.from({ length: 12 }, () => "")));
  for (const column of ["F", "G", "H", "I", "J"]) {
    data[`${column}57`] = { t: "n", f: `SUM(${column}13:${column}56)`, v: 0 };
  }
  data["!merges"] = [58, 59, 60].map((row) => ({ s: { r: row, c: 9 }, e: { r: row, c: 10 } }));
  XLSX.utils.book_append_sheet(book, data, "Liquidation");
  let entries = readZipEntries(XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true }));
  entries = updateZipEntry(entries, "xl/styles.xml", (bytes) => {
    const styles = bytes.toString();
    const section = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
    const first = section?.[1].match(/<xf\b[^>]*\/>/)?.[0];
    assert.ok(section && first, "Independent fixture needs its default XLSX style");
    return Buffer.from(styles.replace(section[0], `<cellXfs count="161">${first.repeat(161)}</cellXfs>`));
  });
  const boxes = ["TextBox 1", "TextBox 4", "TextBox 6", "TextBox 7", "TextBox 8", "TextBox 13", "TextBox 14", "TextBox 16"];
  const drawing = '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' + boxes.map((name, index) =>
    `<xdr:oneCellAnchor><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="${index + 1}" name="${name}"/></xdr:nvSpPr><xdr:txBody><a:bodyPr/><a:lstStyle/><a:p>old signatory</a:p></xdr:txBody></xdr:sp></xdr:oneCellAnchor>`).join("") + '</xdr:wsDr>';
  return writeZipEntries([...entries,
    { name: "xl/drawings/drawing4.xml", data: Buffer.from(drawing) },
    { name: "xl/calcChain.xml", data: Buffer.from('<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>') },
    { name: "custom/untouched.bin", data: Buffer.from([0, 255, 128, 10]) },
  ]);
}

function withTemplate(run: (template: Buffer, location: string) => void): void {
  const previous = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ipas-liquidation-workbook-test-"));
  try {
    const template = makeTemplate();
    const location = path.join(directory, "reference_files", "liquidation_form_reference.xlsx");
    fs.mkdirSync(path.dirname(location)); fs.writeFileSync(location, template);
    process.chdir(directory);
    run(template, location);
  } finally {
    process.chdir(previous);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const payload = (fields: Partial<LiquidationFormPayload> = {}) => sanitizeLiquidationPayload({
  employeeName: "R&D <Engineering>", reportDate: "2026-10-21", designation: "Field Engineer", base: "Iloilo",
  purpose: "Site visit", cashAdvance: "4000", preparedByName: "Prepared & Checked", preparedByTitle: "FE",
  checkedByName: "Checked Person", checkedByTitle: "SFE", reviewedByName: "Reviewed Person", reviewedByTitle: "Manager",
  notedByName: "Noted Person", notedByTitle: "Head", approvedByName: "Approved Person", approvedByTitle: "Director",
  items: [normalizeLiquidationRecord({ sourceName: "bus.jpg", transactionDate: "2026-10-21", time: "8 AM to 9 AM",
    from: "ILOILO", to: "ROXAS", modeOfTransportation: "Bus", amount: "2500.50", perDiem: "500", breakfast: "50.25",
    lunch: "100", dinner: "150", others: "25", remarks: "Bus Fare" })], ...fields,
});
const readSheet = (buffer: Buffer) => XLSX.read(buffer, { type: "buffer", cellFormula: true }).Sheets.Liquidation;

test("reference workbook path keeps the current working directory and existing filename", () => withTemplate((_bytes, location) => {
  assert.equal(getLiquidationReferenceExcelPath(), location);
}));

test("date formatting retains ISO and readable date output shared by workbook and PDF callers", () => {
  for (const [input, expected] of [["2026-10-21", "21-Oct-26"], ["2026-1-2", "02-Jan-26"],
    ["2026-10-21T23:00:00-05:00", "21-Oct-26"], ["October 21, 2026", "21-Oct-26"]]) {
    assert.equal(formatLiquidationTableDate(input), expected, input);
  }
});

test("blank and unparseable dates retain their existing blank or original-text result", () => {
  assert.equal(formatLiquidationTableDate("  "), "");
  assert.equal(formatLiquidationTableDate("needs review"), "needs review");
});

test("time formatting retains existing separator and whitespace normalization", () => {
  for (const [input, expected] of [[" 8:00 AM to 9:30 AM ", "8:00 AM - 9:30 AM"], ["8 AM-9 AM", "8 AM - 9 AM"],
    ["  8   AM   TO  9 AM ", "8 AM - 9 AM"], ["", ""], ["Pending", "Pending"]]) {
    assert.equal(normalizeLiquidationTableTime(input), expected, input);
  }
});

test("real XLSX output retains headers, row fields, currency values and input objects", () => withTemplate((_bytes, location) => {
  const original = fs.readFileSync(location);
  const input = payload(); const before = JSON.stringify(input);
  const result = readSheet(generateLiquidationExcelExport(input));
  assert.equal(result.A7.v, "Name: R&D <Engineering>"); assert.equal(result.G7.v, "Date: 2026-10-21");
  assert.equal(result.A8.v, "Designation: Field Engineer"); assert.equal(result.G8.v, "Base: Iloilo");
  assert.equal(result.A9.v, "Purpose: Site visit");
  const expected = { A13: "21-Oct-26", B13: "8 AM - 9 AM", C13: "ILOILO", D13: "ROXAS", E13: "Bus",
    F13: 2500.5, G13: 500, H13: 50.25, I13: 100, J13: 150, K13: "25", L13: "Bus Fare" };
  for (const [cell, value] of Object.entries(expected)) assert.equal(result[cell]?.v, value, cell);
  assert.equal(result.F14?.v ?? "", "");
  assert.equal(JSON.stringify(input), before); assert.deepEqual(fs.readFileSync(location), original);
}));

test("expense totals retain all six input columns and existing worksheet formulas", () => withTemplate(() => {
  const input = payload();
  input.items.push(normalizeLiquidationRecord({ amount: "100", perDiem: "50", breakfast: "25", lunch: "75", dinner: "100", others: "-5" }));
  const result = readSheet(generateLiquidationExcelExport(input));
  for (const [cell, value] of Object.entries({ F57: 2600.5, G57: 550, H57: 75.25, I57: 175, J57: 250,
    L59: 3670.75, L60: 4000, L61: 329.25 })) assert.equal(result[cell]?.v, value, cell);
  assert.equal(result.F57.f, "SUM(F13:F56)");
  assert.equal(result.J61.v, "Return to CO");
}));

test("return and reimbursement amounts retain existing positive, negative and zero settlement behavior", () => withTemplate(() => {
  const items = [normalizeLiquidationRecord({ amount: "100" })];
  for (const [advance, label, amount] of [["200", "Return to CO", 100], ["50", "Reimbursement", 50], ["100", "Return to CO", 0]] as const) {
    const result = readSheet(generateLiquidationExcelExport(payload({ items, cashAdvance: advance })));
    assert.equal(result.J61.v, label); assert.equal(result.L61.v, amount);
  }
}));

test("signatory names and titles reach the named drawing text boxes with XML escaping", () => withTemplate(() => {
  const result = readZipEntries(generateLiquidationExcelExport(payload()));
  const drawing = result.find(({ name }) => name === "xl/drawings/drawing4.xml")!.data.toString();
  for (const value of ["Prepared &amp; Checked", "Checked Person", "Reviewed Person", "Noted Person", "Approved Person",
    "FE", "SFE", "Manager", "Head", "Director"]) assert.ok(drawing.includes(value), value);
  assert.equal(drawing.includes("old signatory"), false);
}));

test("unrelated workbook members remain byte-for-byte intact and calculation-chain removal is retained", () => withTemplate((template) => {
  const before = readZipEntries(template); const after = readZipEntries(generateLiquidationExcelExport(payload()));
  const changed = new Set(["xl/worksheets/sheet4.xml", "xl/styles.xml", "xl/drawings/drawing4.xml", "xl/calcChain.xml"]);
  for (const entry of before.filter(({ name }) => !changed.has(name))) {
    assert.deepEqual(after.find(({ name }) => name === entry.name)?.data, entry.data, entry.name);
  }
  assert.equal(after.some(({ name }) => name === "xl/calcChain.xml"), false);
}));

test("existing table styles, fixed row height and settlement merge removal reach the workbook", () => withTemplate(() => {
  const output = generateLiquidationExcelExport(payload()); const entries = readZipEntries(output);
  const xml = entries.find(({ name }) => name === "xl/worksheets/sheet4.xml")!.data.toString();
  assert.match(xml, /<row\b[^>]*r="13"[^>]*ht="13"[^>]*customHeight="1"/);
  assert.match(xml, /<c\b[^>]*r="F13"[^>]*s="156"|<c\b[^>]*s="156"[^>]*r="F13"/);
  assert.equal(xml.includes('ref="J59:K59"'), false);
  assert.equal(xml.includes('ref="J60:K60"'), false);
  assert.equal(xml.includes('ref="J61:K61"'), false);
  assert.ok(entries.find(({ name }) => name === "xl/styles.xml")!.data.toString().includes('shrinkToFit="1"'));
}));

test("the existing visible-row limit and totals over the complete input remain unchanged", () => withTemplate(() => {
  const items = Array.from({ length: 44 }, (_, i) => normalizeLiquidationRecord({ from: `ROW ${i + 1}`, amount: "1" }));
  const result = readSheet(generateLiquidationExcelExport(payload({ items, cashAdvance: "100" })));
  assert.equal(result.C13.v, "ROW 1"); assert.equal(result.C55.v, "ROW 43");
  assert.equal(result.C56?.v ?? "", ""); assert.equal(result.F57.v, 44);
  assert.equal(result.L59.v, 44); assert.equal(result.L61.v, 56);
}));

test("missing and invalid template files propagate their existing errors", () => withTemplate((_template, location) => {
  fs.unlinkSync(location);
  assert.throws(() => generateLiquidationExcelExport(payload()), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  fs.writeFileSync(location, "not a workbook");
  assert.throws(() => generateLiquidationExcelExport(payload()), /ZIP directory not found/);
}));
