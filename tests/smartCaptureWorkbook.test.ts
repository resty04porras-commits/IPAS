import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { generateSmartCaptureExcelExport } from "../services/smartCaptureWorkbook.js";
import type { AccountabilityFormPayload, IntakeRecord } from "../types/accountability.js";

const item = (number = 1): IntakeRecord => ({ sourceName: "monitor.jpg", components: `MONITOR ${number}`,
  description: "ACER K222HQL", hardwareId: "MTR-2021-044", serial: "MMT1LSS00983607E9B4220", remarks: "Working", notes: "Internal OCR note" });
const payload = (fields: Partial<AccountabilityFormPayload> = {}): AccountabilityFormPayload => ({
  employeeName: "IPAS Verification", employeeId: "EMP-123", designation: "Engineer", department: "IICTD",
  effectiveDate: "2026-10-22", signature: "Printed Signature", processedBy: "Processor", processedDate: "2026-10-22",
  checkedBy: "Checker", checkedDate: "2026-10-21", verifiedBy: "Verifier", verifiedTitle: "Administrator",
  verifiedDate: "2026-10-20", notedBy: "Noter", notedTitle: "Department Head", notedDate: "2026-10-19",
  items: [item()], ...fields,
});

function read(fields: Partial<AccountabilityFormPayload> = {}) {
  const bytes = generateSmartCaptureExcelExport(payload(fields));
  const book = XLSX.read(bytes, { type: "buffer", cellStyles: true, cellFormula: true });
  const sheet = book.Sheets[book.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", raw: true });
  return { bytes, book, sheet, rows };
}

test("export produces a readable XLSX with the existing sheet name and section headings", () => {
  const { bytes, book, sheet, rows } = read();
  assert.equal(bytes.subarray(0, 2).toString(), "PK");
  assert.deepEqual(book.SheetNames, ["Smart Capture"]);
  assert.equal(sheet.A1.v, "Smart Capture Workflow");
  assert.equal(sheet.A3.v, "Equipment Details");
  assert.deepEqual(rows[3], ["Components", "Description", "Hardware ID", "Serial", "Remarks"]);
  assert.ok(rows.some((row) => row[0] === "Form Details"));
});

test("asset rows retain field values and order without exporting private source names or OCR notes", () => {
  const second = { ...item(2), serial: "SECOND-SERIAL", hardwareId: "SECOND-TAG", remarks: "For review" };
  const { rows } = read({ items: [item(), second] });
  assert.deepEqual(rows[4], ["MONITOR 1", "ACER K222HQL", "MTR-2021-044", "MMT1LSS00983607E9B4220", "Working"]);
  assert.deepEqual(rows[5], ["MONITOR 2", "ACER K222HQL", "SECOND-TAG", "SECOND-SERIAL", "For review"]);
  assert.equal(rows.flat().includes("monitor.jpg"), false);
  assert.equal(rows.flat().includes("Internal OCR note"), false);
});

test("all employee, date and signatory fields retain their current labels and unformatted values", () => {
  const { rows } = read({ effectiveDate: "Pending", processedDate: "2026-10-22T23:00:00-05:00" });
  const start = rows.findIndex((row) => row[0] === "Form Details");
  assert.deepEqual(rows.slice(start + 1, start + 9).map((row) => row.slice(0, 4)), [
    ["Name", "IPAS Verification", "ID No.", "EMP-123"],
    ["Designation", "Engineer", "Department", "IICTD"],
    ["Effective Date", "Pending", "Processed By", "Processor"],
    ["Processed Date", "2026-10-22T23:00:00-05:00", "Checked By", "Checker"],
    ["Checked Date", "2026-10-21", "Verified By", "Verifier"],
    ["Verified Title", "Administrator", "Verified Date", "2026-10-20"],
    ["Noted By", "Noter", "Noted Title", "Department Head"],
    ["Noted Date", "2026-10-19", "", ""],
  ]);
});

test("leading zeros, formula-looking strings, Unicode and XML-sensitive text remain literal text", () => {
  const { sheet, rows } = read({ employeeName: "R&D <Engineering> \"Office\"", items: [{ ...item(),
    hardwareId: "00001234", serial: "0012345678901234567890", description: "=SUM(1,2)", remarks: "Niño & R&D <review>\nSecond line" }] });
  for (const [cell, value] of [["B5", "=SUM(1,2)"], ["C5", "00001234"], ["D5", "0012345678901234567890"],
    ["E5", "Niño & R&D <review>\nSecond line"]]) {
    assert.equal(sheet[cell]?.v, value, cell); assert.equal(sheet[cell]?.t, "s", cell); assert.equal(sheet[cell]?.f, undefined, cell);
  }
  assert.ok(rows.some((row) => row[1] === 'R&D <Engineering> "Office"'));
});

test("Excel retains every supplied asset row without the PDF table's row limit", () => {
  const items = Array.from({ length: 40 }, (_, index) => item(index + 1));
  const { rows } = read({ items });
  assert.deepEqual(rows.slice(4, 44).map((row) => row[0]), items.map((entry) => entry.components));
  assert.ok(rows.some((row) => row[0] === "Form Details"));
});

test("signature export retains its Attached marker or printed text without storing image data", () => {
  const signatureDataUrl = "data:image/png;base64,c2lnbmF0dXJl";
  for (const [fields, expected] of [
    [{ signatureDataUrl }, "Attached"], [{ signature: "Printed Signature", signatureDataUrl: "" }, "Printed Signature"],
    [{ signature: "", signatureDataUrl: undefined }, ""],
  ] as Array<[Partial<AccountabilityFormPayload>, string]>) {
    const { rows } = read(fields);
    const row = rows.find((entry) => entry[0] === "Processed Signature");
    assert.equal(row?.[1], expected); assert.equal(rows.flat().includes(signatureDataUrl), false);
  }
});

test("empty assets and blank form fields still produce a workbook without adding validation", () => {
  const blank = Object.fromEntries(Object.keys(payload()).filter((key) => key !== "items").map((key) => [key, ""]));
  const { rows, sheet } = read({ ...blank, items: [] });
  assert.equal(sheet.A4.v, "Components");
  assert.ok(rows.some((row) => row[0] === "Form Details"));
  assert.equal(rows.find((row) => row[0] === "Name")?.[1], "");
  assert.equal(rows.find((row) => row[0] === "Processed Signature")?.[1], "");
});

test("export does not mutate frozen input or share asset rows between independent workbooks", () => {
  const input = payload(); const previous = JSON.stringify(input);
  input.items.forEach(Object.freeze); Object.freeze(input.items); Object.freeze(input);
  const first = XLSX.read(generateSmartCaptureExcelExport(input), { type: "buffer" });
  const next = read({ items: [{ ...item(), serial: "NEW-SERIAL" }] });
  assert.equal(JSON.stringify(input), previous);
  assert.equal(first.Sheets["Smart Capture"].D5.v, "MMT1LSS00983607E9B4220");
  assert.equal(next.sheet.D5.v, "NEW-SERIAL");
});

test("the five readable column widths survive workbook serialization", () => {
  const { sheet } = read();
  const columns = sheet["!cols"] || [];
  assert.equal(columns.length, 5);
  [24, 30, 22, 24, 30].forEach((width, index) => assert.ok(Math.abs((columns[index].wch || 0) - width) < 0.1));
});
