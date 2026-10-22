import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRecord, normalizeExtractedRecord, normalizeGeneral, normalizeIdentifier,
  dedupePreserveOrder, compareField, compareExtractedRecords,
  type ComparisonField, type ExtractedCompareRecord,
} from "../services/comparison.js";

const fields: ComparisonField[] = ["components", "description", "hardwareId", "serial"];
const record = (values: Partial<ExtractedCompareRecord> = {}): ExtractedCompareRecord => ({
  sn: "1", district: "District 3", branch: "Iloilo", components: "MONITOR", description: "ACER K222HQL",
  hardwareId: "MTR-2021-044", serial: "MMT1LSS00983607E9B4220", remarks: "Working", ...values,
});

test("record normalization fills missing fields and leaves raw identifiers unchanged", () => {
  assert.deepEqual(normalizeRecord(undefined), { sn: "", district: "", branch: "", components: "", description: "", hardwareId: "", serial: "", remarks: "" });
  const value = normalizeRecord({ hardwareId: "  mtr-001  ", serial: "000123", remarks: "Review" });
  assert.equal(value.hardwareId, "  mtr-001  "); assert.equal(value.serial, "000123"); assert.equal(value.remarks, "Review");
});

test("extraction notes retain string values but are excluded from normalized document/image records", () => {
  assert.equal(normalizeExtractedRecord({ notes: "Label blurred" }).notes, "Label blurred");
  assert.equal(normalizeExtractedRecord({ notes: 123 as unknown as string }).notes, "");
  assert.equal(normalizeExtractedRecord(undefined).notes, "");
  assert.equal("notes" in normalizeRecord(record({ notes: "Internal note" })), false);
});

test("shared deduplication retains first occurrence, case distinctions and original input", () => {
  const input = ["ACER", "", "K222HQL", "ACER", "acer", "K222HQL"];
  assert.deepEqual(dedupePreserveOrder(input), ["ACER", "K222HQL", "acer"]);
  assert.deepEqual(input, ["ACER", "", "K222HQL", "ACER", "acer", "K222HQL"]);
});

test("shared general and identifier normalization retain their different punctuation rules", () => {
  assert.equal(normalizeGeneral("  hp,  LaserJet. (M404) "), "HP LASERJET M404");
  assert.equal(normalizeGeneral("MTR-2021-044"), "MTR-2021-044");
  assert.equal(normalizeIdentifier(" mtr-2021 / 00044 "), "MTR202100044");
  assert.equal(normalizeIdentifier("0000O1I"), "0000O1I");
});

test("both empty field values retain a match for all four critical fields", () => {
  for (const field of fields) assert.deepEqual(compareField(field, "", ""), { matches: true }, field);
});

test("missing evidence fields explain that the document value was not found", () => {
  for (const field of fields) {
    const result = compareField(field, "DOCUMENT-VALUE", "");
    assert.equal(result.matches, false); assert.match(result.note || "", /DOCUMENT-VALUE.*NOT found in the evidence/);
  }
});

test("evidence-only fields explain that the value is not recorded in the document", () => {
  for (const field of fields) {
    const result = compareField(field, "", "EVIDENCE-VALUE");
    assert.equal(result.matches, false); assert.match(result.note || "", /EVIDENCE-VALUE.*NOT recorded in the document/);
  }
});

test("identifier comparison ignores formatting and case while preserving leading zeros", () => {
  for (const field of ["hardwareId", "serial"] as const) {
    assert.deepEqual(compareField(field, "MTR-2021-00044", "mtr 2021 / 00044"), { matches: true });
    assert.equal(compareField(field, "000123", "123").matches, false);
  }
});

test("existing equipment aliases compare alike across system units, monitors and other equipment", () => {
  for (const [left, right] of [["CPU", "SYSTEM UNIT"], ["desktop computer", "SYSTEM UNIT"], ["THIN CLIENT", "SYSTEM UNIT"],
    ["DISPLAY", "MONITOR"], ["LCD", "LED MONITOR"], ["LASERJET", "PRINTER"], ["MFP", "PRINTER"],
    ["NOTEBOOK", "LAPTOP"], ["CAMERA", "WEBCAM"], ["SCANSNAP", "SCANNER"], ["NETWORK SWITCH", "SWITCH"],
    ["POWER ADAPTOR", "ADAPTER"]]) assert.equal(compareField("components", left, right).matches, true, `${left}/${right}`);
});

test("different equipment categories retain a component mismatch and physical-evidence guidance", () => {
  const result = compareField("components", "MONITOR", "PRINTER");
  assert.equal(result.matches, false); assert.match(result.note || "", /equipment type.*differs/);
});

test("description comparison keeps matching model tokens with extra equipment words", () => {
  for (const [left, right] of [["ACER K222HQL", "acer monitor K222HQL"], ["K222HQL", "ACER K222HQL"],
    ["HP LASERJET M404", "HP LASERJET M404 SERIES PRINTER"]]) assert.equal(compareField("description", left, right).matches, true);
});

test("brand-only overlap and different model numbers do not establish description matches", () => {
  for (const [left, right] of [["ACER", "ACER MONITOR"], ["ACER K222HQL", "ACER V246HQL"],
    ["MONITOR", "DISPLAY"], ["DELL OPTIPLEX 3080", "LENOVO THINKCENTRE M720"]]) {
    assert.equal(compareField("description", left, right).matches, false, `${left}/${right}`);
  }
});

test("OCR-confusable identifier characters stay mismatches requiring manual verification", () => {
  for (const field of ["hardwareId", "serial"] as const) {
    for (const [left, right] of [["ABC0", "ABCO"], ["ABC1", "ABCI"], ["ABC1", "ABCL"], ["ABC5", "ABCS"],
      ["ABC8", "ABCB"], ["ABC2", "ABCZ"], ["ABC6", "ABCG"], ["ABC7", "ABCT"]]) {
      const result = compareField(field, left, right);
      assert.equal(result.matches, false); assert.match(result.note || "", /likely has an OCR scan error/);
      assert.match(result.note || "", /verify the physical label manually/);
    }
  }
});

test("similar identifier values remain mismatches rather than fuzzy matches", () => {
  const result = compareField("serial", "ABCDEFGH12", "ABCDEFGH13");
  assert.equal(result.matches, false); assert.match(result.note || "", /close but does not match exactly/);
  assert.match(result.note || "", /S\/N label/);
});

test("the existing similarity threshold is strictly greater than 0.8", () => {
  const result = compareField("serial", "ABCD1", "ABCD2");
  assert.equal(result.matches, false); assert.match(result.note || "", /Serial does not match/);
  assert.equal(result.note?.includes("is close"), false);
});

test("different property stickers retain the hardware-ID mismatch explanation", () => {
  const result = compareField("hardwareId", "MTR-2021-044", "CPU-2024-999");
  assert.equal(result.matches, false); assert.match(result.note || "", /property sticker.*asset tag/);
});

test("a matching batch row retains raw document/evidence values and has no mismatch notes", () => {
  const expected = record(); const observed = record({ components: "LCD", hardwareId: "mtr 2021 044", notes: "OCR details" });
  const [result] = compareExtractedRecords([expected], [observed]);
  assert.equal(result.status, "match"); assert.deepEqual(result.mismatchedFields, []); assert.deepEqual(result.fieldNotes, {});
  assert.equal(result.notes, undefined); assert.equal(result.doc.hardwareId, "MTR-2021-044"); assert.equal(result.img.hardwareId, "mtr 2021 044");
  assert.equal("notes" in result.img, false);
});

test("batch mismatches retain critical-field order and an explanation for each differing field", () => {
  const [result] = compareExtractedRecords([record()], [record({ components: "PRINTER", description: "HP M404",
    hardwareId: "PTR-2024-999", serial: "DIFFERENT-SERIAL" })]);
  assert.equal(result.status, "mismatch"); assert.deepEqual(result.mismatchedFields, fields);
  for (const field of fields) assert.ok(result.fieldNotes?.[field], field);
  assert.equal(result.notes, fields.map((field) => result.fieldNotes?.[field]).join(" | "));
});

test("missing evidence rows produce a missing status, blank image fields and verification notes", () => {
  const [result] = compareExtractedRecords([record()], []);
  assert.equal(result.status, "missing"); assert.deepEqual(result.mismatchedFields, fields);
  assert.deepEqual(result.img, normalizeRecord(undefined));
  assert.match(result.notes || "", /No evidence values were extracted/);
});

test("partially observed rows are mismatches rather than wholly missing evidence", () => {
  const [result] = compareExtractedRecords([record()], [normalizeExtractedRecord({ serial: "MMT1LSS00983607E9B4220" })]);
  assert.equal(result.status, "mismatch"); assert.deepEqual(result.mismatchedFields, ["components", "description", "hardwareId"]);
});

test("metadata-only or whitespace-only evidence remains missing and uses its extraction note", () => {
  for (const components of ["", "   "]) {
    const [result] = compareExtractedRecords([record()], [normalizeExtractedRecord({ sn: "1", components, notes: "Label is blurred" })]);
    assert.equal(result.status, "missing"); assert.match(result.notes || "", /Label is blurred$/);
  }
});

test("mismatched rows append the existing evidence note without changing the values", () => {
  const [result] = compareExtractedRecords([record()], [record({ serial: "BAD-SERIAL", notes: "Cable covers label" })]);
  assert.equal(result.status, "mismatch"); assert.match(result.notes || "", /Evidence note: Cable covers label$/);
  assert.equal(result.img.serial, "BAD-SERIAL");
});

test("swapped serial and property-tag values remain mismatches without being reassigned", () => {
  const source = record(); const observed = record({ hardwareId: source.serial, serial: source.hardwareId });
  const [result] = compareExtractedRecords([source], [observed]);
  assert.equal(result.status, "mismatch"); assert.deepEqual(result.mismatchedFields, ["hardwareId", "serial"]);
  assert.equal(result.img.hardwareId, source.serial); assert.equal(result.img.serial, source.hardwareId);
});

test("batch comparison retains index alignment and does not itself rematch or append extra observations", () => {
  const first = record(); const second = record({ serial: "SECOND-SERIAL", hardwareId: "MTR-2025-999" });
  const result = compareExtractedRecords([first, second], [second, first, record()]);
  assert.equal(result.length, 2); assert.equal(result[0].doc.serial, first.serial); assert.equal(result[0].img.serial, second.serial);
  assert.equal(result[1].doc.serial, second.serial); assert.equal(result[1].img.serial, first.serial);
  assert.deepEqual(result.map((entry) => entry.status), ["mismatch", "mismatch"]);
  assert.deepEqual(compareExtractedRecords([], [record()]), []);
});

test("empty expected/evidence records retain the existing missing status even with no field differences", () => {
  const [result] = compareExtractedRecords([normalizeExtractedRecord(undefined)], []);
  assert.equal(result.status, "missing"); assert.deepEqual(result.mismatchedFields, []);
  assert.match(result.notes || "", /No evidence values were extracted/);
});

test("batch comparison does not mutate frozen caller records or arrays", () => {
  const expected = [record()]; const observed = [record({ serial: "DIFFERENT" })];
  const before = JSON.stringify({ expected, observed });
  expected.forEach(Object.freeze); observed.forEach(Object.freeze); Object.freeze(expected); Object.freeze(observed);
  compareExtractedRecords(expected, observed);
  assert.equal(JSON.stringify({ expected, observed }), before);
});
