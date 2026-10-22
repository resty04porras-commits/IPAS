import assert from "node:assert/strict";
import test from "node:test";
import type { IntakeRecord } from "../types/accountability.js";
import {
  countPopulatedIntakeFields, hasStrongIntakeExtraction, hasUsableIntakeExtraction,
  chooseBestDescription, choosePreferredComponent, choosePreferredIdentifier, choosePreferredSerial,
  buildOcrNotes, combineExtractionNotes, mergeConsolidatedIntakeRecords,
  dedupeIntakeRecords, mergeLocalAndAiIntakeRecord,
} from "../services/intakeConsolidation.js";

const serial = "MMT1LSS00983607E9B4220";
const hardwareId = "MTR-2021-044";
const record = (values: Partial<IntakeRecord> = {}): IntakeRecord => ({
  sourceName: "monitor.jpg", components: "MONITOR", description: "ACER K222HQL",
  hardwareId, serial, remarks: "New Accountability", notes: "", ...values,
});
const blank = (values: Partial<IntakeRecord> = {}): IntakeRecord => record({ components: "", description: "", hardwareId: "", serial: "", ...values });

test("field completeness counts only non-whitespace equipment fields", () => {
  assert.equal(countPopulatedIntakeFields(record()), 4);
  assert.equal(countPopulatedIntakeFields(blank({ sourceName: "label.jpg", remarks: "Working", notes: "Review", description: " \t " })), 0);
  assert.equal(countPopulatedIntakeFields(blank({ components: "MONITOR", serial })), 2);
});

test("existing strong and usable extraction decisions retain their distinct thresholds", () => {
  const cases: [Partial<IntakeRecord>, boolean, boolean][] = [
    [{}, false, false], [{ hardwareId }, false, false], [{ serial }, false, false],
    [{ components: "MONITOR" }, false, false], [{ description: "ACER" }, false, false],
    [{ hardwareId, serial }, true, true], [{ hardwareId, description: "ACER" }, true, true],
    [{ components: "MONITOR", serial }, false, true], [{ components: "MONITOR", hardwareId }, false, true],
    [{ components: "MONITOR", description: "ACER", serial }, true, true],
  ];
  for (const [fields, strong, usable] of cases) {
    assert.equal(hasStrongIntakeExtraction(blank(fields)), strong, JSON.stringify(fields));
    assert.equal(hasUsableIntakeExtraction(blank(fields)), usable, JSON.stringify(fields));
  }
});

test("two context fields alone retain the existing usable-but-not-strong result", () => {
  const value = blank({ components: "MONITOR", description: "ACER K222HQL" });
  assert.equal(hasStrongIntakeExtraction(value), false); assert.equal(hasUsableIntakeExtraction(value), true);
});

test("recognized-brand descriptions take priority over longer unbranded text", () => {
  assert.equal(chooseBestDescription("ACER K222HQL", "LCD LED BACKLIGHT INPUT RATING 100-240V"), "ACER K222HQL");
  assert.equal(chooseBestDescription("LCD LED BACKLIGHT INPUT RATING 100-240V", "acer k222hql"), "acer k222hql");
});

test("description fallback, greater detail and equal-length priority remain unchanged", () => {
  assert.equal(chooseBestDescription("", "ACER"), "ACER"); assert.equal(chooseBestDescription("ACER", ""), "ACER");
  assert.equal(chooseBestDescription("ACER", "ACER K222HQL"), "ACER K222HQL");
  assert.equal(chooseBestDescription("ACER", "DELL"), "ACER");
});

test("component preference retains existing string-length and tie behavior", () => {
  assert.equal(choosePreferredComponent("", "MONITOR"), "MONITOR");
  assert.equal(choosePreferredComponent("MONITOR", ""), "MONITOR");
  assert.equal(choosePreferredComponent("MONITOR", "LCD MONITOR"), "LCD MONITOR");
  assert.equal(choosePreferredComponent("MONITOR", "PRINTER"), "MONITOR");
});

test("identifier preference preserves raw formatting and favors normalized length", () => {
  assert.equal(choosePreferredIdentifier("A---------1", "ABC123"), "ABC123");
  assert.equal(choosePreferredIdentifier("mtr / 2021 / 044", hardwareId), "mtr / 2021 / 044");
  assert.equal(choosePreferredIdentifier("00001234", "1234"), "00001234");
  assert.equal(choosePreferredIdentifier("ABCO12345", "ABC012345"), "ABCO12345");
});

test("a valid manufacturer serial takes priority over an invalid property tag or label", () => {
  assert.equal(choosePreferredSerial(hardwareId, serial, hardwareId), serial);
  assert.equal(choosePreferredSerial(serial, "ADMINISTRATOR", hardwareId), serial);
});

test("when serial validity agrees the existing identifier tie rule applies", () => {
  assert.equal(choosePreferredSerial("7ABC123", serial, hardwareId), serial);
  assert.equal(choosePreferredSerial("ABCO12345", "ABC012345", hardwareId), "ABCO12345");
});

test("notes combine in first-seen order with blank removal and case-sensitive deduplication", () => {
  assert.equal(combineExtractionNotes("  Label unclear  ", undefined, "", "Label unclear", "label unclear", "Check tag"), "Label unclear | label unclear | Check tag");
  assert.equal(combineExtractionNotes(), "");
});

test("complete, partial and empty OCR notes retain their existing low-quality variants", () => {
  const full = { component: "MONITOR", description: "ACER", hardwareId, serial };
  const partial = { component: "MONITOR", description: "", hardwareId: "", serial: "" };
  const empty = { component: "", description: "", hardwareId: "", serial: "" };
  assert.equal(buildOcrNotes(full), "Extracted with regional PaddleOCR. Verify the values before export.");
  assert.equal(buildOcrNotes({ ...full, lowQuality: true }), "Extracted with regional PaddleOCR from a low-clarity image. Verify the values carefully before export.");
  assert.equal(buildOcrNotes(partial), "Partially extracted with regional PaddleOCR. Review and complete the missing values manually.");
  assert.equal(buildOcrNotes({ ...partial, lowQuality: true }), "Partially extracted from a blurry or low-quality image. Review and complete the missing values manually.");
  assert.equal(buildOcrNotes(empty), "Regional PaddleOCR could not isolate clear asset details. Review and enter the values manually.");
  assert.equal(buildOcrNotes({ ...empty, lowQuality: true }), "The image appears too blurry or low-quality for reliable OCR. Review and enter the values manually.");
});

test("consolidated records retain first source and remarks while filling useful fields", () => {
  const result = mergeConsolidatedIntakeRecords(record({ description: "ACER", serial: "", remarks: "Working", notes: "Tag visible" }), record({ sourceName: "factory-label.jpg", notes: "Serial visible" }));
  assert.deepEqual(result, record({ description: "ACER K222HQL", remarks: "Working", notes: "Tag visible | Serial visible" }));
});

test("consolidation fills missing source metadata without mutating either input", () => {
  const first = Object.freeze(blank({ sourceName: "", remarks: "" }));
  const second = Object.freeze(record({ remarks: "", notes: "Manual review" }));
  const result = mergeConsolidatedIntakeRecords(first, second);
  assert.equal(result.sourceName, "monitor.jpg"); assert.equal(result.remarks, "New Accountability");
  assert.equal(result.serial, serial); assert.equal(first.serial, ""); assert.equal(second.notes, "Manual review");
});

test("normalized captures of the same component and asset tag consolidate into one record", () => {
  const result = dedupeIntakeRecords([record({ serial: "", notes: "Property photo" }), record({ sourceName: "label.jpg", hardwareId: "mtr / 2021 / 044", notes: "Serial photo" })]);
  assert.equal(result.length, 1); assert.equal(result[0].serial, serial); assert.equal(result[0].hardwareId, hardwareId);
  assert.equal(result[0].notes, "Property photo | Serial photo"); assert.equal(result[0].sourceName, "monitor.jpg");
});

test("same-component serial matches retain the existing merge despite differing asset tags", () => {
  const result = dedupeIntakeRecords([record(), record({ hardwareId: "MTR-2021-045" })]);
  assert.equal(result.length, 1); assert.equal(result[0].hardwareId, hardwareId);
});

test("fully identified units with distinct identifiers remain separate despite matching models", () => {
  const result = dedupeIntakeRecords([record(), record({ sourceName: "other.jpg", hardwareId: "MTR-2021-045", serial: "MMT1LSS00983607E9B4221" })]);
  assert.equal(result.length, 2); assert.equal(result[1].hardwareId, "MTR-2021-045");
});

test("different component names retain separate rows even with matching identifiers", () => {
  const result = dedupeIntakeRecords([record(), record({ components: "LCD MONITOR" })]);
  assert.equal(result.length, 2);
});

test("a missing component may be filled when both identifiers agree", () => {
  const result = dedupeIntakeRecords([record({ components: "" }), record()]);
  assert.equal(result.length, 1); assert.equal(result[0].components, "MONITOR");
});

test("one matching identifier alone does not join records with a missing component", () => {
  const result = dedupeIntakeRecords([record({ components: "", serial: "" }), record()]);
  assert.equal(result.length, 2);
});

test("partially identified records with overlapping model descriptions retain the current join rule", () => {
  const result = dedupeIntakeRecords([record({ description: "ACER", hardwareId: "MTR-2021-045", serial: "" }), record()]);
  assert.equal(result.length, 1); assert.equal(result[0].description, "ACER K222HQL"); assert.equal(result[0].serial, serial);
});

test("partial records without matching identifiers or overlapping descriptions remain separate", () => {
  const result = dedupeIntakeRecords([record({ description: "DELL U2412M", hardwareId: "MTR-2021-045", serial: "" }), record()]);
  assert.equal(result.length, 2);
});

test("anonymous blank records remain separate while identical component-only records consolidate", () => {
  assert.equal(dedupeIntakeRecords([blank(), blank()]).length, 2);
  assert.equal(dedupeIntakeRecords([blank({ components: "MONITOR" }), blank({ components: "MONITOR" })]).length, 1);
});

test("batch order and first-seen source names remain stable when duplicates arrive later", () => {
  const keyboard = record({ sourceName: "keyboard.jpg", components: "KEYBOARD", description: "LOGITECH K120", hardwareId: "KBD-2021-009", serial: "000012345678" });
  const result = dedupeIntakeRecords([record(), keyboard, record({ sourceName: "duplicate.jpg", notes: "Another photo" })]);
  assert.deepEqual(result.map(item => item.sourceName), ["monitor.jpg", "keyboard.jpg"]);
  assert.equal(result[0].notes, "Another photo");
});

test("batch consolidation accepts frozen caller data and leaves normalized output stable", () => {
  const first = Object.freeze(record({ hardwareId: "mtr / 2021 / 044" }));
  const items = Object.freeze([first, Object.freeze(record())]);
  const result = dedupeIntakeRecords(items as unknown as IntakeRecord[]);
  assert.equal(items.length, 2); assert.equal(first.hardwareId, "mtr / 2021 / 044");
  assert.deepEqual(dedupeIntakeRecords(result), result);
});

test("local OCR fields retain priority when AI offers conflicting but complete identifiers", () => {
  const local = Object.freeze(record({ notes: "Local label" }));
  const ai = Object.freeze(record({ hardwareId: "MTR-2021-099", serial: "MMT1LSS00983607E9B4999", notes: "AI label" }));
  const result = mergeLocalAndAiIntakeRecord("capture.jpg", local, ai);
  assert.equal(result.sourceName, "capture.jpg"); assert.equal(result.hardwareId, hardwareId); assert.equal(result.serial, serial);
  assert.equal(result.notes, "Local label | AI label"); assert.equal(local.sourceName, "monitor.jpg");
});

test("AI fills missing local fields and retains the existing recovery note", () => {
  const result = mergeLocalAndAiIntakeRecord("capture.jpg", blank({ components: "MONITOR", notes: "Tag unreadable" }), record({ notes: "AI recovery" }));
  assert.equal(result.hardwareId, hardwareId); assert.equal(result.serial, serial); assert.equal(result.description, "ACER K222HQL");
  assert.equal(result.notes, "Tag unreadable | AI recovery | Combined local PaddleOCR with AI-assisted field recovery.");
});

test("a valid AI serial can replace an invalid local serial without rewriting its characters", () => {
  const result = mergeLocalAndAiIntakeRecord("capture.jpg", record({ serial: hardwareId, notes: "Verify" }), record({ serial: "ABCO12345" }));
  assert.equal(result.serial, "ABCO12345"); assert.equal(result.notes, "Verify");
});

test("merged notes receive the existing OCR summary when neither input supplies a note", () => {
  const result = mergeLocalAndAiIntakeRecord("capture.jpg", record(), record());
  assert.equal(result.notes, "Extracted with regional PaddleOCR. Verify the values before export.");
  const empty = mergeLocalAndAiIntakeRecord("capture.jpg", blank(), blank());
  assert.equal(empty.notes, "Regional PaddleOCR could not isolate clear asset details. Review and enter the values manually.");
});
