import assert from "node:assert/strict";
import test from "node:test";
import { canonicalEquipmentComponent, labeledSerialValues, chooseLabeledSerial, equipmentDescription, applyEquipmentLabelRules, selectMissingFieldProbes } from "../services/equipmentLabels.js";
import { prepareLocalVisionRecord, validateVisionDraft, mergeVisionDraft } from "../services/visionValidation.js";
import { normalizeIntakeRecord } from "../services/intakeNormalization.js";
import { KNOWN_BRANDS } from "../services/intakeConsolidation.js";

const serial = "MMT1LSS00983607E9B4220", snid = "316040967332";
const row = { sourceName: "monitor.jpg", components: "MONITOR", description: "ACER K222HQL", hardwareId: "MTR-2024-171", serial, remarks: "Manual note", notes: "" };
test("CPU/laptop adapters, LAD and chargers share only the Laptop Adapter category", () => {
  for (const value of ["CPU ADAPTER", "cpu adaptor", "Laptop Adapter", "Laptop Adaptor", "LAD", "charger", "Laptop charger", "AC ADAPTER", "POWER ADAPTOR"]) {
    assert.equal(canonicalEquipmentComponent(value), "LAPTOP ADAPTER", value);
    assert.equal(normalizeIntakeRecord({ ...row, components: value }).components, "LAPTOP ADAPTER", value);
  }
  for (const value of ["NETWORK ADAPTER", "USB Adapter", "CPU", "SYSTEM UNIT", "LAPTOP", "Monitor", "Custom Component"]) assert.equal(canonicalEquipmentComponent(value), value);
});
test("explicit S/N wins over SNID independently of their text order", () => {
  for (const text of [`SNID: ${snid}\nS/N: ${serial}`, `S/N: ${serial}\nSNID: ${snid}`, `Serial Number ${serial}\nSNID ${snid}`]) {
    assert.equal(chooseLabeledSerial(text, snid).value, serial);
    assert.equal(chooseLabeledSerial(text, snid).source, "manufacturer");
  }
});
test("S/N and SNID on one line are assigned their own values", () => {
  assert.deepEqual(labeledSerialValues(`S/N: ${serial} SNID: ${snid}`), { manufacturer: [serial], snid: [snid] });
});
test("SNID fallback preserves leading zeroes and does not match the SN prefix inside SNID", () => {
  const text = "SNID,03603241142"; assert.deepEqual(labeledSerialValues(text), { manufacturer: [], snid: ["03603241142"] });
  assert.deepEqual(chooseLabeledSerial(text, ""), { value: "03603241142", source: "snid", conflict: false });
});
test("an unreadable S/N permits an explicitly readable SNID fallback", () => {
  assert.equal(chooseLabeledSerial(`S/N: unreadable\nSNID ${snid}`, "").value, snid);
});
test("an unlabeled product number and a model are never inferred as SNID", () => {
  assert.equal(chooseLabeledSerial("EAN 4713883585477\nModel K222HQL", "").value, "");
  assert.equal(chooseLabeledSerial("SNID K222HQLB", "").value, "");
});
test("conflicting explicit serial labels require review instead of arbitrary selection", () => {
  const value = chooseLabeledSerial(`S/N ${serial}\nS/N MMT1LSS00983607E9B4221`, "");
  assert.equal(value.value, ""); assert.equal(value.conflict, true);
});
test("brand, model on the following line and version become the Description", () => {
  assert.equal(equipmentDescription("ACER\nMODEL NO.\nK222HQL\nVERSION: B", "NO", KNOWN_BRANDS), "ACER K222HQL VERSION B");
});
test("adapter model suffix and visible brand are preserved", () => {
  assert.equal(equipmentDescription("DELTA ELECTRONICS\nMODEL: ADP-65GD D\nINPUT: 100-240V", "ADP-65GD D", KNOWN_BRANDS), "DELTA ADP-65GD D");
});
test("a model-only label remains usable without inventing a brand", () => {
  assert.equal(equipmentDescription("MODEL ADP-65GD D", "", KNOWN_BRANDS), "ADP-65GD D");
});
test("NO and MODEL NO placeholders do not become equipment descriptions", () => {
  for (const value of ["NO", "NO.", "MODEL NO", "MODEL NO."]) assert.equal(equipmentDescription("", value, KNOWN_BRANDS), "");
});
test("S/N, SNID and electrical ratings do not enter labeled model/version text", () => {
  assert.equal(equipmentDescription(`ACER\nMODEL K222HQL S/N ${serial}\nVERSION B INPUT 19V`, "", KNOWN_BRANDS, [serial]), "ACER K222HQL VERSION B");
});
test("applying label rules leaves Hardware ID and manual Remarks unchanged", () => {
  const input = Object.freeze({ ...row, components: "CPU ADAPTER", serial: "", description: "NO" });
  const result = applyEquipmentLabelRules(input, `DELTA\nMODEL ADP-65GD D\nSNID ${snid}`, KNOWN_BRANDS);
  assert.equal(result.components, "LAPTOP ADAPTER"); assert.equal(result.hardwareId, row.hardwareId); assert.equal(result.remarks, "Manual note");
  assert.equal(result.serial, snid); assert.match(result.notes, /SNID fallback/); assert.equal(input.description, "NO");
});
test("fallback annotation is not duplicated on repeated normalization", () => {
  const once = applyEquipmentLabelRules({ ...row, serial: "" }, `SNID ${snid}`, KNOWN_BRANDS);
  const twice = applyEquipmentLabelRules(once, `SNID ${snid}`, KNOWN_BRANDS);
  assert.equal((twice.notes || "").match(/SNID fallback/g)?.length, 1);
});
test("local S/N priority can replace a previously picked SNID", () => {
  const result = prepareLocalVisionRecord({ ...row, serial: snid }, [], `SNID ${snid}\nSerial No. ${serial}`);
  assert.equal(result.serial, serial); assert.doesNotMatch(result.notes || "", /SNID fallback/);
});
test("a manufacturer proposal can replace an OCR SNID fallback", () => {
  const local = { ...row, serial: snid, notes: "SNID fallback: no readable manufacturer S/N was found." };
  const validation = validateVisionDraft({ ...row, serialLabel: "S/N" }, { observedRecord: local, ocrText: `SNID ${snid}` });
  const result = mergeVisionDraft(local, validation); assert.equal(result.record.serial, serial); assert.doesNotMatch(result.record.notes || "", /SNID fallback/);
});
test("Vision SNID cannot displace an independently readable manufacturer S/N", () => {
  const result = validateVisionDraft({ ...row, serial: snid, serialLabel: "SNID" }, { observedRecord: row, ocrText: `S/N ${serial}\nSNID ${snid}` });
  assert.equal(result.proposal.serial, ""); assert.ok(result.issues.some(issue => issue.code === "snid_over_manufacturer"));
});
test("SNID fallback remains allowed when the notes correctly say the manufacturer S/N is unreadable", () => {
  const result = validateVisionDraft({ ...row, serial: snid, serialLabel: "SNID", notes: "Manufacturer serial number is unreadable; SNID fallback used." });
  assert.equal(result.proposal.serial, snid); assert.equal(result.proposal.serialSource, "snid");
});
test("Description may gain a visible version without replacing the observed model", () => {
  const result = mergeVisionDraft(row, validateVisionDraft({ ...row, description: "ACER K222HQL VERSION B", serialLabel: "S/N" }, { observedRecord: row }));
  assert.equal(result.record.description, "ACER K222HQL VERSION B");
  const conflict = mergeVisionDraft(row, validateVisionDraft({ ...row, description: "ACER OTHER123 VERSION B" }, { observedRecord: row }));
  assert.equal(conflict.record.description, row.description);
});
test("already-read field regions and almost identical probe rectangles are skipped", () => {
  const rect = { left: 10, top: 10, width: 100, height: 100 };
  const probes = [{ purpose: "property", rectangle: rect }, { purpose: "label", rectangle: rect },
    { purpose: "serial", rectangle: { ...rect, left: 11 } }, { purpose: "serial", rectangle: { ...rect, top: 300 } }];
  const selected = selectMissingFieldProbes(probes, { hardwareId: "MTR-2024-171", description: "", serial: "" });
  assert.equal(selected.length, 2); assert.equal(selected[0].purpose, "label"); assert.equal(selected[1].rectangle.top, 300);
});
test("brand-only descriptions still request a label probe", () => {
  const probes = [{ purpose: "label", rectangle: { left: 0, top: 0, width: 100, height: 100 } }];
  assert.equal(selectMissingFieldProbes(probes, { hardwareId: "MTR-2024-171", description: "ACER", serial }, KNOWN_BRANDS).length, 1);
});
test("an unlabeled model/version selected by OCR cannot become the Serial field", () => {
  const result = applyEquipmentLabelRules({ ...row, serial: "K222HQLB", description: "ACER" }, "ACER\nMODEL K222HQL\nVERSION B", KNOWN_BRANDS);
  assert.equal(result.serial, ""); assert.equal(result.description, "ACER K222HQL VERSION B");
});
test("a later readable S/N removes the earlier SNID fallback annotation", () => {
  const initial = applyEquipmentLabelRules({ ...row, serial: "" }, `SNID ${snid}`, KNOWN_BRANDS);
  const updated = applyEquipmentLabelRules(initial, `SNID ${snid}\nS/N ${serial}`, KNOWN_BRANDS);
  assert.equal(updated.serial, serial); assert.doesNotMatch(updated.notes || "", /SNID fallback/);
});
test("a shared property/serial crop is read once and remains usable for both fields", () => {
  const rectangle = { left: 0, top: 0, width: 100, height: 100 };
  const probes = [{ purpose: "property", rectangle }, { purpose: "serial", rectangle }];
  const selected = selectMissingFieldProbes(probes, { hardwareId: "", description: "MODEL A123", serial: "" });
  assert.equal(selected.length, 1); assert.equal(selected[0].purpose, "label"); assert.equal(probes[0].purpose, "property");
});
test("an OCR letter in a numeric SNID is left for manual review instead of corrected or presented as S/N", () => {
  const value = "316O40967332";
  const result = prepareLocalVisionRecord({ ...row, serial: value }, [], "SNID: " + value);
  assert.equal(result.serial, ""); assert.match(result.notes || "", /unclear characters/); assert.equal(result.hardwareId, row.hardwareId);
});
