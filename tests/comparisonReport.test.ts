import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { buildComparisonReportRow, buildComparisonReportRows, generateComparisonReportExport, validateComparisonReportResults } from "../services/comparisonReport.js";
import { compareExtractedRecords, normalizeExtractedRecord, type CompareResult } from "../services/comparison.js";
import { extractZipEntryBuffer } from "../services/zipArchive.js";
import type { AccountabilityControllerDependencies } from "../controllers/accountabilityController.js";

const record = (change = {}) => normalizeExtractedRecord({ components:"MONITOR",description:"ACER K222HQL",hardwareId:"MTR-2024-001",serial:"00000O0I1L1",...change });
function result(doc = record(), img = record()): CompareResult { return compareExtractedRecords([doc],[img])[0]; }
const blank = () => normalizeExtractedRecord(undefined);

test("matching equipment produces one five-column row with exactly Match in Remarks", () => {
  assert.deepEqual(buildComparisonReportRow(result()),{components:"MONITOR",description:"ACER K222HQL",hardwareId:"MTR-2024-001",serial:"00000O0I1L1",remarks:"Match"});
});
test("PDF values remain in primary columns and the actual image difference is named", () => {
  const row = buildComparisonReportRow(result(record(),record({serial:"OTHER-SERIAL"})));
  assert.equal(row.serial,"00000O0I1L1"); assert.equal(row.remarks,'Serial number mismatch: PDF "00000O0I1L1"; image "OTHER-SERIAL".');
});
test("optional image-oriented rows preserve unread fields as blank and name the PDF counterpart", () => {
  const row = buildComparisonReportRow(result(record(),record({serial:""})),"image");
  assert.equal(row.serial,""); assert.equal(row.remarks,'Serial number not readable in the image. PDF: "00000O0I1L1".');
});
test("wholly missing image evidence does not accuse staff of losing the equipment", () => {
  const row = buildComparisonReportRow(result(record(),blank()));
  assert.match(row.remarks,/Missing image evidence/); assert.match(row.remarks,/MTR-2024-001/); assert.match(row.remarks,/00000O0I1L1/); assert.doesNotMatch(row.remarks,/equipment is missing|lost/i); assert.equal(row.hardwareId,"MTR-2024-001");
});
test("a missing field and a differing field have precise separate English findings", () => {
  const row = buildComparisonReportRow(result(record(),record({hardwareId:"",description:"DELL P2419H"})));
  assert.match(row.remarks,/Description mismatch: PDF "ACER K222HQL"; image "DELL P2419H"/); assert.match(row.remarks,/Hardware ID not readable in the image/); assert.doesNotMatch(row.remarks,/Serial number|Component/);
});
test("a new image-only field is identified as absent from the PDF", () => {
  const row = buildComparisonReportRow(result(record({serial:""}),record())); assert.equal(row.serial,""); assert.match(row.remarks,/Serial number not listed in the PDF\. Image: "00000O0I1L1"/);
});
test("unassigned evidence stays visible without asserting that its asset is unregistered", () => {
  const row = buildComparisonReportRow(result(blank(),record())); assert.equal(row.components,"MONITOR"); assert.equal(row.serial,"00000O0I1L1"); assert.match(row.remarks,/No matching PDF record identified/); assert.doesNotMatch(row.remarks,/unregistered/i);
});
test("ambiguous same-model evidence requests identifier verification", () => {
  const value = {...result(blank(),record()),notes:"This photo could belong to more than one document row."}; assert.match(buildComparisonReportRow(value).remarks,/Multiple possible PDF records/);
});
test("conflicting serial candidates are retained in Remarks rather than misreported as unreadable", () => {
  const value = result(record(),record({serial:""})); value.fieldNotes!.serial = 'Conflicting photo serial: "FIRST001", "SECOND002". The field was left blank for review.';
  const row = buildComparisonReportRow(value); assert.match(row.remarks,/Conflicting serial number values/); assert.match(row.remarks,/FIRST001.*SECOND002/); assert.doesNotMatch(row.remarks,/not readable/);
});
test("crossed hardware/serial associations retain their explicit review warning", () => {
  const value = {...result(),notes:"The visible hardware ID and serial point to different document rows; verify the labels."}; assert.match(buildComparisonReportRow(value).remarks,/different PDF records/); assert.notEqual(buildComparisonReportRow(value).remarks,"Match");
});
test("matches are included and two monitors keep two rows without deduplication", () => {
  const rows = buildComparisonReportRows([result(),result(record({hardwareId:"MTR-2024-002"}),record({hardwareId:"MTR-2024-002"}))]); assert.equal(rows.length,2); assert.deepEqual(rows.map(row=>row.remarks),["Match","Match"]); assert.notEqual(rows[0].hardwareId,rows[1].hardwareId);
});
test("identifier punctuation, leading zeros and OCR-confusable characters are preserved", () => {
  const row = buildComparisonReportRow(result(record({serial:"00O1I-L5S"}),record({serial:"00011-L55"}))); assert.equal(row.serial,"00O1I-L5S"); assert.match(row.remarks,/00011-L55/); assert.notEqual(row.remarks,"Match");
});
test("report generation leaves frozen comparison results unchanged", () => {
  const value = result(), before = JSON.stringify(value); Object.freeze(value.doc); Object.freeze(value.img); Object.freeze(value); buildComparisonReportRow(value); assert.equal(JSON.stringify(value),before);
});
test("export validation rejects missing rows, malformed fields and invalid status", () => {
  for (const value of [undefined,[],Array(1001).fill(result()),[{...result(),status:"unknown"}],[{...result(),doc:{...record(),serial:123}}],[{...result(),mismatchedFields:["remarks"]}],[{...result(),img:{...record(),serial:"x".repeat(5001)}}]]) assert.throws(()=>validateComparisonReportResults(value),{status:400});
});
test("Excel exports exactly the five equipment columns and includes matching rows", async () => {
  const file = await generateComparisonReportExport([result(),result(record(),blank())],"xlsx");
  const book = XLSX.read(file.buffer,{type:"buffer"}), sheet = book.Sheets[book.SheetNames[0]]; const rows = XLSX.utils.sheet_to_json(sheet,{header:1,defval:""}) as string[][];
  assert.deepEqual(rows[0],["Components","Description","Hardware ID","Serial","Remarks"]); assert.equal(rows.length,3); assert.equal(rows[1][4],"Match"); assert.equal(rows[1][3],"00000O0I1L1"); assert.equal(sheet.D2.t,"s"); assert.match(rows[2][4],/Missing image evidence/);
  assert.match(extractZipEntryBuffer(file.buffer,"xl/styles.xml")!.toString(),/borderId="1".*wrapText="1"/); assert.match(extractZipEntryBuffer(file.buffer,"xl/worksheets/sheet1.xml")!.toString(),/r="A1"[^>]*s="2"/); assert.match(extractZipEntryBuffer(file.buffer,"xl/worksheets/sheet1.xml")!.toString(),/orientation="landscape"/);
});
test("Excel values beginning with equals remain literal strings, not formulas", async () => {
  const value = record({description:'=HYPERLINK("https://invalid.example","test")'}); const file=await generateComparisonReportExport([result(value,value)],"xlsx"); const book=XLSX.read(file.buffer,{type:"buffer"}); const cell=book.Sheets[book.SheetNames[0]].B2; assert.equal(cell.t,"s"); assert.equal(cell.f,undefined); assert.equal(cell.v,value.description);
});
async function pdfText(buffer: Buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); const document = await pdfjs.getDocument({data:new Uint8Array(buffer),isEvalSupported:false,useSystemFonts:false}).promise;
  const pages: string[] = []; try { for(let i=1;i<=document.numPages;i++){const page=await document.getPage(i);const content=await page.getTextContent();pages.push(content.items.map((item:any)=>item.str || "").join(" "));} return pages; } finally { await document.destroy(); }
}
test("PDF report contains the same five-column row and professional Remarks", async () => {
  const file = await generateComparisonReportExport([result()],"pdf"), pages = await pdfText(file.buffer); assert.equal(pages.length,1); for(const text of ["Components","Description","Hardware ID","Serial","Remarks","00000O0I1L1","Match"]) assert.ok(pages[0].includes(text),text);
});
test("long reports repeat PDF headers and retain the final equipment row", async () => {
  const records = Array.from({length:40},(_,index)=>result(record({hardwareId:`MTR-2024-${index}`,serial:`SERIAL-${index}`}),record({hardwareId:`MTR-2024-${index}`,serial:`SERIAL-${index}`})));
  const pages = await pdfText((await generateComparisonReportExport(records,"pdf")).buffer); assert.ok(pages.length>1); assert.ok(pages.every(page=>page.includes("Remarks")&&page.includes("Hardware ID"))); assert.ok(pages.at(-1)!.includes("SERIAL-39"));
});
test("unsupported PDF characters fail explicitly while Excel preserves the text", async () => {
  const value = record({description:"設備"}), records = [result(value,value)]; await assert.rejects(generateComparisonReportExport(records,"pdf"),{status:400}); const book=XLSX.read((await generateComparisonReportExport(records,"xlsx")).buffer,{type:"buffer"}); assert.equal(book.Sheets[book.SheetNames[0]].B2.v,"設備");
});

Object.assign(process.env,{DB_HOST:"127.0.0.1",DB_PORT:"1",DB_NAME:"unused_report_test",DB_USER:"fixture",DB_PASSWORD:"fixture"});
const {createAccountabilityController} = await import("../controllers/accountabilityController.js");
const {createAccountabilityRoutes} = await import("../routes/accountabilityRoutes.js");
const {db} = await import("../database/postgres.js"); after(()=>db.end());
test("comparison export API accepts matches, returns downloadable files and rejects malformed input without other dependencies", async () => {
  const dependencies = new Proxy({},{get(_target,key){return()=>{throw new Error("Unexpected dependency "+String(key));};}}) as AccountabilityControllerDependencies;
  const app=express();app.use(express.json());app.use('/api',createAccountabilityRoutes(createAccountabilityController(dependencies)));const server=app.listen(0,"127.0.0.1");await once(server,"listening");const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for(const format of ["xlsx","pdf"]){const response=await fetch(base+"/api/compare/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({results:[result()],format})});assert.equal(response.status,200);assert.match(response.headers.get("Content-Disposition")!,new RegExp(`comparison-results\\.${format}`));assert.ok((await response.arrayBuffer()).byteLength>100);}
    for(const body of [{results:[],format:"xlsx"},{results:[result()],format:"csv"}]){const response=await fetch(base+"/api/compare/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});assert.equal(response.status,400);assert.ok((await response.json()).error);}
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
