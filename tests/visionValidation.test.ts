import assert from "node:assert/strict";
import test from "node:test";
import type { IntakeRecord } from "../types/accountability.js";
import { validateVisionDraft, mergeVisionDraft, needsIntakeVision, removeProductBarcodeSerial, prepareLocalVisionRecord } from "../services/visionValidation.js";

const serial = "MMT1LSS00983607E9B4220";
const good = { components: "MONITOR", description: "ACER K222HQL", hardwareId: "MTR-2021-044", serial, notes: "" };
const observed: IntakeRecord = { sourceName: "monitor.jpg", ...good, remarks: "Working" };

test("complete OCR skips Vision while missing fields, brand-only descriptions and low clarity request assistance", () => {
  assert.equal(needsIntakeVision(observed), false);
  for (const field of ["components", "description", "hardwareId", "serial"]) assert.equal(needsIntakeVision({ ...observed, [field]: "" }), true);
  assert.equal(needsIntakeVision({ ...observed, description: "ACER" }), true);
  assert.equal(needsIntakeVision({ ...observed, notes: "Low-clarity image" }), true);
});

test("product barcodes are also excluded from local OCR serials without changing other fields", () => {
  const input = Object.freeze({ ...observed, serial: "4713883585477" });
  const result = removeProductBarcodeSerial(input, [{ type: "EAN_13", value: "4713883585477" }]);
  assert.equal(result.serial, ""); assert.equal(result.hardwareId, observed.hardwareId); assert.equal(input.serial, "4713883585477");
  assert.equal(removeProductBarcodeSerial(observed, [{ type: "CODE_128", value: serial }]).serial, serial);
});

test("Vision can extend an observed brand with model details as a reviewable draft", () => {
  const input = { ...observed, description: "ACER" };
  const result = mergeVisionDraft(input, validateVisionDraft(good, { observedRecord: input }));
  assert.equal(result.record.description, good.description); assert.equal(result.requiresReview, true);
  assert.ok(result.issues.some(issue => issue.code === "model_added"));
  const conflict = mergeVisionDraft({ ...observed, description: "ACER OTHER123" }, validateVisionDraft(good, { observedRecord: observed }));
  assert.equal(conflict.record.description, "ACER OTHER123"); assert.equal(conflict.requiresReview, true);
});

test("an explicitly labeled SNID cannot become the observed manufacturer serial", () => {
  const input = Object.freeze({ ...observed, serial: "03603241142" });
  const result = prepareLocalVisionRecord(input, [], "SNID,03603241142");
  assert.equal(result.serial, ""); assert.equal(input.serial, "03603241142"); assert.equal(needsIntakeVision(result), true);
  assert.equal(prepareLocalVisionRecord(observed, [], "SNID 83603241142").serial, serial);
});

test("a known manufacturer serial is removed from the model description without changing its characters", () => {
  const result = prepareLocalVisionRecord({ ...observed, description: "ACER " + serial }, [], "S/N " + serial);
  assert.equal(result.description, "ACER"); assert.equal(result.serial, serial); assert.equal(needsIntakeVision(result), true);
  assert.equal(prepareLocalVisionRecord(observed, [], "S/N " + serial).description, good.description);
});

test("conflicting decoded identifiers request review without rewriting OCR serials", () => {
  const result = prepareLocalVisionRecord(observed, [{ type: "CODE_128", value: "MMT1LSS0O983607E9B4220" }], "");
  assert.equal(result.serial, serial); assert.equal(needsIntakeVision(result), true); assert.match(result.notes || "", /Identifier conflict/);
  assert.equal(needsIntakeVision(prepareLocalVisionRecord(observed, [{ type: "EAN_13", value: "4713883585477" }], "")), false);
});

test("Vision cannot refill an explicitly labeled SNID as the manufacturer serial", () => {
  const result = validateVisionDraft({ ...good, serial: "03603241142" }, { ocrText: "SNID,03603241142" });
  assert.equal(result.proposal.serial, ""); assert.ok(result.issues.some(issue => issue.code === "snid_as_serial"));
});

test("a described model cannot become the serial without an explicit modelNumber field", () => {
  const result = validateVisionDraft({ ...good, serial: "K222HQL" });
  assert.equal(result.proposal.serial, ""); assert.ok(result.issues.some(issue => issue.code === "model_as_serial"));
});

test("the actual small-model monitor failure cannot supply its false category and serial", () => {
  const result = validateVisionDraft({ components: "LAPTOP", description: "Acer LCD Monitor / LED Backlight", hardwareId: good.hardwareId, serial: "K222HQL b", notes: "Manufacturer serial number is not visible. EAN barcode is present but not used as manufacturer serial." });
  assert.equal(result.proposal.components, ""); assert.equal(result.proposal.serial, "");
  assert.equal(result.proposal.hardwareId, good.hardwareId); assert.equal(result.requiresReview, true);
  assert.ok(result.issues.some(issue => issue.code === "contradictory_category"));
  assert.ok(result.issues.some(issue => issue.code === "contradictory_visibility"));
});

test("matching independent OCR identifiers need no new identifier confirmation", () => {
  const result = validateVisionDraft(good, { observedRecord: observed });
  assert.equal(result.requiresReview, false); assert.deepEqual(result.corroboration, { hardwareId: "ocr", serial: "ocr" });
});

test("new AI identifiers remain proposals even when their syntax is valid", () => {
  const result = validateVisionDraft(good);
  assert.equal(result.requiresReview, true); assert.deepEqual(result.issues.map(issue => issue.field), ["hardwareId", "serial"]);
});

test("a decoded non-product barcode supports its exact value but does not prove its field", () => {
  const result = validateVisionDraft({ ...good, hardwareId: "" }, { barcodes: [{ type: "CODE_128", value: serial }] });
  assert.equal(result.proposal.serial, serial); assert.equal(result.corroboration.serial, "barcode"); assert.equal(result.requiresReview, true);
});

test("a product barcode is not promoted to manufacturer serial", () => {
  for (const type of ["EAN_13", "EAN13", "EAN_8", "UPC_A", "GTIN_14", "ISBN13"]) {
    const result = validateVisionDraft({ ...good, serial: "4713883585477" }, { barcodes: [{ type, value: "4713883585477" }] });
    assert.equal(result.proposal.serial, "", type); assert.ok(result.issues.some(issue => issue.code === "product_barcode_as_serial"), type);
  }
});

test("explicit model, version and SNID labels cannot become serial evidence", () => {
  for (const serialLabel of ["Model No", "Version", "SNID", "EAN", "GTIN"]) {
    const result = validateVisionDraft({ ...good, serial: "K222HQLB", serialLabel });
    assert.equal(result.proposal.serial, "", serialLabel);
  }
});

test("model/version equality is rejected without guessing identifier characters", () => {
  for (const fields of [{ manufacturerModel: "K222HQL", serial: "K222HQL" }, { modelNumber: "K222HQL", version: "b", serial: "K222HQL b" }]) {
    const result = validateVisionDraft({ ...good, ...fields });
    assert.equal(result.proposal.serial, ""); assert.ok(result.issues.some(issue => issue.code === "model_as_serial"));
  }
});

test("leading zeros and O/0 distinctions are retained and conflicts are not corrected", () => {
  const result = validateVisionDraft({ ...good, serial: "0000O1I12345" }, { observedRecord: { serial: "000001I12345" } });
  assert.equal(result.proposal.serial, "0000O1I12345"); assert.equal(result.corroboration.serial, "none");
  assert.ok(result.issues.some(issue => issue.code === "identifier_conflict"));
});

test("a readable manufacturer serial is retained when unrelated notes mention a product barcode", () => {
  const result = validateVisionDraft({ ...good, notes: "EAN barcode is visible but is not used as the manufacturer serial." }, { observedRecord: observed });
  assert.equal(result.proposal.serial, serial); assert.equal(result.requiresReview, false);
});

test("URLs, property tags reused as serials and invalid category values are rejected", () => {
  const result = validateVisionDraft({ ...good, components: "ADMINISTRATOR", hardwareId: "https://asset/2021044", serial: "MTR-2021-044" });
  assert.equal(result.proposal.components, ""); assert.equal(result.proposal.hardwareId, ""); assert.equal(result.proposal.serial, "");
});

test("invalid object shapes throw rather than masquerading as a successful blank extraction", () => {
  for (const value of [null, undefined, [], "MONITOR", 123]) assert.throws(() => validateVisionDraft(value), /one equipment object/);
  assert.throws(() => validateVisionDraft({}), /no equipment fields/);
});

test("an explicitly unreadable all-blank result still requires review", () => {
  const result = validateVisionDraft({ components: "", description: "", hardwareId: "", serial: "", notes: "Unreadable labels" });
  assert.equal(result.requiresReview, true); assert.ok(result.issues.some(issue => issue.code === "no_readable_fields"));
});

test("common visibility statements cannot contradict a supplied manufacturer serial", () => {
  for (const notes of ["Serial number is not clearly visible.", "No manufacturer serial number is visible.", "Serial number cannot be read."]) {
    assert.equal(validateVisionDraft({ ...good, notes }).proposal.serial, "", notes);
  }
});

test("non-string and oversized identifier fields cannot be coerced or silently truncated", () => {
  const result = validateVisionDraft({ ...good, hardwareId: 2021044, serial: "1".repeat(501) });
  assert.equal(result.proposal.hardwareId, ""); assert.equal(result.proposal.serial, ""); assert.equal(result.requiresReview, true);
});

test("merging fills blanks but preserves observed identifiers and marks discrepancies for review", () => {
  const primary = Object.freeze({ ...observed, serial: "ABC012345", description: "" });
  const result = mergeVisionDraft(primary, validateVisionDraft({ ...good, serial: "ABCO12345" }, { observedRecord: primary }));
  assert.equal(result.record.serial, "ABC012345"); assert.equal(result.record.description, good.description);
  assert.equal(result.record.sourceName, "monitor.jpg"); assert.equal(result.record.remarks, "Working"); assert.equal(result.requiresReview, true);
});

test("the benchmark failure cannot overwrite an existing correct OCR or barcode-derived record", () => {
  const result = mergeVisionDraft(observed, validateVisionDraft({ components: "LAPTOP", description: "Acer LCD Monitor / LED Backlight", hardwareId: good.hardwareId, serial: "K222HQL b", notes: "Manufacturer serial number is not visible." }, { observedRecord: observed }));
  assert.equal(result.record.components, "MONITOR"); assert.equal(result.record.serial, serial); assert.equal(result.requiresReview, true);
});

test("validation and merging do not mutate frozen input evidence or proposals", () => {
  const draft = Object.freeze({ ...good }); const input = Object.freeze({ ...observed });
  const codes = Object.freeze([Object.freeze({ value: serial, type: "CODE_128" })]);
  const validation = validateVisionDraft(draft, { observedRecord: input, barcodes: codes });
  const snapshot = JSON.stringify(validation); mergeVisionDraft(input, validation);
  assert.equal(JSON.stringify(validation), snapshot); assert.equal(input.serial, serial); assert.equal(draft.serial, serial);
});
