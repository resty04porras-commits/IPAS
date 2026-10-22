import type { IntakeRecord } from "../types/accountability.js";
import { sanitizeOcrValue } from "./ocr/snapshots.js";
import { dedupePreserveOrder } from "./comparison.js";

const PLACEHOLDER_INTAKE_VALUE_PATTERN = /^(?:BLANK(?:\s+\d+)?|DUPLICATE|DUPLICATED?|COPY|SAME|N\/A|NA|NONE|NULL|UNDEFINED)$/i;
const ASSET_TAG_PATTERN = /\b([A-Z]{1,8})[\s/-]*((?:19|20)\d{2})[\s/-]*([A-Z0-9]{2,8})\b/i;

export function normalizeAlphaNumericCandidate(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9/-]/g, "")
    .replace(/\/+/g, "/")
    .trim();
}

export function normalizeAssetTagCandidate(value: string): string {
  const match = value.toUpperCase().match(ASSET_TAG_PATTERN);
  if (!match) {
    return "";
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function isLikelySerialCandidate(value: string, hardwareId: string): boolean {
  const normalized = normalizeAlphaNumericCandidate(value);
  if (!normalized || normalized === hardwareId) {
    return false;
  }

  // Minimum length: 5 allows Dell 7-char service tags and similar short IDs
  if (normalized.length < 5) {
    return false;
  }

  if (normalizeAssetTagCandidate(normalized)) {
    return false;
  }

  if (/^(PROPERTY|LIFEBANK|FOUNDATION|MODEL|SERIAL|SYSTEM|ADMINISTRATOR|KEYBOARD|MONITOR|PRINTER|LAPTOP|SCANNER)$/i.test(normalized)) {
    return false;
  }

  // Reject pure-label words with no digits (e.g., "NO", "CODE", "LABEL")
  if (/^(?:[A-Z]{1,8}|NO|NUMBER|CODE|LABEL)-?\d{0,4}$/i.test(normalized)) {
    return false;
  }

  // Reject standalone 4-digit years
  if (/^\d{4}$/.test(normalized) || /^20\d{2}$/.test(normalized)) {
    return false;
  }

  // Must contain both alpha and digit, OR be a long pure-digit string (barcode)
  return (
    (/[A-Z]/.test(normalized) && /\d/.test(normalized)) ||
    /^\d{7,}$/.test(normalized)
  );
}

export function looksLikeQrOrBarcodeValue(value: string, hardwareId: string): boolean {
  const normalized = normalizeAlphaNumericCandidate(value);
  if (!normalized || normalized === hardwareId) {
    return false;
  }

  if (normalizeAssetTagCandidate(normalized)) {
    return false;
  }

  if (normalized.length < 8 || normalized.length > 32) {
    return false;
  }

  if (/^(?:PROPERTY|LIFEBANK|FOUNDATION|SERIAL|MODEL|QRCODE|BARCODE|SNID)$/i.test(normalized)) {
    return false;
  }

  return Boolean(
    (/^\d{8,}$/.test(normalized)) ||
    ((/[A-Z]/.test(normalized) && /\d/.test(normalized)) && /[-/]/.test(normalized)) ||
    ((/[A-Z]/.test(normalized) && /\d/.test(normalized)) && normalized.length >= 10)
  );
}

export function sanitizeIntakeTextValue(value: string): string {
  const trimmed = sanitizeOcrValue(value || "");
  if (!trimmed || PLACEHOLDER_INTAKE_VALUE_PATTERN.test(trimmed)) {
    return "";
  }

  return trimmed;
}

export function sanitizeIntakeIdentifierValue(value: string, field: "hardwareId" | "serial", hardwareId = ""): string {
  const trimmed = sanitizeIntakeTextValue(value);
  if (!trimmed) {
    return "";
  }

  if (field === "hardwareId") {
    const normalizedAssetTag = normalizeAssetTagCandidate(trimmed);
    if (normalizedAssetTag) {
      return normalizedAssetTag;
    }

    if (!/\d{4}/.test(trimmed) || /^[A-Z ]+$/i.test(trimmed)) {
      return "";
    }

    return trimmed.toUpperCase();
  }

  if (!isLikelySerialCandidate(trimmed, hardwareId)) {
    return looksLikeQrOrBarcodeValue(trimmed, hardwareId) ? normalizeAlphaNumericCandidate(trimmed) : "";
  }

  return normalizeAlphaNumericCandidate(trimmed);
}

export function normalizeIntakeRecord(record: Partial<IntakeRecord> | undefined): IntakeRecord {
  const hardwareId = sanitizeIntakeIdentifierValue(typeof record?.hardwareId === "string" ? record.hardwareId : "", "hardwareId");
  const serialSource = record as (Partial<IntakeRecord> & {
    serialNumber?: unknown;
    Serial?: unknown;
    "Serial Number"?: unknown;
  }) | undefined;
  const serialValue =
    typeof serialSource?.serial === "string" ? serialSource.serial :
    typeof serialSource?.serialNumber === "string" ? serialSource.serialNumber :
    typeof serialSource?.Serial === "string" ? serialSource.Serial :
    typeof serialSource?.["Serial Number"] === "string" ? serialSource["Serial Number"] :
    "";
  return {
    sourceName: typeof record?.sourceName === "string" ? record.sourceName : "",
    components: sanitizeIntakeTextValue(typeof record?.components === "string" ? record.components : ""),
    description: sanitizeIntakeTextValue(typeof record?.description === "string" ? record.description : ""),
    hardwareId,
    serial: sanitizeIntakeIdentifierValue(serialValue, "serial", hardwareId),
    remarks: sanitizeIntakeTextValue(typeof record?.remarks === "string" ? record.remarks : "") || "New Accountability",
    notes: typeof record?.notes === "string" ? sanitizeOcrValue(record.notes) : "",
  };
}

export function normalizeBarcodeLookupValue(value: string | null | undefined): string {
  return normalizeAlphaNumericCandidate(String(value || ""))
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

export function barcodeLookupCandidates(record: Partial<IntakeRecord>): string[] {
  return dedupePreserveOrder([
    normalizeBarcodeLookupValue(record.hardwareId),
    normalizeBarcodeLookupValue(record.serial),
    normalizeBarcodeLookupValue(record.sourceName),
    normalizeBarcodeLookupValue(record.remarks),
  ]).filter(Boolean);
}

export function buildManualIntakeFallback(sourceName: string, note: string): IntakeRecord {
  return {
    sourceName,
    components: "",
    description: "",
    hardwareId: "",
    serial: "",
    remarks: "New Accountability",
    notes: note,
  };
}
