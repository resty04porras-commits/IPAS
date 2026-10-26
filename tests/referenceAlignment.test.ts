import assert from "node:assert/strict";
import test from "node:test";
import type { IntakeRecord } from "../types/accountability.js";
import { normalizeExtractedRecord, type ExtractedCompareRecord } from "../services/comparison.js";
import {
  alignRecordsToReferenceBatch, toReferenceRecordFromComparison,
  mergeObservedComparisonRecord, mapObservedIntakeRecordsToExpected,
} from "../services/referenceAlignment.js";

const serial = "MMT1LSS00983607E9B4220";
const hardwareId = "MTR-2021-044";
const alignedNote = "Matched against the reference accountability source and aligned to the validated document details.";
const reference = (values: Partial<IntakeRecord> = {}): IntakeRecord => ({ sourceName: "reference.xlsx", components: "MONITOR", description: "ACER K222HQL", hardwareId, serial, remarks: "Reference remark", notes: "Reference note", ...values });
const observed = (values: Partial<IntakeRecord> = {}): IntakeRecord => ({ sourceName: "capture.jpg", components: "", description: "", hardwareId: "", serial: "", remarks: "Observed remark", notes: "Observed note", ...values });
const expected = (values: Partial<ExtractedCompareRecord> = {}): ExtractedCompareRecord => normalizeExtractedRecord({ sn: "1", district: "District 3", branch: "Iloilo", components: "MONITOR", description: "ACER K222HQL", hardwareId, serial, remarks: "Reference remark", ...values });

test("empty inputs retain the original array rather than inventing records", () => {
  const records = [observed()]; const empty: IntakeRecord[] = [];
  assert.equal(alignRecordsToReferenceBatch(records, []), records);
  assert.equal(alignRecordsToReferenceBatch(empty, [reference()]), empty);
});

test("nonempty alignment copies records without mutating frozen caller data", () => {
  const input = Object.freeze(observed({ hardwareId })); const rows = Object.freeze([input]);
  const result = alignRecordsToReferenceBatch(rows as unknown as IntakeRecord[], [Object.freeze(reference())]);
  assert.notEqual(result, rows); assert.notEqual(result[0], input);
  assert.equal(input.serial, ""); assert.equal(result[0].serial, serial);
});

test("an exact asset-tag match fills fields using the existing reference preferences", () => {
  const result = alignRecordsToReferenceBatch([observed({ hardwareId })], [reference()]);
  assert.deepEqual(result, [observed({ components: "MONITOR", description: "ACER K222HQL", hardwareId, serial, notes: alignedNote })]);
});

test("alignment retains observed filename and remarks while replacing the note", () => {
  const result = alignRecordsToReferenceBatch([observed({ hardwareId, sourceName: "actual-photo.jpg", remarks: "Physical condition observed", notes: "Original OCR note" })], [reference()]);
  assert.equal(result[0].sourceName, "actual-photo.jpg"); assert.equal(result[0].remarks, "Physical condition observed"); assert.equal(result[0].notes, alignedNote);
});

test("higher identifier evidence beats an earlier weaker description match", () => {
  const result = alignRecordsToReferenceBatch([observed({ components: "MONITOR", description: "ACER K222HQL", hardwareId })], [reference({ hardwareId: "MTR-2021-045", serial: "7ABC123" }), reference()]);
  assert.equal(result[0].hardwareId, hardwareId); assert.equal(result[0].serial, serial);
});

test("component-only evidence below the alignment threshold leaves values unchanged", () => {
  const input = observed({ components: "MONITOR" });
  assert.deepEqual(alignRecordsToReferenceBatch([input], [reference()]), [input]);
});

test("exact description evidence at the existing threshold can align without identifiers", () => {
  const result = alignRecordsToReferenceBatch([observed({ description: "ACER K222HQL" })], [reference()]);
  assert.equal(result[0].hardwareId, hardwareId); assert.equal(result[0].serial, serial); assert.equal(result[0].notes, alignedNote);
});

test("a partial description alone stays below the alignment threshold", () => {
  const input = observed({ description: "ACER" });
  assert.deepEqual(alignRecordsToReferenceBatch([input], [reference()]), [input]);
});

test("equal reference scores retain the first reference in input order", () => {
  const result = alignRecordsToReferenceBatch([observed({ components: "MONITOR", description: "ACER K222HQL" })], [reference({ hardwareId: "MTR-2021-045", serial: "7ABC123" }), reference()]);
  assert.equal(result[0].hardwareId, "MTR-2021-045"); assert.equal(result[0].serial, "7ABC123");
});

test("reference formatting is sanitized while identifiers retain significant zeros", () => {
  const result = alignRecordsToReferenceBatch([observed({ hardwareId: "MTR-2021-00044" })], [reference({ components: "  MONITOR  ", hardwareId: "mtr / 2021 / 00044", serial: "000012345678" })]);
  assert.equal(result[0].components, "MONITOR"); assert.equal(result[0].hardwareId, "MTR-2021-00044"); assert.equal(result[0].serial, "000012345678");
});

test("alignment retains the existing assumption that observed identifiers are already normalized", () => {
  const input = observed({ hardwareId: "mtr / 2021 / 044" });
  assert.deepEqual(alignRecordsToReferenceBatch([input], [reference()]), [input]);
});

test("an OCR-confusable serial alone does not count as an identifier match", () => {
  const input = observed({ serial: "ABCO12345" });
  assert.deepEqual(alignRecordsToReferenceBatch([input], [reference({ serial: "ABC012345" })]), [input]);
});

test("one reference entry is used for at most one observation", () => {
  const result = alignRecordsToReferenceBatch([observed({ hardwareId, sourceName: "first.jpg" }), observed({ hardwareId, sourceName: "second.jpg" })], [reference()]);
  assert.equal(result.length, 2); assert.equal(result[0].serial, serial); assert.equal(result[1].serial, ""); assert.equal(result[1].notes, "Observed note");
});

test("unused reference entries do not become extra observed records", () => {
  const result = alignRecordsToReferenceBatch([observed({ hardwareId })], [reference(), reference({ hardwareId: "MTR-2021-045", serial: "7ABC123" })]);
  assert.equal(result.length, 1);
});

test("reversed observations remain in photo order while finding their corresponding references", () => {
  const second = reference({ hardwareId: "MTR-2021-045", serial: "7ABC123", description: "DELL U2412M" });
  const result = alignRecordsToReferenceBatch([observed({ hardwareId: second.hardwareId, sourceName: "second.jpg" }), observed({ hardwareId, sourceName: "first.jpg" })], [reference(), second]);
  assert.deepEqual(result.map(item => [item.sourceName, item.hardwareId, item.serial]), [["second.jpg", second.hardwareId, second.serial], ["first.jpg", hardwareId, serial]]);
});

test("the existing greedy pairing does not introduce global rematching", () => {
  const second = reference({ hardwareId: "MTR-2021-045", serial: "7ABC123", description: "" });
  const inputs = [observed({ components: "MONITOR", hardwareId, serial: second.serial }), observed({ components: "MONITOR", hardwareId })];
  const result = alignRecordsToReferenceBatch(inputs, [reference({ description: "" }), second]);
  assert.equal(result[0].serial, serial); assert.equal(result[1].serial, ""); assert.equal(result[1].notes, "Observed note");
});

test("comparison-to-reference conversion retains equipment values but drops comparison metadata", () => {
  const result = toReferenceRecordFromComparison(expected({ hardwareId: " mtr / 2021 / 044 ", serial: "000012345678", notes: "Document note" }));
  assert.deepEqual(result, { sourceName: "", components: "MONITOR", description: "ACER K222HQL", hardwareId: " mtr / 2021 / 044 ", serial: "000012345678", remarks: "Reference remark", notes: "Document note" });
  assert.equal("district" in result, false); assert.equal("sn" in result, false);
});

test("mapping returns evidence in expected-document order without copying document metadata", () => {
  const refs = [expected(), expected({ sn: "2", hardwareId: "MTR-2021-045", serial: "7ABC123", description: "DELL U2412M" })];
  const result = mapObservedIntakeRecordsToExpected(refs, [observed({ components: "MONITOR", hardwareId: refs[1].hardwareId, serial: refs[1].serial, notes: "Second label" }), observed({ components: "MONITOR", hardwareId, serial, notes: "First label" })]);
  assert.deepEqual(result.map(item => [item.hardwareId, item.serial, item.notes]), [[hardwareId, serial, "First label"], [refs[1].hardwareId, refs[1].serial, "Second label"]]);
  assert.deepEqual(result.map(item => [item.sn, item.district, item.branch]), [["", "", ""], ["", "", ""]]);
});

test("component-only comparison mapping retains its lower threshold without filling unseen identifiers", () => {
  const input = observed({ components: "MONITOR" });
  const result = mapObservedIntakeRecordsToExpected([expected()], [input]);
  assert.equal(result[0].components, "MONITOR"); assert.equal(result[0].hardwareId, ""); assert.equal(result[0].serial, ""); assert.equal(result[0].notes, "Observed note");
  assert.equal(alignRecordsToReferenceBatch([input], [reference()])[0].notes, "Observed note");
});

test("partial-description-only evidence below the mapping threshold leaves a blank slot", () => {
  assert.deepEqual(mapObservedIntakeRecordsToExpected([expected()], [observed({ description: "ACER" })]), [normalizeExtractedRecord(undefined)]);
});

test("missing and extra observations do not change the expected output length", () => {
  const refs = [expected(), expected({ sn: "2", components: "PRINTER", description: "EPSON L3110", hardwareId: "PTR-2024-001", serial: "7ABC123" })];
  const result = mapObservedIntakeRecordsToExpected(refs, [observed({ hardwareId, serial }), observed({ components: "ROUTER" }), observed({ components: "KEYBOARD" })]);
  assert.equal(result.length, 2); assert.equal(result[0].hardwareId, hardwareId); assert.deepEqual(result[1], normalizeExtractedRecord(undefined));
});

test("mapping uses each observation once and keeps stable input order on equal scores", () => {
  const refs = [expected(), expected({ sn: "2", hardwareId: "MTR-2021-045", serial: "7ABC123" })];
  const single = mapObservedIntakeRecordsToExpected(refs, [observed({ components: "MONITOR", notes: "Only observation" })]);
  assert.equal(single[0].notes, "Only observation"); assert.deepEqual(single[1], normalizeExtractedRecord(undefined));
  const two = mapObservedIntakeRecordsToExpected(refs, [observed({ components: "MONITOR", notes: "First" }), observed({ components: "MONITOR", notes: "Second" })]);
  assert.deepEqual(two.map(item => item.notes), ["First", "Second"]);
});

test("mapping with no expected records returns no entries even when observations exist", () => {
  assert.deepEqual(mapObservedIntakeRecordsToExpected([], [observed({ hardwareId })]), []);
});

test("comparison merge retains primary raw identifiers even when fallback identifiers differ", () => {
  const result = mergeObservedComparisonRecord(expected({ hardwareId: "raw-primary-tag", serial: "ABCO12345" }), expected({ hardwareId, serial: "ABC012345" }));
  assert.equal(result.hardwareId, "raw-primary-tag"); assert.equal(result.serial, "ABCO12345");
});

test("comparison merge fills only blank fields while choosing a useful description", () => {
  const primary = normalizeExtractedRecord({ sn: "", district: "Observed District", description: "Generic display input 100-240V", serial });
  const result = mergeObservedComparisonRecord(primary, expected({ notes: "AI recovery" }));
  assert.equal(result.sn, "1"); assert.equal(result.district, "Observed District"); assert.equal(result.branch, "Iloilo");
  assert.equal(result.description, "ACER K222HQL"); assert.equal(result.hardwareId, hardwareId); assert.equal(result.serial, serial);
});

test("comparison merge preserves note order and removes repeated notes", () => {
  const result = mergeObservedComparisonRecord(expected({ notes: " Label unclear " }), expected({ notes: "Label unclear" }));
  assert.equal(result.notes, "Label unclear");
  assert.equal(mergeObservedComparisonRecord(expected({ notes: "Local" }), expected({ notes: "AI" })).notes, "Local | AI");
});

test("merging missing evidence returns a blank record without inventing document values", () => {
  assert.deepEqual(mergeObservedComparisonRecord(undefined, undefined), normalizeExtractedRecord(undefined));
});

test("converters, mapping and evidence merge leave frozen inputs unchanged", () => {
  const ref = Object.freeze(expected()); const photo = Object.freeze(observed({ hardwareId, serial }));
  const refs = Object.freeze([ref]); const photos = Object.freeze([photo]);
  const before = JSON.stringify({ refs, photos });
  toReferenceRecordFromComparison(ref);
  mapObservedIntakeRecordsToExpected(refs as unknown as ExtractedCompareRecord[], photos as unknown as IntakeRecord[]);
  mergeObservedComparisonRecord(ref, Object.freeze(expected({ notes: "Fallback" })));
  assert.equal(JSON.stringify({ refs, photos }), before);
});
