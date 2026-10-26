import type { IntakeRecord } from "../types/accountability.js";
import { normalizeExtractedRecord, type ExtractedCompareRecord } from "./comparison.js";
import { sanitizeIntakeTextValue, sanitizeIntakeIdentifierValue } from "./intakeNormalization.js";
import { KNOWN_BRANDS, chooseBestDescription, choosePreferredComponent, choosePreferredIdentifier, choosePreferredSerial, combineExtractionNotes } from "./intakeConsolidation.js";

export type ReferenceRecord = IntakeRecord;

function scoreReferenceMatch(record: IntakeRecord, reference: ReferenceRecord): number {
  let score = 0;
  const referenceHardwareId = sanitizeIntakeIdentifierValue(reference.hardwareId, "hardwareId");
  const referenceSerial = sanitizeIntakeIdentifierValue(reference.serial, "serial", referenceHardwareId);
  const referenceComponent = sanitizeIntakeTextValue(reference.components);
  const referenceDescription = sanitizeIntakeTextValue(reference.description);

  if (record.hardwareId && referenceHardwareId && record.hardwareId === referenceHardwareId) {
    score += 100;
  }

  if (record.serial && referenceSerial && record.serial === referenceSerial) {
    score += 85;
  }

  if (record.components && referenceComponent && record.components === referenceComponent) {
    score += 25;
  }

  if (record.description && referenceDescription) {
    const recordDescription = record.description.toUpperCase();
    const normalizedReferenceDescription = referenceDescription.toUpperCase();
    if (recordDescription === normalizedReferenceDescription) {
      score += 35;
    } else if (
      recordDescription.includes(normalizedReferenceDescription) ||
      normalizedReferenceDescription.includes(recordDescription)
    ) {
      score += 20;
    }
  }

  if (!record.hardwareId && record.components && referenceComponent === record.components) {
    const recordBrand = KNOWN_BRANDS.find((brand) => record.description.toUpperCase().includes(brand));
    const referenceBrand = KNOWN_BRANDS.find((brand) => referenceDescription.toUpperCase().includes(brand));
    if (recordBrand && referenceBrand && recordBrand === referenceBrand) {
      score += 18;
    }
  }

  return score;
}

function reconcileRecordWithReference(record: IntakeRecord, referenceRecords: ReferenceRecord[]): IntakeRecord {
  if (referenceRecords.length === 0) {
    return record;
  }

  const bestMatch = referenceRecords
    .map((reference) => ({ reference, score: scoreReferenceMatch(record, reference) }))
    .sort((left, right) => right.score - left.score)[0];

  if (!bestMatch || bestMatch.score < 35) {
    return record;
  }

  const reference = bestMatch.reference;
  const referenceComponent = sanitizeIntakeTextValue(reference.components);
  const referenceDescription = sanitizeIntakeTextValue(reference.description);
  const referenceHardwareId = sanitizeIntakeIdentifierValue(reference.hardwareId, "hardwareId");
  const mergedHardwareId = choosePreferredIdentifier(referenceHardwareId, record.hardwareId);
  const referenceSerial = sanitizeIntakeIdentifierValue(reference.serial, "serial", mergedHardwareId);

  return {
    ...record,
    components: choosePreferredComponent(referenceComponent, record.components),
    description: chooseBestDescription(record.description, referenceDescription),
    hardwareId: mergedHardwareId,
    serial: choosePreferredSerial(referenceSerial, record.serial, mergedHardwareId),
    notes: "Matched against the reference accountability source and aligned to the validated document details.",
  };
}

export function alignRecordsToReferenceBatch(records: IntakeRecord[], referenceRecords: ReferenceRecord[]): IntakeRecord[] {
  if (referenceRecords.length === 0 || records.length === 0) {
    return records;
  }

  const pairings = records.flatMap((record, recordIndex) =>
    referenceRecords.map((reference, referenceIndex) => ({
      recordIndex,
      referenceIndex,
      score: scoreReferenceMatch(record, reference),
    }))
  )
    .filter((pairing) => pairing.score >= 35)
    .sort((left, right) => right.score - left.score);

  const usedRecords = new Set<number>();
  const usedReferences = new Set<number>();
  const aligned = records.map((record) => ({ ...record }));

  for (const pairing of pairings) {
    if (usedRecords.has(pairing.recordIndex) || usedReferences.has(pairing.referenceIndex)) {
      continue;
    }

    usedRecords.add(pairing.recordIndex);
    usedReferences.add(pairing.referenceIndex);
    aligned[pairing.recordIndex] = reconcileRecordWithReference(
      aligned[pairing.recordIndex],
      [referenceRecords[pairing.referenceIndex]]
    );
  }

  return aligned;
}

export function toReferenceRecordFromComparison(record: ExtractedCompareRecord): ReferenceRecord {
  return {
    sourceName: "",
    components: record.components || "",
    description: record.description || "",
    hardwareId: record.hardwareId || "",
    serial: record.serial || "",
    remarks: record.remarks || "",
    notes: record.notes || "",
  };
}

function toExtractedCompareRecordFromIntake(record: IntakeRecord): ExtractedCompareRecord {
  return {
    sn: "",
    district: "",
    branch: "",
    components: record.components || "",
    description: record.description || "",
    hardwareId: record.hardwareId || "",
    serial: record.serial || "",
    remarks: record.remarks || "",
    notes: record.notes || "",
  };
}

export function mergeObservedComparisonRecord(
  primary: ExtractedCompareRecord | undefined,
  fallback: ExtractedCompareRecord | undefined
): ExtractedCompareRecord {
  const base = normalizeExtractedRecord(primary);
  const backup = normalizeExtractedRecord(fallback);

  return {
    sn: base.sn || backup.sn,
    district: base.district || backup.district,
    branch: base.branch || backup.branch,
    components: base.components || backup.components,
    description: chooseBestDescription(base.description, backup.description),
    hardwareId: base.hardwareId || backup.hardwareId,
    serial: base.serial || backup.serial,
    remarks: base.remarks || backup.remarks,
    notes: combineExtractionNotes(base.notes, backup.notes),
  };
}

export function mapObservedIntakeRecordsToExpected(
  expectedRecords: ExtractedCompareRecord[],
  observedRecords: IntakeRecord[]
): ExtractedCompareRecord[] {
  const expectedReferences = expectedRecords.map(toReferenceRecordFromComparison);
  const pairings = observedRecords.flatMap((record, observedIndex) =>
    expectedReferences.map((reference, expectedIndex) => ({
      observedIndex,
      expectedIndex,
      score: scoreReferenceMatch(record, reference),
    }))
  )
    .filter((pairing) => pairing.score >= 25)
    .sort((left, right) => right.score - left.score);

  const usedObserved = new Set<number>();
  const usedExpected = new Set<number>();
  const mapped = expectedRecords.map(() => normalizeExtractedRecord(undefined));

  for (const pairing of pairings) {
    if (usedObserved.has(pairing.observedIndex) || usedExpected.has(pairing.expectedIndex)) {
      continue;
    }

    usedObserved.add(pairing.observedIndex);
    usedExpected.add(pairing.expectedIndex);
    mapped[pairing.expectedIndex] = toExtractedCompareRecordFromIntake(observedRecords[pairing.observedIndex]);
  }

  return mapped;
}
