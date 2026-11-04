import test from "node:test";
import assert from "node:assert/strict";
import { createComparisonWorkflow, comparePhysicalEvidence, parseComparisonTable } from "../services/comparisonWorkflow.js";
import { normalizeExtractedRecord } from "../services/comparison.js";
import type { IntakeRecord } from "../types/accountability.js";
import type { OcrSourceFile } from "../types/ocr.js";

const reference = (change = {}) => normalizeExtractedRecord({ sn: "1", components: "MONITOR", description: "ACER K222HQL", hardwareId: "MTR-001", serial: "SERIAL001", ...change });
const physical = (change = {}): IntakeRecord => ({ sourceName: "photo.jpg", components: "", description: "", hardwareId: "", serial: "", remarks: "", ...change });
const file = (index = 1, change = {}): OcrSourceFile => ({ name: `photo-${index}.jpg`, kind: "image", mimeType: "image/jpeg", contentType: "inlineData", content: Buffer.from(`synthetic-${index}`).toString("base64"), ...change });
const source = file(0, { name: "reference.xlsx", kind: "excel", contentType: "text", content: JSON.stringify([reference()]) });
function fixture(change: Record<string, any> = {}) {
  const calls: string[] = [];
  const run = createComparisonWorkflow({
    readSource: async (value, scope) => { calls.push(`source:${value.name}:${scope}`); return [reference()]; },
    readImage: async value => { calls.push(`image:${value.name}`); return { record: physical({ hardwareId: "MTR-001" }), assisted: false }; },
    assistImage: async (_value, observed) => { calls.push("assist"); return observed; },
    needsAssistance: () => true, allowAssistance: false, maxAssistedImages: 2, ...change,
  });
  return { run, calls };
}

test("recognized structured Excel preserves rows, leading zeros and raw identifiers", () => {
  const result = parseComparisonTable({ ...source, content: JSON.stringify([{ Component: "MONITOR", Description: "ACER", "Hardware ID": "001-A", "Serial No.": "00012" }, { Component: "" }]) });
  assert.equal(result?.length, 1); assert.equal(result?.[0].hardwareId, "001-A"); assert.equal(result?.[0].serial, "00012");
});
test("PDF text, ambiguous S/N columns and unsupported critical headers require complete source reading", () => {
  assert.equal(parseComparisonTable({ ...source, kind: "pdf" }), null);
  for (const row of [{ Component: "MONITOR", "S/N": "123" }, { Component: "MONITOR", "S / N": "123" }, { Component: "MONITOR", "HW ID": "123" }, { Component: "MONITOR", "Property Number": "123" }, { Component: "MONITOR", "Serial ID": "123" }]) assert.equal(parseComparisonTable({ ...source, content: JSON.stringify([row]) }), null);
  for (const content of ["bad json", "{}", "[]", '[{"Component":""}]']) assert.equal(parseComparisonTable({ ...source, content }), null);
});
test("missing physical fields remain blank rather than inheriting document values", () => {
  const [result] = comparePhysicalEvidence([reference()], [physical({ hardwareId: "MTR-001" })]);
  assert.equal(result.img.hardwareId, "MTR-001"); assert.equal(result.img.serial, ""); assert.equal(result.img.description, ""); assert.equal(result.img.components, ""); assert.equal(result.status, "mismatch");
});
test("reversed photos are associated by same-field identifiers", () => {
  const results = comparePhysicalEvidence([reference(), reference({ sn: "2", hardwareId: "MTR-002", serial: "SERIAL002" })], [physical({ hardwareId: "MTR-002", serial: "SERIAL002" }), physical({ hardwareId: "MTR-001", serial: "SERIAL001" })]);
  assert.equal(results[0].img.serial, "SERIAL001"); assert.equal(results[1].img.serial, "SERIAL002");
});
test("identical monitor models do not select the first of two units", () => {
  const results = comparePhysicalEvidence([reference(), reference({ hardwareId: "MTR-002", serial: "SERIAL002" })], [physical({ components: "MONITOR", description: "ACER K222HQL" })]);
  assert.equal(results.length, 3); assert.equal(results[0].status, "missing"); assert.equal(results[1].status, "missing"); assert.match(results[2].notes || "", /more than one/); assert.equal(results[2].doc.hardwareId, "");
});
test("crossed hardware and serial anchors retain the mismatching serial and review note", () => {
  const results = comparePhysicalEvidence([reference(), reference({ hardwareId: "MTR-002", serial: "SERIAL002" })], [physical({ hardwareId: "MTR-001", serial: "SERIAL002" })]);
  assert.equal(results[0].img.serial, "SERIAL002"); assert.ok(results[0].mismatchedFields.includes("serial")); assert.match(results[0].notes || "", /different document rows/);
});
test("conflicting labels remain blank with candidate values in field notes", () => {
  const [result] = comparePhysicalEvidence([reference()], [physical({ hardwareId: "MTR-001", serial: "WRONG-A" }), physical({ hardwareId: "MTR-001", serial: "WRONG-B" })]);
  assert.equal(result.img.serial, ""); assert.match(result.fieldNotes?.serial || "", /WRONG-A.*WRONG-B/); assert.notEqual(result.status, "match");
});
test("manufacturer S/N from another anchored label outranks SNID fallback", () => {
  const [result] = comparePhysicalEvidence([reference()], [physical({ hardwareId: "MTR-001", serial: "123456789", notes: "SNID fallback: no manufacturer S/N was read." }), physical({ hardwareId: "MTR-001", serial: "SERIAL001", notes: "Manufacturer S/N label read." })]);
  assert.equal(result.img.serial, "SERIAL001"); assert.doesNotMatch(result.notes || "", /SNID fallback/);
});
test("complementary anchored photos combine physical labels without filling remaining blanks", () => {
  const [result] = comparePhysicalEvidence([reference()], [physical({ hardwareId: "MTR-001", description: "ACER" }), physical({ serial: "SERIAL001", description: "ACER K222HQL" })]);
  assert.equal(result.img.hardwareId, "MTR-001"); assert.equal(result.img.serial, "SERIAL001"); assert.equal(result.img.description, "ACER K222HQL"); assert.equal(result.img.components, "");
});
test("brand-only photos and unknown serials stay unassigned and preserve readable values", () => {
  const results = comparePhysicalEvidence([reference()], [physical({ components: "MONITOR", description: "ACER", serial: "UNKNOWN" })]);
  assert.equal(results[0].status, "missing"); assert.equal(results[1].img.serial, "UNKNOWN"); assert.equal(results[1].doc.serial, "");
});
test("unique readable type/model association has an explicit physical-unit review note", () => {
  const [result] = comparePhysicalEvidence([reference()], [physical({ components: "LCD", description: "K222HQL" })]);
  assert.equal(result.img.serial, ""); assert.match(result.notes || "", /confirm this is the intended physical unit/);
});
test("matching does not mutate caller records or arrays", () => {
  const expected = [reference()], observed = [physical({ hardwareId: "MTR-001" })]; const before = JSON.stringify({ expected, observed });
  expected.forEach(Object.freeze); observed.forEach(Object.freeze); Object.freeze(expected); Object.freeze(observed);
  comparePhysicalEvidence(expected, observed); assert.equal(JSON.stringify({ expected, observed }), before);
});
test("seven photos publish progress without exceeding the two-photo assistance allowance", async () => {
  const { run, calls } = fixture({ allowAssistance: true }); const progress: any[] = [];
  const results = await run(source, Array.from({ length: 7 }, (_, index) => file(index + 1)), { employeeId: "owner", onProgress: p => progress.push(p) });
  assert.equal(calls.filter(c => c.startsWith("image:")).length, 7); assert.equal(calls.filter(c => c === "assist").length, 2);
  assert.equal(progress.at(-1).stage, "matching"); assert.equal(progress.at(-1).completed, 7); assert.ok(calls.includes("source:reference.xlsx:owner")); assert.equal(results[0].img.serial, "");
});
test("exact duplicate image bytes are read once even when renamed", async () => {
  const { run, calls } = fixture(); await run(source, [file(1), { ...file(1), name: "renamed.jpg" }]);
  assert.equal(calls.filter(c => c.startsWith("image:")).length, 1);
});
test("local-only mode and cached assisted observations make no assistance calls", async () => {
  for (const change of [{ allowAssistance: false }, { allowAssistance: true, readImage: async () => ({ record: physical({ hardwareId: "MTR-001" }), assisted: true }) }]) {
    const { run, calls } = fixture(change); await run(source, [file()]); assert.ok(!calls.includes("assist"));
  }
});
test("failed cloud assistance retains physical values and does not mutate a cached observation", async () => {
  const observation = Object.freeze({ record: Object.freeze(physical({ hardwareId: "MTR-001" })), assisted: false });
  const { run } = fixture({ allowAssistance: true, readImage: async () => observation, assistImage: async () => { throw new Error("quota"); } });
  const [result] = await run(source, [file()]); assert.equal(result.img.hardwareId, "MTR-001"); assert.equal(result.img.serial, ""); assert.match(result.notes || "", /budget was unavailable/); assert.equal(observation.record.notes, undefined);
});
test("unreadable images are named for review rather than fabricated", async () => {
  const { run } = fixture({ readImage: async () => { throw new Error("OCR failed"); } }); const [result] = await run(source, [file()]);
  assert.equal(result.status, "missing"); assert.match(result.notes || "", /Unreadable evidence: photo-1.jpg/);
});
test("non-image evidence is read independently and its Remarks are not physical evidence", async () => {
  const { run, calls } = fixture(); const [result] = await run(source, [file(1, { kind: "pdf" })]);
  assert.equal(calls.filter(c => c.startsWith("source:")).length, 2); assert.equal(result.status, "match"); assert.equal(result.img.remarks, ""); assert.ok(!calls.includes("assist"));
});
test("one active comparison rejects a second and cancellation stops further reads", async () => {
  let release!: () => void, entered!: () => void, cancelled = false, reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }); const begun = new Promise<void>(resolve => { entered = resolve; });
  const { run } = fixture({ readImage: async () => { reads++; entered(); await gate; return { record: physical() }; } });
  const pending = run(source, [file(1), file(2)], { isCancelled: () => cancelled }); await begun;
  await assert.rejects(run(source, [file()]), { status: 503 }); cancelled = true; release(); await assert.rejects(pending, { status: 499 }); assert.equal(reads, 1);
  cancelled = false; await run(source, [file()]);
});
test("overall deadline stops later stages and frees the comparison slot", async () => {
  let now = 0; const { run, calls } = fixture({ now: () => now, timeoutMs: 50, readSource: async () => { now += 100; return [reference()]; } });
  await assert.rejects(run(source, [file()]), { status: 504 }); assert.equal(calls.length, 0); await assert.rejects(run(source, [file()]), { status: 504 });
});
test("source failure is explicit and the next request can run", async () => {
  let attempt = 0; const { run } = fixture({ readSource: async () => { if (++attempt === 1) throw new Error("source unreadable"); return [reference()]; } });
  await assert.rejects(run(source, [file()]), /source unreadable/); await run(source, [file()]);
});
test("missing, empty, unsupported and excessive files are rejected before source work", async () => {
  const { run, calls } = fixture();
  for (const files of [[], Array.from({ length: 21 }, (_, i) => file(i)), [file(1, { content: "" })], [file(1, { kind: "unsupported" })]]) await assert.rejects(run(source, files), { status: 400 });
  assert.equal(calls.length, 0);
});
