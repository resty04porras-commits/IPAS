import type { IntakeRecord } from "../types/accountability.js";
import { normalizeGeneral, normalizeIdentifier } from "./comparison.js";
import { normalizeIntakeRecord, normalizeAssetTagCandidate, isLikelySerialCandidate } from "./intakeNormalization.js";

export const KNOWN_BRANDS = [
  "ACER",
  "ASUS",
  "DELL",
  "HP",
  "LENOVO",
  "RAPOO",
  "LOGITECH",
  "A4TECH",
  "VIEWSONIC",
  "BENQ",
  "PHILIPS",
  "LG",
  "SAMSUNG",
  "APC",
  "EPSON",
  "CANON",
  "BROTHER",
  "WD",
  "INTEL",
  "AMD",
  "MSI",
  "HIKVISION",
  "TOSHIBA",
  "DYNABOOK",
  "SEAGATE",
  "TP-LINK",
  "TPLINK",
  "CISCO",
  "ZEBRA",
  "PANTUM",
  "FUJITSU",
  "KYOCERA",
  "XEROX",
  "KINGSTON",
  "SANDISK",
  "RICOH",
  "SHARP",
  "BELKIN",
  "ANKER",
  "DAHUA",
  "REALTEK",
  "GIGABYTE",
  "COOLER MASTER",
  "CORSAIR",
  "CRUCIAL",
];

export function countPopulatedIntakeFields(record: Pick<IntakeRecord, "components" | "description" | "hardwareId" | "serial">): number {
  return [record.components, record.description, record.hardwareId, record.serial]
    .filter((value) => value.trim().length > 0)
    .length;
}

export function hasStrongIntakeExtraction(record: IntakeRecord): boolean {
  const fieldCount = countPopulatedIntakeFields(record);
  return Boolean(record.hardwareId && (record.serial || record.description)) || fieldCount >= 3;
}

export function hasUsableIntakeExtraction(record: IntakeRecord): boolean {
  const fieldCount = countPopulatedIntakeFields(record);
  const hasIdentity = Boolean(record.hardwareId || record.serial);
  const hasContext = Boolean(record.components || record.description);

  if (hasStrongIntakeExtraction(record)) {
    return true;
  }

  return Boolean(hasIdentity && hasContext) || fieldCount >= 2;
}

export function chooseBestDescription(primary: string, fallback: string): string {
  if (!primary) {
    return fallback;
  }

  if (!fallback) {
    return primary;
  }

  const primaryHasBrand = KNOWN_BRANDS.some((brand) => primary.toUpperCase().includes(brand));
  const fallbackHasBrand = KNOWN_BRANDS.some((brand) => fallback.toUpperCase().includes(brand));

  if (primaryHasBrand && !fallbackHasBrand) {
    return primary;
  }

  if (fallbackHasBrand && !primaryHasBrand) {
    return fallback;
  }

  return fallback.length > primary.length ? fallback : primary;
}

export function buildOcrNotes(fields: { hardwareId: string; serial: string; description: string; component: string; lowQuality?: boolean }): string {
  const count = [fields.hardwareId, fields.serial, fields.description, fields.component].filter((value) => value.trim().length > 0).length;

  if (count >= 3) {
    return fields.lowQuality
      ? "Extracted with regional PaddleOCR from a low-clarity image. Verify the values carefully before export."
      : "Extracted with regional PaddleOCR. Verify the values before export.";
  }

  if (count > 0) {
    return fields.lowQuality
      ? "Partially extracted from a blurry or low-quality image. Review and complete the missing values manually."
      : "Partially extracted with regional PaddleOCR. Review and complete the missing values manually.";
  }

  return fields.lowQuality
    ? "The image appears too blurry or low-quality for reliable OCR. Review and enter the values manually."
    : "Regional PaddleOCR could not isolate clear asset details. Review and enter the values manually.";
}

export function combineExtractionNotes(...notes: Array<string | undefined>): string {
  return notes
    .map((note) => (note || "").trim())
    .filter(Boolean)
    .filter((note, index, allNotes) => allNotes.indexOf(note) === index)
    .join(" | ");
}

export function choosePreferredComponent(primary: string, fallback: string): string {
  if (!primary) {
    return fallback;
  }

  if (!fallback) {
    return primary;
  }

  const normalizedPrimary = normalizeGeneral(primary);
  const normalizedFallback = normalizeGeneral(fallback);
  if (normalizedPrimary === normalizedFallback) {
    return primary.length >= fallback.length ? primary : fallback;
  }

  return primary.length >= fallback.length ? primary : fallback;
}

export function choosePreferredIdentifier(primary: string, fallback: string): string {
  if (!primary) {
    return fallback;
  }

  if (!fallback) {
    return primary;
  }

  const normalizedPrimary = normalizeIdentifier(primary);
  const normalizedFallback = normalizeIdentifier(fallback);
  if (normalizedPrimary === normalizedFallback) {
    return primary.length >= fallback.length ? primary : fallback;
  }

  return normalizedPrimary.length >= normalizedFallback.length ? primary : fallback;
}

export function choosePreferredSerial(primary: string, fallback: string, hardwareId: string): string {
  const primaryLooksValid = isLikelySerialCandidate(primary, hardwareId);
  const fallbackLooksValid = isLikelySerialCandidate(fallback, hardwareId);

  if (primaryLooksValid && !fallbackLooksValid) {
    return primary;
  }

  if (fallbackLooksValid && !primaryLooksValid) {
    return fallback;
  }

  return choosePreferredIdentifier(primary, fallback);
}

function descriptionsRoughlyMatch(primary: string, candidate: string): boolean {
  const normalizedPrimary = normalizeGeneral(primary);
  const normalizedCandidate = normalizeGeneral(candidate);

  if (!normalizedPrimary || !normalizedCandidate) {
    return false;
  }

  if (normalizedPrimary === normalizedCandidate) {
    return true;
  }

  return normalizedPrimary.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedPrimary);
}

function canConsolidateIntakeRecords(primary: IntakeRecord, candidate: IntakeRecord): boolean {
  const primaryComponent = normalizeGeneral(primary.components);
  const candidateComponent = normalizeGeneral(candidate.components);
  const primaryHardware = normalizeIdentifier(primary.hardwareId);
  const candidateHardware = normalizeIdentifier(candidate.hardwareId);
  const primarySerial = normalizeIdentifier(primary.serial);
  const candidateSerial = normalizeIdentifier(candidate.serial);

  const sameComponent = Boolean(primaryComponent && candidateComponent && primaryComponent === candidateComponent);
  const compatibleComponents = sameComponent || !primaryComponent || !candidateComponent;
  const sameHardware = Boolean(primaryHardware && candidateHardware && primaryHardware === candidateHardware);
  const sameSerial = Boolean(primarySerial && candidateSerial && primarySerial === candidateSerial);

  if (sameComponent && (sameHardware || sameSerial)) {
    return true;
  }

  if (compatibleComponents && sameHardware && sameSerial) {
    return true;
  }

  if (
    sameComponent
    && descriptionsRoughlyMatch(primary.description, candidate.description)
    && (
      !primaryHardware
      || !candidateHardware
      || !primarySerial
      || !candidateSerial
    )
  ) {
    return true;
  }

  return false;
}

export function mergeConsolidatedIntakeRecords(primary: IntakeRecord, candidate: IntakeRecord): IntakeRecord {
  const mergedHardwareId = choosePreferredIdentifier(primary.hardwareId, candidate.hardwareId);
  return {
    sourceName: primary.sourceName || candidate.sourceName,
    components: choosePreferredComponent(primary.components, candidate.components),
    description: chooseBestDescription(primary.description, candidate.description),
    hardwareId: mergedHardwareId,
    serial: choosePreferredSerial(primary.serial, candidate.serial, mergedHardwareId),
    remarks: primary.remarks || candidate.remarks || "New Accountability",
    notes: combineExtractionNotes(primary.notes, candidate.notes),
  };
}

export function dedupeIntakeRecords(records: IntakeRecord[]): IntakeRecord[] {
  const consolidated: IntakeRecord[] = [];

  for (const rawRecord of records) {
    const record = normalizeIntakeRecord(rawRecord);
    const existingIndex = consolidated.findIndex((candidate) => canConsolidateIntakeRecords(candidate, record));

    if (existingIndex >= 0) {
      consolidated[existingIndex] = mergeConsolidatedIntakeRecords(consolidated[existingIndex], record);
      continue;
    }

    const duplicateIndex = consolidated.findIndex((candidate) => {
      return normalizeGeneral(candidate.components) === normalizeGeneral(record.components)
        && normalizeIdentifier(candidate.hardwareId) === normalizeIdentifier(record.hardwareId)
        && normalizeIdentifier(candidate.serial) === normalizeIdentifier(record.serial)
        && Boolean((record.components || record.hardwareId || record.serial).trim());
    });

    if (duplicateIndex >= 0) {
      consolidated[duplicateIndex] = mergeConsolidatedIntakeRecords(consolidated[duplicateIndex], record);
      continue;
    }

    consolidated.push(record);
  }

  return consolidated;
}

export function mergeLocalAndAiIntakeRecord(fileName: string, localRecord: IntakeRecord, aiRecord: IntakeRecord): IntakeRecord {
  const mergedHardwareId = normalizeAssetTagCandidate(localRecord.hardwareId)
    || normalizeAssetTagCandidate(aiRecord.hardwareId)
    || localRecord.hardwareId
    || aiRecord.hardwareId;

  const mergedComponent = localRecord.components || aiRecord.components;
  const mergedDescription = chooseBestDescription(localRecord.description, aiRecord.description);
  const mergedSerial = isLikelySerialCandidate(localRecord.serial, mergedHardwareId)
    ? localRecord.serial
    : isLikelySerialCandidate(aiRecord.serial, mergedHardwareId)
      ? aiRecord.serial
      : localRecord.serial || aiRecord.serial;

  const mergedRecord: IntakeRecord = {
    sourceName: fileName,
    components: mergedComponent,
    description: mergedDescription,
    hardwareId: mergedHardwareId,
    serial: mergedSerial,
    remarks: localRecord.remarks || aiRecord.remarks || "New Accountability",
    notes: combineExtractionNotes(
      localRecord.notes,
      aiRecord.notes,
      countPopulatedIntakeFields({
        components: mergedComponent,
        description: mergedDescription,
        hardwareId: mergedHardwareId,
        serial: mergedSerial,
      }) > countPopulatedIntakeFields(localRecord)
        ? "Combined local PaddleOCR with AI-assisted field recovery."
        : ""
    ),
  };

  if (!mergedRecord.notes) {
    mergedRecord.notes = buildOcrNotes({
      hardwareId: mergedRecord.hardwareId,
      serial: mergedRecord.serial,
      description: mergedRecord.description,
      component: mergedRecord.components,
    });
  }

  return mergedRecord;
}
