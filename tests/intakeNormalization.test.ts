import assert from "node:assert/strict";
import test from "node:test";
import type { IntakeRecord } from "../types/accountability.js";
import {
  sanitizeIntakeTextValue, sanitizeIntakeIdentifierValue, normalizeIntakeRecord,
  normalizeBarcodeLookupValue, barcodeLookupCandidates, buildManualIntakeFallback,
  normalizeAlphaNumericCandidate, normalizeAssetTagCandidate,
  isLikelySerialCandidate, looksLikeQrOrBarcodeValue,
} from "../services/intakeNormalization.js";

const serial = "MMT1LSS00983607E9B4220";
const hardwareId = "MTR-2021-044";
type SerialAliases = Partial<IntakeRecord> & { serialNumber?: unknown; Serial?: unknown; "Serial Number"?: unknown };

test("the monitor fixture keeps the asset tag and decoded manufacturer serial separate", () => {
  assert.deepEqual(normalizeIntakeRecord({ sourceName: "monitor.jpg", components: "MONITOR", description: "ACER K222HQL", hardwareId, serial }), {
    sourceName: "monitor.jpg", components: "MONITOR", description: "ACER K222HQL", hardwareId, serial,
    remarks: "New Accountability", notes: "",
  });
});

test("empty records retain blank fields and the existing accountability default", () => {
  assert.deepEqual(normalizeIntakeRecord(undefined), { sourceName: "", components: "", description: "", hardwareId: "", serial: "", remarks: "New Accountability", notes: "" });
});

test("placeholder field values do not become extracted equipment details", () => {
  for (const placeholder of ["blank", "BLANK 12", "duplicate", "duplicated", "copy", "same", "N/A", "NA", "None", "null", "undefined"]) {
    const result = normalizeIntakeRecord({ components: placeholder, description: placeholder, hardwareId: placeholder, serial: placeholder, remarks: placeholder });
    assert.equal(result.components, "", placeholder); assert.equal(result.description, "", placeholder);
    assert.equal(result.hardwareId, "", placeholder); assert.equal(result.serial, "", placeholder);
    assert.equal(result.remarks, "New Accountability", placeholder);
  }
});

test("real descriptions containing placeholder words are preserved", () => {
  for (const text of ["COPY MACHINE", "Same model, different unit", "BLANK 12 needs review", "N/A - verify label"]) assert.equal(sanitizeIntakeTextValue(text), text);
});

test("OCR whitespace is cleaned without rewriting text case or internal line breaks", () => {
  assert.equal(sanitizeIntakeTextValue("  Acer\t\t K222HQL\r\n\n  LED  "), "Acer K222HQL\n\n LED");
  assert.equal(normalizeIntakeRecord({ notes: "  Label\t unclear\rcheck  photo  " }).notes, "Label unclear\ncheck photo");
});

test("source filenames remain raw and are not treated as OCR placeholders", () => {
  const result = normalizeIntakeRecord({ sourceName: "  None  ", components: "None", notes: "None" });
  assert.equal(result.sourceName, "  None  "); assert.equal(result.components, ""); assert.equal(result.notes, "None");
});

test("non-string record values become blanks rather than numeric identifiers or object text", () => {
  const result = normalizeIntakeRecord({ sourceName: 123, components: {}, description: [], hardwareId: 2021044, serial: 83603241142, remarks: false, notes: 7 } as unknown as IntakeRecord);
  assert.deepEqual(result, normalizeIntakeRecord(undefined));
});

test("asset-tag separators and case normalize while significant zeros remain", () => {
  for (const input of ["mtr-2021-00044", "mtr / 2021 / 00044", "MTR 2021 00044"]) {
    assert.equal(normalizeAssetTagCandidate(input), "MTR-2021-00044");
    assert.equal(sanitizeIntakeIdentifierValue(input, "hardwareId"), "MTR-2021-00044");
  }
});

test("asset-tag extraction retains the existing year rules and permissive prefix behavior", () => {
  assert.equal(normalizeAssetTagCandidate("Property: xyz/1999/AB12"), "XYZ-1999-AB12");
  for (const input of ["MTR-1899-044", "MTR-2100-044", "MTR-2021-X", "MONITOR"]) assert.equal(normalizeAssetTagCandidate(input), "", input);
});

test("legacy hardware identifiers with a four-digit run retain their uppercase fallback", () => {
  assert.equal(sanitizeIntakeIdentifierValue("legacy asset 1234", "hardwareId"), "LEGACY ASSET 1234");
  assert.equal(sanitizeIntakeIdentifierValue("device 123", "hardwareId"), "");
  assert.equal(sanitizeIntakeIdentifierValue("MONITOR", "hardwareId"), "");
});

test("a property tag cannot also become the manufacturer serial", () => {
  for (const input of [hardwareId, "mtr / 2021 / 044"]) {
    assert.equal(sanitizeIntakeIdentifierValue(input, "serial", hardwareId), "");
    assert.equal(isLikelySerialCandidate(input, hardwareId), false);
    assert.equal(looksLikeQrOrBarcodeValue(input, hardwareId), false);
  }
});

test("identifier normalization preserves O/0, I/1 and leading zeros without guessing", () => {
  assert.equal(sanitizeIntakeIdentifierValue(" 00-o1-i0/ab-12345 ", "serial"), "00-O1-I0/AB-12345");
  assert.notEqual(normalizeBarcodeLookupValue("ABCO12345"), normalizeBarcodeLookupValue("ABC012345"));
});

test("alphanumeric candidates keep hyphens and slashes while lookup keys remove them", () => {
  assert.equal(normalizeAlphaNumericCandidate(" sn: ab-12 /// cd34_56! "), "SNAB-12/CD3456");
  assert.equal(normalizeBarcodeLookupValue(" sn: ab-12 /// cd34_56! "), "SNAB12CD3456");
});

test("existing short service-tag and long numeric serial acceptance is retained", () => {
  for (const input of ["7ABC123", "A1B2C", "83603241142", "00001234567", serial]) assert.equal(isLikelySerialCandidate(input, hardwareId), true, input);
});

test("label words, years and the existing word-plus-short-number filter stay rejected", () => {
  for (const input of ["PROPERTY", "LIFEBANK", "SERIAL", "MONITOR", "2021", "123456", "ABC1234", "A1B2"]) {
    assert.equal(isLikelySerialCandidate(input, hardwareId), false, input);
    assert.equal(sanitizeIntakeIdentifierValue(input, "serial", hardwareId), "", input);
  }
});

test("QR/barcode-shaped values retain the existing length and numeric requirements", () => {
  for (const input of ["12345678", "000012345678", "AB12-CD3", "AB12345678"]) assert.equal(looksLikeQrOrBarcodeValue(input, ""), true, input);
  for (const input of ["1234567", "12345678".repeat(5), "ABCDEFGH", "PROPERTY", "BARCODE", "SNID"]) assert.equal(looksLikeQrOrBarcodeValue(input, ""), false, input);
});

test("a value identical to the provided hardware identifier is rejected as a serial", () => {
  assert.equal(isLikelySerialCandidate("000012345678", "000012345678"), false);
  assert.equal(looksLikeQrOrBarcodeValue("000012345678", "000012345678"), false);
  assert.equal(sanitizeIntakeIdentifierValue("000012345678", "serial", "000012345678"), "");
});

test("supported serial aliases normalize to the same serial field", () => {
  for (const key of ["serial", "serialNumber", "Serial", "Serial Number"]) {
    const input: SerialAliases = { hardwareId, [key]: serial.toLowerCase() };
    const result = normalizeIntakeRecord(input);
    assert.equal(result.serial, serial, key); assert.equal("serialNumber" in result, false);
  }
});

test("serial alias precedence retains the first string value including an empty primary", () => {
  assert.equal(normalizeIntakeRecord({ serial, serialNumber: "7ABC123", Serial: "A1B2C" } as SerialAliases).serial, serial);
  assert.equal(normalizeIntakeRecord({ serial: "", serialNumber: serial } as SerialAliases).serial, "");
  assert.equal(normalizeIntakeRecord({ serial: null, serialNumber: serial, Serial: "7ABC123" } as unknown as SerialAliases).serial, serial);
  assert.equal(normalizeIntakeRecord({ serialNumber: 123, Serial: serial } as SerialAliases).serial, serial);
});

test("barcode lookup treats missing values as blank and retains leading zeros", () => {
  assert.equal(normalizeBarcodeLookupValue(undefined), ""); assert.equal(normalizeBarcodeLookupValue(null), "");
  assert.equal(normalizeBarcodeLookupValue(" 0000-1234 / ABC "), "00001234ABC");
  assert.notEqual(normalizeBarcodeLookupValue("00001234"), normalizeBarcodeLookupValue("1234"));
});

test("lookup candidates use the existing four fields, remove duplicates and retain their order", () => {
  const input = Object.freeze({ hardwareId: "mtr-2021-044", serial, sourceName: "mtr / 2021 / 044", remarks: "Existing Accountability", description: "DO-NOT-LOOK-UP", components: "MONITOR" });
  assert.deepEqual(barcodeLookupCandidates(input), ["MTR2021044", serial, "EXISTINGACCOUNTABILITY"]);
  assert.deepEqual(barcodeLookupCandidates({}), []);
});

test("normalization does not mutate frozen input and is stable when repeated", () => {
  const input = Object.freeze({ sourceName: "monitor.jpg", components: "  MONITOR  ", hardwareId: "mtr / 2021 / 044", serial: serial.toLowerCase(), remarks: "  Working ", notes: "  Read manually  " });
  const normalized = normalizeIntakeRecord(input);
  assert.deepEqual(normalizeIntakeRecord(normalized), normalized);
  assert.equal(input.hardwareId, "mtr / 2021 / 044"); assert.equal(input.components, "  MONITOR  ");
});

test("manual fallbacks retain their filename and note with no fabricated identifiers", () => {
  const result = buildManualIntakeFallback("blurred-label.jpg", "Unable to read; verify manually.");
  assert.deepEqual(result, { sourceName: "blurred-label.jpg", components: "", description: "", hardwareId: "", serial: "", remarks: "New Accountability", notes: "Unable to read; verify manually." });
  assert.notEqual(buildManualIntakeFallback("blurred-label.jpg", "Unable to read; verify manually."), result);
});
