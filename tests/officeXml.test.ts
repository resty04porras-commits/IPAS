import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  setInlineStringInSheet, setRichHeaderStringInSheet, setNumberInSheet,
  setCellStyleInSheet, setRowHeightInSheet, removeMergeRangesInSheet,
  setXfAlignmentAttributes, setFormulaCachedValue, replaceDrawingTextBox,
} from "../services/officeXml.js";
import { readZipEntries, updateZipEntry, writeZipEntries } from "../services/zipArchive.js";

const sheet = '<worksheet><sheetData><row r="1" ht="12" customHeight="1"><c r="A1" s="2" t="str"><v>old</v></c><c r="C1"><v>9</v></c><c r="AA1"/></row><row r="2"><c r="A2"><f>SUM(A1:C1)</f><v>100</v></c></row></sheetData></worksheet>';

test("inline strings escape XML text and preserve meaningful leading and trailing spaces", () => {
  const result = setInlineStringInSheet(sheet, "A1", ' R&D <Field> "quoted" ');
  assert.ok(result.includes('xml:space="preserve"> R&amp;D &lt;Field&gt; "quoted" </t>'));
  assert.ok(result.includes('s="2"'));
  assert.ok(result.includes('<c r="C1"><v>9</v></c>'));
});

test("formula-like inline text remains literal text rather than a worksheet formula", () => {
  const result = setInlineStringInSheet(sheet, "A1", "=SUM(1,2)");
  assert.ok(result.includes('<t>=SUM(1,2)</t>'));
  assert.ok(result.includes('t="inlineStr"'));
});

test("empty and whitespace-only strings clear the old value and retain cell styling", () => {
  for (const value of ["", "   "]) {
    const result = setInlineStringInSheet(sheet, "A1", value);
    assert.ok(result.includes('<c r="A1" s="2"/>'));
    assert.ok(result.includes('<c r="C1"><v>9</v></c>'));
    assert.equal(result.includes('<v>old</v>'), false);
  }
});

test("rich headers retain escaped labels, values and an empty-value label", () => {
  const result = setRichHeaderStringInSheet(sheet, "A1", "Name & Unit", "<Engineering>");
  assert.ok(result.includes('Name &amp; Unit: '));
  assert.ok(result.includes('&lt;Engineering&gt;'));
  assert.ok(setRichHeaderStringInSheet(sheet, "A1", "Name", "").includes('Name: </t>'));
});

test("new cells are inserted in spreadsheet column order, including multi-letter columns", () => {
  const result = setNumberInSheet(sheet, "Z1", 25);
  assert.ok(result.indexOf('r="C1"') < result.indexOf('r="Z1"'));
  assert.ok(result.indexOf('r="Z1"') < result.indexOf('r="AA1"'));
  const earlier = setInlineStringInSheet(sheet, "B1", "inserted");
  assert.ok(earlier.indexOf('r="A1"') < earlier.indexOf('r="B1"'));
  assert.ok(earlier.indexOf('r="B1"') < earlier.indexOf('r="C1"'));
});

test("a final self-closing cell can receive a number while previous cells remain intact", () => {
  const result = setNumberInSheet(sheet, "AA1", 2500.5);
  assert.ok(result.includes('<c r="AA1"><v>2500.5</v></c>'));
  assert.ok(result.includes('<c r="C1"><v>9</v></c>'));
});

test("number cells retain zero, negative values and decimals and clear non-finite input", () => {
  for (const value of [0, -25.75, 2500.5]) {
    const result = setNumberInSheet(sheet, "A1", value);
    assert.ok(result.includes(`<v>${value}</v>`));
    assert.equal(result.includes('t="str"'), false);
  }
  for (const value of [null, NaN, Infinity]) {
    assert.ok(setNumberInSheet(sheet, "A1", value).includes('<c r="A1" s="2"/>'));
  }
});

test("cell style changes retain values and leave absent cells untouched", () => {
  const result = setCellStyleInSheet(sheet, "A1", 159);
  assert.ok(result.includes('<c r="A1" s="159" t="str"><v>old</v></c>'));
  assert.ok(setCellStyleInSheet(sheet, "C1", 91).includes('<c s="91" r="C1"><v>9</v></c>'));
  assert.equal(setCellStyleInSheet(sheet, "B1", 91), sheet);
});

test("row height replaces prior height flags, retains other attributes and keeps existing rounding", () => {
  const result = setRowHeightInSheet(sheet, 1, 15.555);
  assert.ok(result.includes('<row r="1" ht="15.55" customHeight="1">'));
  assert.equal((result.match(/customHeight=/g) || []).length, 1);
  assert.ok(setRowHeightInSheet(sheet, 1, 13).includes('ht="13"'));
  assert.equal(setRowHeightInSheet(sheet, 99, 15), sheet);
});

test("merge removal updates its count, preserves other ranges and removes an empty merge section", () => {
  const xml = sheet.replace('</worksheet>', '<mergeCells count="2"><mergeCell ref="J59:K59"/><mergeCell ref="A1:B1"/></mergeCells></worksheet>');
  const result = removeMergeRangesInSheet(xml, ["J59:K59"]);
  assert.ok(result.includes('<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>'));
  assert.equal(removeMergeRangesInSheet(xml, ["J59:K59", "A1:B1"]).includes('<mergeCells'), false);
  assert.equal(removeMergeRangesInSheet(xml, []), xml);
  assert.equal(removeMergeRangesInSheet(sheet, ["J59:K59"]), sheet);
});

test("alignment updates selected style indices and preserves the other style definitions", () => {
  const styles = '<styleSheet><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="4" applyAlignment="0"><alignment horizontal="left" wrapText="1"/></xf><xf numFmtId="14"/></cellXfs></styleSheet>';
  const result = setXfAlignmentAttributes(styles, [1], { horizontal: "right", vertical: "center", wrapText: "0" });
  assert.ok(result.includes('<xf numFmtId="0"/>'));
  assert.ok(result.includes('<xf numFmtId="14"/>'));
  assert.ok(result.includes('applyAlignment="1"'));
  assert.ok(result.includes('<alignment horizontal="right" wrapText="0" vertical="center"/>'));
});

test("alignment can be added to a self-closing style or updated in a paired alignment element", () => {
  const styles = '<styleSheet><cellXfs count="2"><xf numFmtId="4"/><xf><alignment horizontal="left"></alignment></xf></cellXfs></styleSheet>';
  const result = setXfAlignmentAttributes(styles, [0, 1], { horizontal: "center" });
  assert.ok(result.includes('<xf applyAlignment="1" numFmtId="4"><alignment horizontal="center"/></xf>'));
  assert.ok(result.includes('<alignment horizontal="center"></alignment>'));
  assert.equal(setXfAlignmentAttributes('<styleSheet/>', [0], { horizontal: "center" }), '<styleSheet/>');
  assert.equal(setXfAlignmentAttributes(styles, [99], { horizontal: "center" }), styles);
});

test("formula cached values retain the existing formula and use the corresponding value type", () => {
  assert.ok(setFormulaCachedValue(sheet, "A2", 3670.75).includes('<f>SUM(A1:C1)</f><v>3670.75</v>'));
  const text = setFormulaCachedValue(sheet, "A2", "R&D <review>");
  assert.ok(text.includes('t="str"'));
  assert.ok(text.includes('<f>SUM(A1:C1)</f><v>R&amp;D &lt;review&gt;</v>'));
});

test("cached-value updates insert a missing cell into an existing row", () => {
  assert.ok(setFormulaCachedValue(sheet, "B1", 123.45).includes('<c r="B1"><v>123.45</v></c>'));
  assert.ok(setFormulaCachedValue(sheet, "B1", "Pending").includes('<t>Pending</t>'));
});

test("missing rows remain unchanged and invalid cell references retain the existing explicit error", () => {
  for (const update of [() => setInlineStringInSheet(sheet, "A99", "new"), () => setNumberInSheet(sheet, "A99", 1),
    () => setCellStyleInSheet(sheet, "A99", 3), () => setFormulaCachedValue(sheet, "A99", 5)]) {
    assert.equal(update(), sheet);
  }
  for (const address of ["a1", "1A", "A", "A-1"]) {
    assert.throws(() => setNumberInSheet(sheet, address, 1), /Invalid cell reference/);
  }
});

test("drawing text changes only the named text box and retains body and list properties", () => {
  const target = '<xdr:oneCellAnchor><xdr:cNvPr name="TextBox &quot;A&quot; &amp; B"/><xdr:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p>old target</a:p></xdr:txBody></xdr:oneCellAnchor>';
  const other = '<xdr:oneCellAnchor><xdr:cNvPr name="Other"/><xdr:txBody><a:bodyPr/><a:lstStyle/><a:p>unchanged</a:p></xdr:txBody></xdr:oneCellAnchor>';
  const result = replaceDrawingTextBox(target + other, 'TextBox "A" & B', [{ text: "Prepared & Reviewed <Ops>", bold: true, underline: true }, { text: "" }]);
  assert.ok(result.includes(other));
  assert.ok(result.includes('<a:bodyPr wrap="square"/>'));
  assert.ok(result.includes('<a:lstStyle/>'));
  assert.ok(result.includes('b="1" u="sng"'));
  assert.ok(result.includes('Prepared &amp; Reviewed &lt;Ops&gt;'));
  assert.equal(result.includes('old target'), false);
});

test("drawing updates retain missing-target behavior and supply existing defaults when properties are absent", () => {
  const xml = '<xdr:oneCellAnchor><xdr:cNvPr name="Target"/><xdr:txBody><a:p>old</a:p></xdr:txBody></xdr:oneCellAnchor>';
  const result = replaceDrawingTextBox(xml, "Target", [{ text: "New text" }]);
  assert.ok(result.includes('<a:noAutofit/>'));
  assert.ok(result.includes('<a:lstStyle/>'));
  assert.equal(replaceDrawingTextBox(xml, "Missing", [{ text: "New" }]), xml);
  const noBody = '<xdr:oneCellAnchor><xdr:cNvPr name="Target"/></xdr:oneCellAnchor>';
  assert.equal(replaceDrawingTextBox(noBody, "Target", [{ text: "New" }]), noBody);
});

test("real XLSX parsing retains edited cell text, numeric values and cached formulas after XML updates", () => {
  const book = XLSX.utils.book_new();
  const data = XLSX.utils.aoa_to_sheet([["Name", "Serial", "Amount"], ["Old", "MMT1LSS00983607E9B4220", 2500.5], ["Total", "", 0]]);
  data.C3 = { t: "n", f: "SUM(C2:C2)", v: 2500.5 };
  XLSX.utils.book_append_sheet(book, data, "Receipts");
  const entries = readZipEntries(XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true }));
  const edited = updateZipEntry(entries, "xl/worksheets/sheet1.xml", (bytes) => {
    let xml = setInlineStringInSheet(bytes.toString(), "A2", "R&D <Engineering>");
    xml = setNumberInSheet(xml, "C2", 3000.75);
    xml = setFormulaCachedValue(xml, "C3", 3000.75);
    return Buffer.from(xml);
  });
  const result = XLSX.read(writeZipEntries(edited), { type: "buffer", cellFormula: true }).Sheets.Receipts;
  assert.equal(result.A2.v, "R&D <Engineering>");
  assert.equal(result.B2.v, "MMT1LSS00983607E9B4220");
  assert.equal(result.C2.v, 3000.75);
  assert.equal(result.C3.f, "SUM(C2:C2)");
  assert.equal(result.C3.v, 3000.75);
});
