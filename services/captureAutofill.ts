import crypto from "node:crypto";
import type { OcrSourceFile } from "../types/ocr.js";
import type { IntakeRecord } from "../types/accountability.js";
import { normalizeIntakeRecord } from "./intakeNormalization.js";
import { dedupeIntakeRecords } from "./intakeConsolidation.js";
import { normalizeGeneral, normalizeIdentifier } from "./comparison.js";
import { canonicalEquipmentComponent, equipmentCaptureSelection } from "./equipmentLabels.js";

/** Preserve user Remarks after legacy consolidation, which otherwise inserts
 * "New Accountability" even when every submitted Remarks value is blank. */
export function sanitizeCaptureExportItems(items: (Partial<IntakeRecord> & { equipmentType?: string; equipmentUnitId?: string })[] | undefined): IntakeRecord[] {
  const originals = Array.isArray(items) ? items.map(item => ({ ...normalizeIntakeRecord(item),
    remarks: typeof item?.remarks === "string" ? item.remarks.trim() : "", ...equipmentCaptureSelection(item) })) : [];
  const groups = new Map<string, IntakeRecord[]>();
  originals.forEach((row, index) => {
    // Match the displayed table: distinct identifiers are distinct units, even
    // when a description is similar or one of their other fields is missing.
    const key = row.equipmentUnitId ? "unit:" + row.equipmentUnitId : row.hardwareId || row.serial
      ? JSON.stringify([normalizeGeneral(row.components), normalizeIdentifier(row.hardwareId), normalizeIdentifier(row.serial)])
      : "image:" + index;
    groups.set(key, [...(groups.get(key) || []), row]);
  });
  return [...groups.values()].flatMap(group => dedupeIntakeRecords(group).map(row => ({
    ...row, remarks: group.find(original => original.remarks)?.remarks || "",
  })));
}

type Extraction = { records: IntakeRecord[]; summary: { manual: number; message?: string } };
export type CaptureDraft = {
  record: IntakeRecord;
  needsReview: boolean;
  missingFields: string[];
  cached: boolean;
};

export class CaptureAutofillError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}

/** Share one read between the phone and laptop and bound CPU/OCR work.
 * Results are drafts only. No database save, upload, export or Remarks inference.
 */
export function createCaptureAutofill(options: {
  extract: (file: OcrSourceFile, onLocalDraft?: (record: IntakeRecord) => void, force?: boolean) => Promise<Extraction>;
  now?: () => number;
  maxPending?: number;
  maxCache?: number;
}) {
  const now = options.now || Date.now;
  const results = new Map<string, { draft: CaptureDraft; expires: number }>();
  const pending = new Map<string, Promise<CaptureDraft>>();
  const localDrafts = new Map<string, CaptureDraft>();
  const listeners = new Map<string, Set<(draft: CaptureDraft) => void>>();
  let tail: Promise<unknown> = Promise.resolve();
  const fields = ["components", "description", "hardwareId", "serial"] as const;
  const clean = (value: unknown) => typeof value === "string" &&
    !/^(unknown|unreadable|not visible|not available|n\/?a|none|null|undefined)$/i.test(value.trim())
    ? value.trim().slice(0, 512) : "";

  function makeDraft(source: IntakeRecord, fileName: string, review: boolean): CaptureDraft {
    const record: IntakeRecord = { sourceName: fileName, components: "", description: "", hardwareId: "", serial: "", remarks: "", notes: clean(source.notes) };
    for (const field of fields) record[field] = clean(source[field]);
    record.components = canonicalEquipmentComponent(record.components);
    if (/^(?:NO\.?|MODEL NO\.?|NUMBER)$/i.test(record.description)) record.description = "";
    const missingFields = fields.filter(field => !record[field]);
    return { record, needsReview: missingFields.length > 0 || review || /review required/i.test(source.notes || ""), missingFields, cached: false };
  }
  async function read(employeeId: string, file: OcrSourceFile, retry = false, onLocalDraft?: (draft: CaptureDraft) => void): Promise<CaptureDraft> {
    if (!employeeId.trim()) throw new CaptureAutofillError("Sign in to read captured images.", 401);
    if (file.kind !== "image" || file.contentType !== "inlineData" || !file.content || !file.mimeType.startsWith("image/")) {
      throw new CaptureAutofillError("Only captured image files can be read automatically.", 400);
    }
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.length > 20 * 1024 * 1024) throw new CaptureAutofillError("This photo exceeds the 20 MB reading limit.", 413);
    const key = employeeId + ":" + crypto.createHash("sha256").update(bytes).digest("hex");
    const copy = (draft: CaptureDraft, cached: boolean) => structuredClone({ ...draft, cached, record: { ...draft.record, sourceName: file.name } });
    const listener = onLocalDraft ? (draft: CaptureDraft) => { try { onLocalDraft(copy(draft, false)); } catch { /* closed client */ } } : null;
    const running = pending.get(key);
    if (running) {
      if (listener) {
        listeners.get(key)?.add(listener);
        const latest = localDrafts.get(key); if (latest) listener(latest);
      }
      try { return copy(await running, true); }
      finally { if (listener) listeners.get(key)?.delete(listener); }
    }
    const existing = results.get(key);
    if (existing && existing.expires > now() && !retry) return copy(existing.draft, true);
    if (pending.size >= (options.maxPending || 4)) throw new CaptureAutofillError("Image reading is busy. Your photo was kept; choose Retry reading shortly.", 429);
    listeners.set(key, new Set(listener ? [listener] : []));
    const work = tail.catch(() => undefined).then(async () => {
      const extraction = await options.extract(file, source => {
        const local = makeDraft(source, file.name, false);
        localDrafts.set(key, local);
        listeners.get(key)?.forEach(notify => notify(local));
      }, retry);
      if (!Array.isArray(extraction.records) || extraction.records.length !== 1) {
        throw new CaptureAutofillError("This image did not produce one clear equipment row. Review the photo and enter its details manually.", 422);
      }
      const draft = makeDraft(extraction.records[0], file.name, extraction.summary.manual > 0);
      results.delete(key);
      results.set(key, { draft: structuredClone(draft), expires: now() + 24 * 60 * 60 * 1000 });
      while (results.size > (options.maxCache || 100)) results.delete(results.keys().next().value!);
      return draft;
    });
    pending.set(key, work); tail = work;
    try { return structuredClone(await work); }
    finally { if (pending.get(key) === work) { pending.delete(key); listeners.delete(key); localDrafts.delete(key); } }
  }
  return { read };
}
