import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { OcrSourceFile } from "../types/ocr.js";
import { normalizeExtractedRecord, type ExtractedCompareRecord } from "./comparison.js";

export type PdfTableItem = { str: string; width: number; height: number; transform: number[] };
type Item = { text: string; x: number; y: number; width: number; height: number };
type Line = { y: number; items: Item[] };
const fields = ["components", "description", "hardwareId", "serial", "remarks"] as const;
type Field = typeof fields[number];
const headerNames: Record<Field, RegExp> = {
  components: /^components?$/i, description: /^description$/i,
  hardwareId: /^hardware\s*id$/i, serial: /^(?:serial(?:\s+(?:number|no\.?))?|s\s*\/\s*n)$/i, remarks: /^remarks$/i,
};
const footer = /^(?:acknowledg(?:e)?ment\b|this is to acknowledge\b|processed by\s*:|verified by\s*:|noted by\s*:)/i;
function join(items: Item[]): string {
  return items.slice().sort((a,b) => a.x - b.x).map((item,index,array) => {
    const previous = array[index - 1];
    const separator = previous && item.x - previous.x - previous.width > Math.min(item.height,previous.height) * 0.25 ? " " : "";
    return separator + item.text;
  }).join("").trim();
}
function lines(items: Item[]): Line[] {
  const result: Line[] = [];
  for (const item of items.slice().sort((a,b) => b.y - a.y || a.x - b.x)) {
    const last = result.at(-1);
    if (last && Math.abs(last.y - item.y) <= Math.max(1, Math.min(item.height, ...last.items.map(value => value.height)) * 0.5)) last.items.push(item);
    else result.push({ y: item.y, items: [item] });
  }
  return result;
}
function cleanItems(raw: PdfTableItem[]): Item[] | null {
  const result: Item[] = [], seen = new Set<string>();
  for (const value of raw) {
    if (!value.str?.trim()) continue;
    if (!Array.isArray(value.transform) || value.transform.length < 6 || ![...value.transform,value.width,value.height].every(Number.isFinite)
      || Math.abs(value.transform[1]) > 0.01 || value.width < 0 || value.height <= 0) return null;
    const item = { text: value.str.trim(), x: value.transform[4], y: value.transform[5], width: value.width, height: value.height };
    const key = [item.text,item.x.toFixed(2),item.y.toFixed(2)].join(":");
    if (!seen.has(key)) { seen.add(key); result.push(item); }
  }
  return result;
}

/** A complete, recognized five-column table only. Geometry keeps neighboring
 * serials and wrapped Remarks in their own cells; ambiguous layouts fail closed. */
export function parsePositionedComparisonTable(pages: PdfTableItem[][]): ExtractedCompareRecord[] | null {
  const records: ExtractedCompareRecord[] = [];
  if (!pages.length || pages.length > 30) return null;
  for (const raw of pages) {
    const items = cleanItems(raw); if (!items?.length) return null;
    const ordered = lines(items);
    const sections: { line: Line; headers: Record<Field,Item> }[] = [];
    for (const line of ordered) {
      const groups: Item[][] = [];
      for (const item of line.items.slice().sort((a,b) => a.x - b.x)) {
        const group = groups.at(-1), previous = group?.at(-1);
        if (group && previous && item.x - previous.x - previous.width < item.height * 1.5) group.push(item);
        else groups.push([item]);
      }
      const candidates = groups.map(group => ({ ...group[0], text: join(group), width: group.at(-1)!.x + group.at(-1)!.width - group[0].x }));
      const headers = {} as Record<Field,Item>;
      for (const field of fields) {
        const matches = candidates.filter(item => headerNames[field].test(item.text));
        if (matches.length === 1) headers[field] = matches[0];
      }
      if (fields.every(field => headers[field])) {
        if (!fields.every((field,index) => !index || headers[field].x > headers[fields[index - 1]].x + headers[fields[index - 1]].width)) return null;
        const first = headers.components.x, last = headers.remarks.x + headers.remarks.width;
        if (candidates.some(item => item.x >= first && item.x <= last && !fields.some(field => headers[field] === item))) return null;
        sections.push({ line, headers });
      }
    }
    // A second page without a recognizable table must never become a silently
    // omitted continuation page, even if the preceding page parsed correctly.
    if (!sections.length) return null;
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
      const { line, headers } = sections[sectionIndex];
      const nextHeader = sections[sectionIndex + 1]?.line.y ?? -Infinity;
      const stops = items.filter(item => item.y < line.y && item.y > nextHeader && footer.test(item.text));
      const bottom = stops.length ? Math.max(...stops.map(item => item.y)) : nextHeader;
      const centers = fields.map(field => headers[field].x + headers[field].width / 2);
      const boundaries = centers.slice(1).map((center,index) => (center + centers[index]) / 2);
      const tableHeight = Math.max(...fields.map(field => headers[field].height));
      const body = items.filter(item => item.y < line.y - tableHeight * 0.75 && item.y > bottom);
      const column = (item: Item) => {
        const center = item.x + item.width / 2;
        const index = boundaries.findIndex(boundary => center < boundary);
        return fields[index < 0 ? 4 : index];
      };
      const componentLines = lines(body.filter(item => column(item) === "components"));
      const anchors: Line[] = [];
      for (const candidate of componentLines) {
        const previous = anchors.at(-1), text = join(candidate.items), before = previous && join(previous.items);
        if (previous && previous.y - candidate.y < tableHeight * 1.8) {
          if (/^(?:LAPTOP|CPU|MONITOR)$/i.test(before!) && /^(?:ADAPTER|ADAPTOR|BAG)$/i.test(text)) previous.items.push(...candidate.items);
          else return null;
        } else anchors.push(candidate);
      }
      if (!anchors.length) return null;
      const cells = anchors.map(() => Object.fromEntries(fields.map(field => [field, [] as Item[]])) as Record<Field,Item[]>);
      for (const item of body) {
        const field = column(item);
        const distances = anchors.map(anchor => Math.abs(anchor.y - item.y));
        const minimum = Math.min(...distances), nearest = distances.indexOf(minimum);
        const localHeight = Math.max(tableHeight, ...anchors[nearest].items.map(value => value.height));
        if (field !== "remarks" && minimum > localHeight * 1.8) return null;
        // Do not silently attach a blank-component row halfway between two units.
        if (field !== "remarks" && distances.filter(distance => Math.abs(distance - minimum) < localHeight * 0.35).length > 1) return null;
        const index = fields.indexOf(field);
        const left = index ? boundaries[index - 1] : centers[0] - (centers[1] - centers[0]) / 2;
        const right = index < 4 ? boundaries[index] : centers[4] + (centers[4] - centers[3]) / 2;
        if (item.x < left - localHeight || item.x + item.width > right + localHeight) return null;
        cells[nearest][field].push(item);
      }
      for (const cell of cells) {
        const row = normalizeExtractedRecord({ sn: String(records.length + 1) });
        for (const field of fields) {
          const grouped = lines(cell[field]);
          if ((field === "hardwareId" || field === "serial") && grouped.length > 1) return null;
          row[field] = grouped.map(value => join(value.items)).join(" ").trim();
        }
        if (!row.components || fields.some(field => headerNames[field].test(row[field]))) return null;
        // Multiple identifiers on the same baseline indicate overlapping rows.
        if ((row.hardwareId.match(/\b[A-Z]{2,6}-\d{4}-/gi) || []).length > 1) return null;
        row.notes = "Reference table read locally from PDF text positions; verify the source document.";
        records.push(row);
      }
    }
  }
  return records.length ? records : null;
}

let pdfModule: Promise<any> | undefined;
/** Keep the installed PDF.js ESM module external to the Node CJS server bundle.
 * No remote PDF URL, renderer, shell program or provider request is used. */
export async function readLocalComparisonPdf(file: OcrSourceFile): Promise<ExtractedCompareRecord[] | null> {
  if (file.kind !== "pdf" || file.contentType !== "inlineData") return null;
  const bytes = Buffer.from(file.content, "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) return null;
  let document: any;
  try {
    const require = createRequire(typeof __filename === "string" ? __filename : path.resolve(process.cwd(), "package.json"));
    const moduleUrl = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href;
    const packageDirectory = path.dirname(require.resolve("pdfjs-dist/package.json"));
    const pdfjs = await (pdfModule ||= import(moduleUrl));
    document = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true,
      standardFontDataUrl: path.join(packageDirectory,"standard_fonts") + path.sep,
      cMapUrl: path.join(packageDirectory,"cmaps") + path.sep, cMapPacked: true,
    }).promise;
    if (document.numPages > 30) return null;
    const pages: PdfTableItem[][] = []; let count = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      if (page.rotate % 360 !== 0) return null;
      const content = await page.getTextContent();
      count += content.items.length; if (count > 100000) return null;
      pages.push(content.items.filter((item: any) => typeof item.str === "string"));
      page.cleanup();
    }
    return parsePositionedComparisonTable(pages);
  } catch { return null; }
  finally { await document?.destroy().catch(() => undefined); }
}
