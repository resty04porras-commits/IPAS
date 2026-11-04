import * as XLSX from "xlsx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { compareField, type CompareResult, type ComparisonField } from "./comparison.js";
import { readZipEntries, writeZipEntries } from "./zipArchive.js";

export type ComparisonReportRow = { components: string; description: string; hardwareId: string; serial: string; remarks: string };
export type ComparisonReportSource = "pdf" | "image";
export const COMPARISON_REPORT_SOURCE: ComparisonReportSource = "pdf";
export const COMPARISON_REPORT_HEADERS = ["Components", "Description", "Hardware ID", "Serial", "Remarks"];
const fields: ComparisonField[] = ["components", "description", "hardwareId", "serial"];
const labels: Record<ComparisonField,string> = { components: "Component", description: "Description", hardwareId: "Hardware ID", serial: "Serial number" };
const value = (input: unknown) => typeof input === "string" ? input.trim() : "";
const quote = (input: string) => JSON.stringify(input);
const hasValues = (record: any) => fields.some(field => value(record?.[field]));

/** One equipment row, with readable English findings in Remarks. Physical
 * readings and the matching outcome are never rewritten to improve the report. */
export function buildComparisonReportRow(result: CompareResult, source: ComparisonReportSource = COMPARISON_REPORT_SOURCE): ComparisonReportRow {
  const expected = result.doc || {} as any, observed = result.img || {} as any;
  const hasExpected = hasValues(expected), hasObserved = hasValues(observed);
  const primary = hasExpected && source === "pdf" ? expected : observed;
  const row: ComparisonReportRow = { components: value(primary.components), description: value(primary.description), hardwareId: value(primary.hardwareId), serial: value(primary.serial), remarks: "" };
  if (!hasExpected) {
    row.remarks = hasObserved
      ? /more than one|multiple possible/i.test(result.notes || "")
        ? "Multiple possible PDF records. Verify the Hardware ID and serial number."
        : "No matching PDF record identified. Verify the equipment identifiers."
      : "No readable equipment details. Manual verification required.";
    return row;
  }
  if (!hasObserved) {
    const identifiers = [expected.hardwareId ? "Hardware ID " + quote(expected.hardwareId) : "", expected.serial ? "serial number " + quote(expected.serial) : ""].filter(Boolean);
    row.remarks = "Missing image evidence. " + (identifiers.length ? "Verify " + identifiers.join(" and ") + " against the original photo." : "Review the original photo and equipment label.");
    if (source === "image") row.remarks += " PDF reference: " + [expected.components,expected.description].filter(Boolean).join("; ") + ".";
    return row;
  }
  const findings: string[] = [];
  for (const field of fields) {
    const doc = value(expected[field]), img = value(observed[field]);
    const note = value(result.fieldNotes?.[field]);
    if (/^Conflicting photo /i.test(note)) {
      const candidates = note.match(/"(?:\\.|[^"\\])*"/g) || [];
      findings.push(`Conflicting ${labels[field].toLowerCase()} values in the images${candidates.length ? ": " + candidates.join(", ") : ""}. Manual verification required.`);
    } else if (!compareField(field,doc,img).matches || result.mismatchedFields?.includes(field)) {
      if (!img && doc) findings.push(`${labels[field]} not readable in the image. PDF: ${quote(doc)}.`);
      else if (img && !doc) findings.push(`${labels[field]} not listed in the PDF. Image: ${quote(img)}.`);
      else findings.push(`${labels[field]} mismatch: PDF ${quote(doc)}; image ${quote(img)}.`);
    }
  }
  if (/different document rows/i.test(result.notes || "")) findings.push("Hardware ID and serial number point to different PDF records. Verify that the labels belong to the same unit.");
  row.remarks = findings.length ? findings.join(" ") : "Match";
  return row;
}

export function buildComparisonReportRows(results: CompareResult[], source: ComparisonReportSource = COMPARISON_REPORT_SOURCE): ComparisonReportRow[] {
  return results.map(result => buildComparisonReportRow(result,source));
}

function invalid(message: string): never { throw Object.assign(new Error(message),{status:400}); }
export function validateComparisonReportResults(input: unknown): CompareResult[] {
  if (!Array.isArray(input) || !input.length || input.length > 1000) return invalid("Choose between 1 and 1,000 comparison rows to export.");
  for (const result of input) {
    if (!result || typeof result !== "object" || !["match","mismatch","missing"].includes(result.status) || !Array.isArray(result.mismatchedFields)
      || result.mismatchedFields.some((field: unknown) => !fields.includes(field as ComparisonField))) return invalid("The comparison results are incomplete. Run the comparison again before exporting.");
    for (const record of [result.doc,result.img]) {
      if (!record || typeof record !== "object" || fields.some(field => typeof record[field] !== "string" || record[field].length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(record[field]))) return invalid("A comparison field is invalid or too long to export.");
    }
    if (result.notes !== undefined && (typeof result.notes !== "string" || result.notes.length > 20000)) return invalid("A comparison note is invalid or too long to export.");
    if (result.fieldNotes !== undefined && (!result.fieldNotes || typeof result.fieldNotes !== "object" || fields.some(field => result.fieldNotes[field] !== undefined && (typeof result.fieldNotes[field] !== "string" || result.fieldNotes[field].length > 10000)))) return invalid("A comparison field note is invalid or too long to export.");
  }
  return input;
}

async function comparisonPdf(rows: ComparisonReportRow[]): Promise<Buffer> {
  const pdf = await PDFDocument.create(), regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle("Comparison Results"); pdf.setAuthor("IPAS");
  const widths = [112,170,120,148,236], left = 28, top = 525, lineHeight = 11, padding = 6, fontSize = 8.5, bottom = 30;
  let page: any, y = top;
  function nextPage() {
    page = pdf.addPage([842,595]); y = top;
    page.drawText("Comparison Results",{x:left,y:560,size:14,font:bold,color:rgb(0,0,0)});
    page.drawText("Page " + pdf.getPageCount(),{x:758,y:560,size:9,font:regular});
    let x = left;
    COMPARISON_REPORT_HEADERS.forEach((text,index) => {
      page.drawRectangle({x,y:y-25,width:widths[index],height:25,borderColor:rgb(0,0,0),borderWidth:0.8});
      page.drawText(text,{x:x+(widths[index]-bold.widthOfTextAtSize(text,9))/2,y:y-16,size:9,font:bold}); x += widths[index];
    }); y -= 25;
  }
  function wrap(text: string, width: number): string[] {
    const output: string[] = []; let current = "";
    try { regular.encodeText(text.replace(/[\r\n\t]/g," ")); }
    catch { return invalid("This text cannot be exported to PDF. Export Excel to preserve the original characters."); }
    for (const word of text.split(/\s+/).filter(Boolean)) {
      if (current && regular.widthOfTextAtSize(current + " " + word,fontSize) <= width) { current += " " + word; continue; }
      if (current) { output.push(current); current = ""; }
      for (const character of word) {
        if (current && regular.widthOfTextAtSize(current + character,fontSize) > width) { output.push(current); current = ""; }
        current += character;
      }
    }
    if (current) output.push(current); return output.length ? output : [""];
  }
  nextPage();
  for (const row of rows) {
    const cells = [row.components,row.description,row.hardwareId,row.serial,row.remarks].map((text,index) => wrap(text,widths[index]-padding*2));
    const count = Math.max(...cells.map(cell => cell.length)), rowHeight = Math.max(26,count*lineHeight+padding*2);
    if (rowHeight <= top-25-bottom && y-rowHeight < bottom) nextPage();
    let offset = 0;
    while (offset < count) {
      const available = Math.floor((y-bottom-padding*2)/lineHeight);
      if (available < 1 || y-bottom < 26) { nextPage(); continue; }
      const take = Math.min(count-offset,available), height = Math.max(26,take*lineHeight+padding*2); let x = left;
      cells.forEach((cell,index) => {
        page.drawRectangle({x,y:y-height,width:widths[index],height,borderColor:rgb(0,0,0),borderWidth:0.6});
        cell.slice(offset,offset+take).forEach((text,line) => { if (text) page.drawText(text,{x:x+padding,y:y-padding-fontSize-line*lineHeight,size:fontSize,font:regular}); }); x += widths[index];
      });
      y -= height; offset += take; if (offset < count) nextPage();
    }
  }
  return Buffer.from(await pdf.save());
}

export async function generateComparisonReportExport(input: unknown, format: unknown) {
  if (format !== "xlsx" && format !== "pdf") return invalid("Choose Excel or PDF for the comparison export.");
  const results = validateComparisonReportResults(input), rows = buildComparisonReportRows(results);
  if (format === "pdf") return {buffer:await comparisonPdf(rows),contentType:"application/pdf",extension:"pdf"};
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([COMPARISON_REPORT_HEADERS,...rows.map(row => [row.components,row.description,row.hardwareId,row.serial,row.remarks])]);
  worksheet["!cols"] = [{wch:24},{wch:34},{wch:24},{wch:30},{wch:90}];
  worksheet["!rows"] = [{hpt:24},...rows.map(row => ({hpt:Math.min(200,Math.max(26,Math.ceil(row.remarks.length/85)*15))}))];
  worksheet["!autofilter"] = {ref:worksheet["!ref"]!};
  XLSX.utils.book_append_sheet(workbook,worksheet,"Comparison Results");
  // Apply borders and wrapped text to this report only. The community workbook
  // writer does not preserve arbitrary cell-style objects.
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  const entries = readZipEntries(XLSX.write(workbook,{type:"buffer",bookType:"xlsx"}) as Buffer);
  for (const entry of entries) {
    if (entry.name === "xl/styles.xml") entry.data = Buffer.from(styles);
    if (entry.name === "xl/worksheets/sheet1.xml") {
      let xml = entry.data.toString("utf8").replace(/<c\b[^>]*\br="[A-Z]+(\d+)"[^>]*>/g,(tag,row) => tag.replace(/\ss="\d+"/g,"").replace(/>$/,` s="${row === "1" ? 2 : 1}">`)).replace(/<pageMargins\b[^>]*\/>|<pageSetup\b[^>]*\/>/g,"");
      const printing = '<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>';
      xml = xml.includes("<ignoredErrors>") ? xml.replace("<ignoredErrors>",printing+"<ignoredErrors>") : xml.replace("</worksheet>",printing+"</worksheet>");
      entry.data = Buffer.from(xml);
    }
  }
  return {buffer:writeZipEntries(entries),contentType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",extension:"xlsx"};
}
