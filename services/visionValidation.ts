import type { IntakeRecord } from "../types/accountability.js";
import type { BarcodeCandidate } from "../types/barcode.js";
import { normalizeIdentifier } from "./comparison.js";
import { sanitizeIntakeTextValue, sanitizeIntakeIdentifierValue } from "./intakeNormalization.js";
import { KNOWN_BRANDS } from "./intakeConsolidation.js";

type VisionField = "components" | "description" | "hardwareId" | "serial";
type Proposal = Pick<IntakeRecord, VisionField> & { notes: string };
type Issue = { field: VisionField; code: string; message: string };
export type VisionValidation = {
  proposal: Proposal;
  issues: Issue[];
  requiresReview: boolean;
  corroboration: Record<"hardwareId" | "serial", "ocr" | "barcode" | "none">;
};
interface Evidence {
  // Supply independent OCR here, before any reference-document reconciliation.
  observedRecord?: Partial<IntakeRecord>;
  barcodes?: readonly BarcodeCandidate[];
  ocrText?: string;
}
const components = new Set([
  "SYSTEM UNIT", "MONITOR", "PRINTER", "KEYBOARD", "MOUSE", "UPS", "CPU ADAPTER",
  "LAPTOP ADAPTER", "LAPTOP", "SCANNER", "WEBCAM", "ROUTER", "SWITCH",
]);
const productBarcode = /^(?:EAN(?:_?\d+)?|UPC(?:_?[AE])?|GTIN(?:_?\d+)?|ISBN(?:_?\d+)?|ISSN)$/i;
const snidValues = (text: string) => Array.from(text.matchAll(/\bSNID\s*[:#.,-]?\s*([A-Z0-9/-]{5,})/gi), match => normalizeIdentifier(match[1]));

/** Product barcodes identify a product line, not an individual manufacturer serial. */
export function removeProductBarcodeSerial(record: IntakeRecord, barcodes: readonly BarcodeCandidate[]): IntakeRecord {
  if (!record.serial || !barcodes.some(candidate => typeof candidate?.value === "string" && productBarcode.test(String(candidate.type || ""))
    && normalizeIdentifier(candidate.value) === normalizeIdentifier(record.serial))) return { ...record };
  return { ...record, serial: "", notes: [record.notes,
    "A product barcode was excluded from the serial field. Confirm the manufacturer S/N on the label."].filter(Boolean).join(" ") };
}

/** Repair only explicit field-role errors; never guess a corrected identifier. */
export function prepareLocalVisionRecord(record: IntakeRecord, barcodes: readonly BarcodeCandidate[], ocrText: string): IntakeRecord {
  const cleaned = removeProductBarcodeSerial(record, barcodes);
  const addNote = (note: string) => { cleaned.notes = [cleaned.notes, note].filter(Boolean).join(" "); };
  if (cleaned.serial) {
    const snids = snidValues(ocrText);
    if (snids.includes(normalizeIdentifier(cleaned.serial))) {
      cleaned.serial = "";
      addNote("An SNID was excluded from the manufacturer serial field. Confirm the S/N on the factory label.");
    }
  }
  // A manufacturer serial accidentally selected as the model must not inflate the description.
  if (cleaned.description) {
    const brand = KNOWN_BRANDS.find(value => cleaned.description.toUpperCase().startsWith(value + " "));
    const identifiers = [record.serial, ...barcodes.filter(candidate => typeof candidate?.value === "string").map(candidate => candidate.value)];
    if (brand && identifiers.some(value => value && normalizeIdentifier(cleaned.description.slice(brand.length)) === normalizeIdentifier(value))) {
      cleaned.description = cleaned.description.slice(0, brand.length);
      addNote("A serial-like value was removed from the model description. Confirm the manufacturer model.");
    }
  }
  const possibleIdentifiers = barcodes.filter(candidate => typeof candidate?.value === "string" && !productBarcode.test(String(candidate.type || ""))
    && normalizeIdentifier(candidate.value) !== normalizeIdentifier(cleaned.hardwareId));
  if (cleaned.serial && possibleIdentifiers.length && !possibleIdentifiers.some(candidate => normalizeIdentifier(candidate.value) === normalizeIdentifier(cleaned.serial))) {
    addNote("Identifier conflict between OCR and decoded barcodes; confirm which label each value belongs to.");
  }
  return cleaned;
}

/** Completeness is eligibility for assistance, not proof that identifiers are correct. */
export function needsIntakeVision(record: IntakeRecord): boolean {
  return [record.components, record.description, record.hardwareId, record.serial].some(value => !value.trim())
    || KNOWN_BRANDS.includes(record.description.trim().toUpperCase())
    || /low.clarity|low.quality|blurry|unclear|conflict|uncertain/i.test(record.notes || "");
}

/** Validate an untrusted Vision proposal; corroboration is not a verification guarantee. */
export function validateVisionDraft(raw: unknown, evidence: Evidence = {}): VisionValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Vision must return one equipment object.");
  }
  const input = raw as Record<string, unknown>;
  if (!["components", "description", "hardwareId", "serial"].some(field => typeof input[field] === "string")) {
    throw new Error("Vision returned no equipment fields.");
  }
  const issues: Issue[] = [];
  const add = (field: VisionField, code: string, message: string) => issues.push({ field, code, message });
  function text(field: VisionField): string {
    const value = input[field];
    if (value === undefined || value === null) return "";
    if (typeof value !== "string" || value.length > 500) {
      add(field, "invalid_field", "Vision returned an invalid or oversized field.");
      return "";
    }
    return sanitizeIntakeTextValue(value);
  }
  const notes = typeof input.notes === "string" ? input.notes.slice(0, 2000).trim() : "";
  const proposal: Proposal = { components: text("components").toUpperCase(), description: text("description"), hardwareId: text("hardwareId"), serial: text("serial"), notes };
  if (proposal.components && !components.has(proposal.components)) {
    add("components", "unsupported_component", "The equipment category needs confirmation.");
    proposal.components = "";
  }
  if (proposal.components === "LAPTOP" && /\b(?:LCD|LED)\s+MONITOR\b/i.test(proposal.description)) {
    add("components", "contradictory_category", "Vision described an LCD/LED monitor but returned LAPTOP.");
    proposal.components = "";
  }
  for (const field of ["hardwareId", "serial"] as const) {
    const original = proposal[field];
    if (/^(?:https?:\/\/|www\.)/i.test(original)) {
      add(field, "url_identifier", "A URL cannot be used as this equipment identifier.");
      proposal[field] = "";
      continue;
    }
    const cleaned = sanitizeIntakeIdentifierValue(original, field, proposal.hardwareId);
    if (original && !cleaned) add(field, "invalid_identifier", "The proposed identifier failed the existing intake rules.");
    proposal[field] = cleaned;
  }
  if (proposal.serial) {
    const serialLabel = typeof input.serialLabel === "string" ? input.serialLabel : "";
    if (/\b(?:MODEL|VERSION|SNID|EAN|UPC|GTIN)\b/i.test(serialLabel)) {
      add("serial", "wrong_label", "The proposed serial came from a model, version or product-number label.");
      proposal.serial = "";
    }
  }
  if (proposal.serial) {
    const normalized = normalizeIdentifier(proposal.serial);
    const model = typeof input.manufacturerModel === "string" ? input.manufacturerModel : typeof input.modelNumber === "string" ? input.modelNumber : "";
    const version = typeof input.version === "string" ? input.version : "";
    if ([model, version, model && version ? model + version : ""].some(value => value && normalizeIdentifier(value) === normalized)) {
      add("serial", "model_as_serial", "The model or version was returned as the manufacturer serial.");
      proposal.serial = "";
    }
  }
  const unreadableSerial = /\b(?:manufacturer\s+)?serial(?:\s+number)?\s+(?:is\s+|was\s+)?(?:not\s+(?:clearly\s+)?(?:visible|readable|legible)|unreadable|unknown|missing|unclear|cannot\s+be\s+(?:read|seen))\b/i.test(notes)
    || /\bno\s+(?:manufacturer\s+)?serial(?:\s+number)?\s+(?:is\s+)?(?:visible|readable|legible)\b/i.test(notes);
  if (proposal.serial && unreadableSerial) {
    add("serial", "contradictory_visibility", "Vision returned a serial while reporting that it could not read the serial.");
    proposal.serial = "";
  }
  if (proposal.serial) {
    const brand = KNOWN_BRANDS.find(value => proposal.description.toUpperCase().startsWith(value + " "));
    if (brand && normalizeIdentifier(proposal.description.slice(brand.length)) === normalizeIdentifier(proposal.serial)) {
      add("serial", "model_as_serial", "The described model was returned as the manufacturer serial.");
      proposal.serial = "";
    } else if (snidValues(evidence.ocrText || "").includes(normalizeIdentifier(proposal.serial))) {
      add("serial", "snid_as_serial", "The proposed serial matches an explicitly labeled SNID in the OCR evidence.");
      proposal.serial = "";
    }
  }
  const barcodes = (evidence.barcodes || []).filter(candidate => typeof candidate?.value === "string" && candidate.value.trim());
  if (proposal.serial && barcodes.some(candidate => productBarcode.test(String(candidate.type || "")) && normalizeIdentifier(candidate.value) === normalizeIdentifier(proposal.serial))) {
    add("serial", "product_barcode_as_serial", "A product barcode was returned as the manufacturer serial.");
    proposal.serial = "";
  }
  const corroboration: VisionValidation["corroboration"] = { hardwareId: "none", serial: "none" };
  for (const field of ["hardwareId", "serial"] as const) {
    const value = proposal[field];
    if (!value) continue;
    const observed = evidence.observedRecord?.[field] || "";
    if (observed && normalizeIdentifier(observed) === normalizeIdentifier(value)) {
      corroboration[field] = "ocr";
    } else {
      const match = barcodes.some(candidate => !productBarcode.test(String(candidate.type || "")) && normalizeIdentifier(candidate.value) === normalizeIdentifier(value));
      corroboration[field] = match ? "barcode" : "none";
      add(field, observed ? "identifier_conflict" : "new_identifier", observed
        ? "Vision disagrees with the observed OCR identifier; retain the observed value for review."
        : match ? "The value matches a decoded barcode; confirm its label and field before saving."
        : "The new Vision identifier needs confirmation before saving.");
    }
  }
  if (![proposal.components, proposal.description, proposal.hardwareId, proposal.serial].some(Boolean)) {
    add("description", "no_readable_fields", "Vision did not provide usable equipment fields; retain the image for manual review.");
  }
  return { proposal, issues, requiresReview: issues.length > 0, corroboration };
}

/** Fill only missing fields; existing OCR values remain available on every conflict. */
export function mergeVisionDraft(observed: IntakeRecord, validation: VisionValidation): { record: IntakeRecord; requiresReview: boolean; issues: Issue[] } {
  const issues = validation.issues.map(issue => ({ ...issue }));
  const record: IntakeRecord = { ...observed };
  for (const field of ["components", "description", "hardwareId", "serial"] as const) {
    const proposal = validation.proposal[field];
    if (field === "description" && proposal && KNOWN_BRANDS.includes(record.description.trim().toUpperCase())
      && proposal.toUpperCase().startsWith(record.description.trim().toUpperCase() + " ")) {
      record.description = proposal;
      issues.push({ field, code: "model_added", message: "Vision added model details to the observed brand; confirm the model on the manufacturer label." });
    } else if (!record[field] && proposal) record[field] = proposal;
    else if (record[field] && proposal && normalizeIdentifier(record[field]) !== normalizeIdentifier(proposal)) {
      if (!issues.some(issue => issue.field === field && issue.code === "identifier_conflict")) {
        issues.push({ field, code: "field_conflict", message: "The Vision proposal differs from the observed field; retain the observed value for review." });
      }
    }
  }
  return { record, requiresReview: validation.requiresReview || issues.length > 0, issues };
}
