import crypto from "node:crypto";
import type { OcrSourceFile } from "../types/ocr.js";
import type { IntakeRecord } from "../types/accountability.js";
import { compareField, compareExtractedRecords, normalizeExtractedRecord, normalizeIdentifier, type CompareResult, type ExtractedCompareRecord } from "./comparison.js";

export type ComparisonProgress = { stage: "source" | "evidence" | "assistance" | "matching"; completed: number; total: number; message: string };
export type ComparisonContext = { onProgress?: (progress: ComparisonProgress) => void; isCancelled?: () => boolean; employeeId?: string };
export class ComparisonStoppedError extends Error {
  constructor(message = "Comparison cancelled. The selected files were kept.", public status = 499) { super(message); }
}
const critical = ["components", "description", "hardwareId", "serial"] as const;
const readable = (row: Partial<IntakeRecord>) => critical.some(field => Boolean(String(row[field] || "").trim()));
const notes = (...values: (string | undefined)[]) => [...new Set(values.filter(Boolean))].join(" | ");

/** Only a recognized structured table can bypass source-document extraction.
 * Unknown PDF text layouts are not treated as a complete table by proximity. */
export function parseComparisonTable(source: OcrSourceFile): ExtractedCompareRecord[] | null {
  if (source.kind !== "excel" || source.contentType !== "text") return null;
  try {
    const rows = JSON.parse(source.content); if (!Array.isArray(rows)) return null;
    const result: ExtractedCompareRecord[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const keyed = new Map(Object.entries(raw).map(([key,value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), value]));
      if (!["components", "component", "description", "hardwareid", "serial"].some(key => keyed.has(key))) return null;
      const field = (...keys: string[]) => { const value = keys.map(key => keyed.get(key)).find(value => value !== undefined && value !== null); return typeof value === "string" || typeof value === "number" ? String(value).trim() : ""; };
      const supported = new Set(["sn","no","rownumber","district","branch","components","component","description","hardwareid","serial","serialnumber","serialno","remarks"]);
      if ([...keyed.keys()].some(key => /serial|hardware|property|asset|model|descrip|component|brand|version|tag|hwid|^id$/.test(key) && !supported.has(key))) return null;
      if (Object.keys(raw).some(key => /^s\s*\/\s*n$/i.test(key.trim())) && !["serial","serialnumber","serialno"].some(key => keyed.has(key))) return null;
      const row = normalizeExtractedRecord({ sn: field("sn", "no", "rownumber"), district: field("district"), branch: field("branch"),
        components: field("components", "component"), description: field("description"), hardwareId: field("hardwareid"), serial: field("serial", "serialnumber", "serialno"), remarks: field("remarks") });
      if (readable(row)) result.push(row);
    }
    return result.length ? result : null;
  } catch { return null; }
}

/** Preserve physical values. Reference rows are used only to find a candidate
 * row, never to fill an observed field, choose an identifier or break a tie. */
export function comparePhysicalEvidence(expected: ExtractedCompareRecord[], evidence: IntakeRecord[]): CompareResult[] {
  const assigned = expected.map(() => [] as IntakeRecord[]);
  const extras: IntakeRecord[][] = [];
  const conflicts = new Map<ExtractedCompareRecord, Partial<Record<typeof critical[number],string>>>();
  for (const original of evidence) {
    const row = { ...original }; if (!readable(row)) continue;
    const hardware = row.hardwareId ? expected.flatMap((item,index) => normalizeIdentifier(item.hardwareId) === normalizeIdentifier(row.hardwareId) ? [index] : []) : [];
    const serial = row.serial ? expected.flatMap((item,index) => normalizeIdentifier(item.serial) === normalizeIdentifier(row.serial) ? [index] : []) : [];
    const intersection = hardware.filter(index => serial.includes(index));
    let candidates = intersection.length ? intersection : hardware.length ? hardware : serial;
    if (!candidates.length && row.components && row.description) {
      candidates = expected.flatMap((item,index) => item.components && item.description &&
        compareField("components", item.components, row.components).matches && compareField("description", item.description, row.description).matches ? [index] : []);
      if (candidates.length === 1) row.notes = notes(row.notes, "Associated by the readable equipment type and model; confirm this is the intended physical unit.");
    }
    if (candidates.length === 1) {
      if (hardware.length && serial.length && !intersection.length) row.notes = notes(row.notes, "The visible hardware ID and serial point to different document rows; verify the labels belong to the same unit.");
      assigned[candidates[0]].push(row);
    } else {
      row.notes = notes(row.notes, candidates.length > 1 ? "This photo could belong to more than one document row. No unit was selected automatically." : "No unambiguous document row was found for these physical values.");
      const key = row.hardwareId ? "hardware:" + normalizeIdentifier(row.hardwareId) : row.serial ? "serial:" + normalizeIdentifier(row.serial) : "";
      const same = key && extras.find(group => (group[0].hardwareId ? "hardware:" + normalizeIdentifier(group[0].hardwareId) : group[0].serial ? "serial:" + normalizeIdentifier(group[0].serial) : "") === key);
      if (same) same.push(row); else extras.push([row]);
    }
  }
  function merge(group: IntakeRecord[]): ExtractedCompareRecord {
    const result = normalizeExtractedRecord(undefined); const review: string[] = [], fieldNotes: Partial<Record<typeof critical[number],string>> = {};
    for (const field of critical) {
      let values = group.filter(row => row[field]);
      if (field === "serial") {
        const rank = (row: IntakeRecord) => /SNID fallback/i.test(row.notes || "") ? 1 : /Manufacturer S\/N label read/i.test(row.notes || "") ? 3 : 2;
        const maximum = Math.max(0, ...values.map(rank)); values = values.filter(row => rank(row) === maximum);
      }
      if (field === "description") {
        const ordered = values.slice().sort((a,b) => b.description.length - a.description.length);
        if (ordered[0] && ordered.every(row => normalizeIdentifier(ordered[0].description).includes(normalizeIdentifier(row.description)))) values = [ordered[0]];
      }
      if (field === "components" && values[0] && values.every(row => compareField(field, values[0][field], row[field]).matches)) values = [values[0]];
      const unique = [...new Map(values.map(row => [normalizeIdentifier(row[field]), row[field]])).values()];
      result[field] = unique.length === 1 ? unique[0] : "";
      if (unique.length > 1) {
        fieldNotes[field] = `Conflicting photo ${field}: ${unique.map(value => JSON.stringify(value)).join(", ")}. The field was left blank for review.`;
        review.push(fieldNotes[field]!);
      }
    }
    const hasManufacturer = result.serial && group.some(row => normalizeIdentifier(row.serial) === normalizeIdentifier(result.serial) && !/SNID fallback/i.test(row.notes || ""));
    result.notes = notes(...group.map(row => hasManufacturer ? (row.notes || "").replace(/SNID fallback:[^.]*\./gi,"").trim() : row.notes), ...review, group.length > 1 ? "Multiple label photos were associated with this document row; verify that the labels belong to the same physical unit." : undefined);
    conflicts.set(result,fieldNotes);
    return result;
  }
  const observed = assigned.map(merge);
  const results = compareExtractedRecords(expected, observed).map((result,index) => ({ ...result,
    fieldNotes: { ...result.fieldNotes, ...conflicts.get(observed[index]) },
    notes: (result.notes || observed[index].notes) || undefined,
    sourceNames: assigned[index].map(row => row.sourceName),
  }));
  for (const group of extras) {
    const actual = merge(group);
    const [extra] = compareExtractedRecords([normalizeExtractedRecord(undefined)], [actual]);
    results.push({ ...extra, fieldNotes: { ...extra.fieldNotes, ...conflicts.get(actual) }, notes: notes("Evidence not assigned to a document row; review this item separately.", extra.notes || actual.notes), sourceNames: group.map(row => row.sourceName) });
  }
  return results;
}

export function createComparisonWorkflow<T extends { record: IntakeRecord; assisted?: boolean }>(options: {
  readSource: (source: OcrSourceFile, scope: string) => Promise<ExtractedCompareRecord[]>;
  readImage: (file: OcrSourceFile, scope: string) => Promise<T>;
  assistImage: (file: OcrSourceFile, observation: T, scope: string) => Promise<T>;
  needsAssistance: (row: IntakeRecord) => boolean;
  allowAssistance: boolean;
  maxAssistedImages: number;
  now?: () => number;
  timeoutMs?: number;
}) {
  let active = false; const now = options.now || Date.now;
  return async function run(source: OcrSourceFile, files: OcrSourceFile[], context: ComparisonContext = {}): Promise<CompareResult[]> {
    if (active) throw Object.assign(new Error("Another comparison is running. Please try again when it finishes."), { status: 503 });
    if (!source || !Array.isArray(files) || !files.length || files.length > 20) throw Object.assign(new Error("Choose one reference document and between 1 and 20 evidence files."), { status: 400 });
    for (const file of [source,...files]) if (!file || !["image","pdf","excel"].includes(file.kind) || !["text","inlineData"].includes(file.contentType) || typeof file.content !== "string" || !file.content.trim()) throw Object.assign(new Error("A comparison source is empty or unsupported. Attach the file again."), { status: 400 });
    active = true;
    const deadline = now() + (options.timeoutMs || 15 * 60000);
    function check() {
      if (context.isCancelled?.()) throw new ComparisonStoppedError();
      if (now() > deadline) throw new ComparisonStoppedError("Comparison reached its time limit. Files were kept; a retry can reuse cached image reads.", 504);
    }
    const report = (stage: ComparisonProgress["stage"], completed: number, total: number, message: string) => { check(); context.onProgress?.({ stage, completed, total, message }); };
    try {
      report("source", 0, 1, "Reading the reference document…");
      const scope = context.employeeId || "legacy";
      const expected = await options.readSource(source, scope); check();
      if (!Array.isArray(expected) || !expected.length) throw new Error("No equipment rows were read from the reference document. Use a readable copy of the complete table.");
      const unique = new Map<string,OcrSourceFile>();
      files.forEach(file => { const key = file.kind + ":" + crypto.createHash("sha256").update(file.contentType === "inlineData" ? Buffer.from(file.content,"base64") : file.content).digest("hex"); if (!unique.has(key)) unique.set(key,file); });
      const work = [...unique.values()]; const observed: IntakeRecord[] = []; let assisted = 0;
      for (let index = 0; index < work.length; index++) {
        check(); const file = work[index]; report("evidence", index, work.length, `Reading evidence ${index + 1} of ${work.length}…`);
        if (file.kind !== "image") {
          try { observed.push(...(await options.readSource(file, scope)).map(record => ({ ...record, sourceName: file.name, remarks: "" }))); }
          catch { check(); observed.push({ sourceName: file.name, components: "", description: "", hardwareId: "", serial: "", remarks: "", notes: "This evidence document could not be read. Review the original file." }); }
        } else {
          let observation: T;
          try { observation = await options.readImage(file, scope); }
          catch { check(); observation = { record: { sourceName: file.name, components: "", description: "", hardwareId: "", serial: "", remarks: "", notes: "Local reading could not finish; review this photo." } } as T; }
          check();
          if (options.allowAssistance && !observation.assisted && assisted < options.maxAssistedImages && options.needsAssistance(observation.record)) {
            assisted++; report("assistance", index, work.length, `Checking unclear fields in evidence ${index + 1} of ${work.length}…`);
            try { observation = await options.assistImage(file, observation, scope); }
            catch { check(); observation = { ...observation, record: { ...observation.record, notes: notes(observation.record.notes, "Cloud assistance could not finish or its budget was unavailable. Physical OCR fields were retained for review.") } }; }
          }
          observed.push({ ...observation.record, sourceName: file.name, remarks: "" });
        }
        report("evidence", index + 1, work.length, `Read ${index + 1} of ${work.length} evidence files.`);
      }
      report("matching", work.length, work.length, "Comparing the document with the readable physical values…");
      const results = comparePhysicalEvidence(expected, observed);
      const unreadable = observed.filter(row => !readable(row)).map(row => row.sourceName);
      if (unreadable.length && results[0]) results[0].notes = notes(results[0].notes, `Unreadable evidence: ${unreadable.join(", ")}. Review those files separately.`);
      return results;
    } finally { active = false; }
  };
}
