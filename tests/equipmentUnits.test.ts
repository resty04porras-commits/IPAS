import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { EQUIPMENT_TYPES, equipmentCaptureSelection, chooseLabeledSerial } from "../services/equipmentLabels.js";
const sandbox: any = {};
vm.runInNewContext(fs.readFileSync(new URL("../frontend-prebuilt/assets/ipas-equipment-units.js", import.meta.url), "utf8"), sandbox);
const api = sandbox.__ipasEquipmentUnits;
const merge = (rows: any[]) => JSON.parse(JSON.stringify(api.merge(rows)));
const unit = { equipmentType: "Monitor", equipmentUnitId: "unit-11111111-1111-1111-1111-111111111111" };
const row = (value: any = {}) => ({ captureId: "photo-1", components: "MONITOR", description: "", hardwareId: "", serial: "", remarks: "", ...unit, ...value });
const serial = "MMTKSSP0033160A0073W01", snid = "316040967332";

function client() {
  const data = new Map<string,string>([["icc_user", JSON.stringify({ employeeId: "owner" })]]);
  const sandbox: any = { crypto, localStorage: { getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: string) => data.set(key,value) },
    dispatchEvent() {}, CustomEvent: class { constructor(public type: string, public detail: any) {} } };
  vm.runInNewContext(fs.readFileSync(new URL("../frontend-prebuilt/assets/ipas-equipment-units.js", import.meta.url), "utf8"), sandbox);
  return { api: sandbox.__ipasEquipmentUnits, data };
}
test("opening a unit without taking a photo consumes no capture slot or next unit number", () => {
  const { api } = client(); api.remember(unit, true); assert.equal(api.progress(unit).captured, 0);
  const next = api.remember({ ...unit, equipmentUnitId: "unit-22222222-2222-2222-2222-222222222222" }, true);
  assert.equal(next.equipmentUnitNumber, 1);
});
test("an unused selection updates its number when another unit is captured first", () => {
  const { api } = client(); api.remember(unit, true);
  const other = { ...unit, equipmentUnitId: "unit-22222222-2222-2222-2222-222222222222" };
  api.reserveFiles([{}], other);
  assert.equal(api.progress(other).label, "Monitor 1"); assert.equal(api.progress(unit).label, "Monitor 2");
});
test("local and offline photos reserve at most four slots before any server response", () => {
  const { api } = client(); const files = [{},{},{},{}];
  assert.equal(api.reserveFiles(files, unit), true); assert.equal(api.progress(unit).captured, 4);
  assert.equal(api.reserveFiles([{}], unit), false); assert.equal(api.progress(unit).captured, 4);
});
test("a saved-photo acknowledgement replaces its local reservation without double counting", () => {
  const { api } = client(); const file = {}; api.reserveFiles([file], unit);
  api.saved(file, { ...unit, eventId: "event-1", equipmentUnitNumber: 1, equipmentCaptureCount: 1, equipmentCaptureIndex: 1, equipmentProgressVersion: 100 });
  assert.equal(api.progress(unit).captured, 1);
  api.remember({ ...unit, equipmentCaptureCount: 2, equipmentProgressVersion: 200 });
  api.remember({ ...unit, equipmentCaptureCount: 1, equipmentProgressVersion: 100 });
  assert.equal(api.progress(unit).captured, 2);
});
test("same-type local captures show Monitor 1 and Monitor 2 with separate counters", () => {
  const { api } = client(); const next = { ...unit, equipmentUnitId: "unit-22222222-2222-2222-2222-222222222222" };
  api.reserveFiles([{}], unit); api.reserveFiles([{},{}], next);
  assert.equal(api.progress(unit).label, "Monitor 1"); assert.equal(api.progress(next).label, "Monitor 2");
  assert.equal(api.progress(unit).captured, 1); assert.equal(api.progress(next).captured, 2);
});
test("deleting a local preview frees its own slot without changing another unit", () => {
  const { api } = client(); const file = {}; api.reserveFiles([file], unit);
  api.markPreview("blob:photo", api.forFile(file)); api.forgetPreview("blob:photo"); assert.equal(api.progress(unit).captured, 0);
});
test("a late upload acknowledgement from an old account cannot populate the next account", () => {
  const { api, data } = client(); const file = {}; api.reserveFiles([file], unit);
  data.set("icc_user", JSON.stringify({ employeeId: "other" }));
  assert.equal(api.saved(file, { ...unit, eventId: "old-event", equipmentCaptureCount: 1, equipmentProgressVersion: 100 }), false);
  assert.equal(api.progress(unit).captured, 0);
});
test("a duplicate-photo acknowledgement consumes no new slot and keeps its actual saved unit", () => {
  const { api } = client(); const file = {}, next = { ...unit, equipmentUnitId: "unit-22222222-2222-2222-2222-222222222222" };
  api.remember({ ...unit, equipmentCaptureCount: 1, equipmentProgressVersion: 100, equipmentUnitNumber: 1 });
  api.reserveFiles([file], next);
  api.saved(file, { ...unit, duplicate: true, eventId: "already-saved", equipmentCaptureCount: 1, equipmentProgressVersion: 100, equipmentCaptureIndex: 1 });
  assert.equal(api.progress(next).captured, 0); assert.equal(api.progress(unit).captured, 1); assert.equal(api.forFile(file).equipmentUnitId, unit.equipmentUnitId);
});

test("all 20 requested picker categories match the server allowlist", () => {
  assert.deepEqual(Array.from(api.types), Array.from(EQUIPMENT_TYPES)); assert.equal(api.types.length, 20);
});
test("unit metadata requires both a known type and a bounded stable id", () => {
  assert.deepEqual(equipmentCaptureSelection(unit), unit);
  for (const value of [{}, { ...unit, equipmentType: "Tickets" }, { ...unit, equipmentUnitId: "../other" }, { ...unit, equipmentUnitId: "x".repeat(90) }]) {
    assert.equal(equipmentCaptureSelection(value), undefined); assert.equal(api.selection(value), null);
  }
});
test("two labels of an explicitly selected unit produce one complete row", () => {
  const result = merge([row({ hardwareId: "MTR-2024-171" }), row({ captureId: "photo-2", description: "ACER KA222Q HBI", serial, serialSource: "manufacturer" })]);
  assert.equal(result.length, 1); assert.equal(result[0].hardwareId, "MTR-2024-171"); assert.equal(result[0].serial, serial); assert.equal(result[0].description, "ACER KA222Q HBI");
  assert.deepEqual(result[0].captureIds, ["photo-1", "photo-2"]); assert.equal(result[0].remarks, "");
});
test("two different monitors stay separate even when all observed values match", () => {
  const result = merge([row({ serial }), row({ serial, equipmentUnitId: "unit-22222222-2222-2222-2222-222222222222" })]);
  assert.equal(result.length, 2);
});
test("S/N replaces the same-unit SNID regardless of capture order", () => {
  const fallback = row({ serial: snid, serialSource: "snid", notes: "SNID fallback: no readable manufacturer S/N was found." });
  const manufacturer = row({ captureId: "photo-2", serial, serialSource: "manufacturer" });
  for (const records of [[fallback, manufacturer], [manufacturer, fallback]]) {
    const result = merge(records)[0]; assert.equal(result.serial, serial); assert.doesNotMatch(result.notes, /SNID fallback/);
  }
});
test("conflicting S/N values are blank and flagged instead of last-photo overwrite", () => {
  const result = merge([row({ serial, serialSource: "manufacturer" }), row({ serial: "OTHER123456", serialSource: "manufacturer" })])[0];
  assert.equal(result.serial, ""); assert.deepEqual(result.conflicts, ["serial"]); assert.match(result.notes, /Conflicting serial/);
});
test("different property tags in the same selected unit require manual correction", () => {
  const result = merge([row({ hardwareId: "MTR-2024-171" }), row({ hardwareId: "MTR-2024-172" })])[0];
  assert.equal(result.hardwareId, ""); assert.ok(result.conflicts.includes("hardwareId"));
});
test("manual corrections and deliberate empty values win over late reads", () => {
  const manual = row({ serial: "MANUAL12345", description: "", manualFields: ["serial", "description"], manualOrder: 20 });
  const result = merge([manual, row({ serial, serialSource: "manufacturer", description: "OCR MODEL" })])[0];
  assert.equal(result.serial, "MANUAL12345"); assert.equal(result.description, ""); assert.equal(result.remarks, "");
});
test("the latest operator edit wins across multiple photos of one unit", () => {
  const result = merge([row({ remarks: "First", manualFields: ["remarks"], manualOrder: 10 }), row({ remarks: "Later", manualFields: ["remarks"], manualOrder: 20 })])[0];
  assert.equal(result.remarks, "Later");
});
test("CPU Adapter and Laptop Adapter selections share the requested category but never a unit id", () => {
  assert.equal(api.component("CPU Adapter"), "LAPTOP ADAPTER"); assert.equal(api.component("Laptop Adapter"), "LAPTOP ADAPTER");
  assert.equal(api.component("Monitor Adapter"), "MONITOR ADAPTER");
});
test("a brand-only description can gain the model from another label of that unit", () => {
  assert.equal(merge([row({ description: "ACER" }), row({ description: "ACER KA222Q HBI" })])[0].description, "ACER KA222Q HBI");
});
test("unselected legacy photos preserve their existing identifier grouping", () => {
  const old = (values: any) => row({ ...values, equipmentType: undefined, equipmentUnitId: undefined });
  assert.equal(merge([old({ hardwareId: "MTR-2024-171" }), old({ serial })]).length, 2);
});
test("the owner serial is parsed from dotted, spaced, next-line and full-word S/N labels", () => {
  for (const label of ["S/N", "S / N", "S.N.", "SN", "Serial Number", "Serial No."]) {
    for (const separator of [": ", "\n"]) assert.equal(chooseLabeledSerial(`SNID: ${snid}\n${label}${separator}${serial}`, snid).value, serial, label);
  }
});
test("grouping never mutates frozen evidence records or inserts remark defaults", () => {
  const original = Object.freeze(row({ serial })); const records = Object.freeze([original]);
  assert.equal(merge(records as any)[0].serial, serial); assert.equal(original.remarks, "");
});
