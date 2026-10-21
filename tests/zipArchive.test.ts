import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import * as XLSX from "xlsx";
import { extractZipEntryBuffer, readZipEntries, writeZipEntries, updateZipEntry } from "../services/zipArchive.js";

// Independent Python zipfile fixtures: stored + deflated members, and a streamed
// archive whose local header defers its sizes to a data descriptor.
const mixed = Buffer.from("UEsDBBQAAAAAAD0bVV0iI14gFwAAABcAAAARAAAAeGwvbWVkaWEvbG9nby5wbmeJUE5HDQoaCmxvZ28tdGVzdC1ieXRlc1BLAwQUAAAACAA9G1VdoespgCIAAAAtAAAAGAAAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbLMpzy/KLs5ITS2xsynJL0nMsTMyNTDQMzWw0YdwbfQRKgBQSwECFAMUAAAAAAA9G1VdIiNeIBcAAAAXAAAAEQAAAAAAAAAAAAAAgAEAAAAAeGwvbWVkaWEvbG9nby5wbmdQSwECFAMUAAAACAA9G1VdoespgCIAAAAtAAAAGAAAAAAAAAAAAAAAgAFGAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sUEsFBgAAAAACAAIAhQAAAJ4AAAAAAA==", "base64");
const descriptor = Buffer.from("UEsDBBQACAAIAD0bVV0AAAAAAAAAAAAAAAAOAAAAZGVzY3JpcHRvci50eHRLSS1OLsosKMkvUkjLrCgpLUoFAFBLBwhbDU7eFAAAABIAAABQSwECFAMUAAgACAA9G1VdWw1O3hQAAAASAAAADgAAAAAAAAAAAAAAgAEAAAAAZGVzY3JpcHRvci50eHRQSwUGAAAAAAEAAQA8AAAAUAAAAAAA", "base64");
const logo = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("logo-test-bytes")]);
const sheetXml = "<worksheet><total>2500.50</total></worksheet>";
const centralStart = (zip: Buffer) => zip.readUInt32LE(zip.length - 6);

function workbook(compression: boolean): Buffer {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["Serial", "Amount"], ["MMT1LSS00983607E9B4220", 2500.5], ["4713883585477", 75.25]]);
  sheet.B4 = { t: "n", f: "SUM(B2:B3)", v: 2575.75 };
  sheet["!ref"] = "A1:B4";
  XLSX.utils.book_append_sheet(book, sheet, "Receipts");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Notes"], ["Keep original identifiers"]]), "Notes");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx", compression });
}

test("independent stored and deflated entries preserve names, order and binary contents", () => {
  const entries = readZipEntries(mixed);
  assert.deepEqual(entries.map(({ name }) => name), ["xl/media/logo.png", "xl/worksheets/sheet1.xml"]);
  assert.deepEqual(entries[0].data, logo);
  assert.equal(entries[1].data.toString(), sheetXml);
});

test("single-entry extraction returns exact logo and worksheet bytes for both supported methods", () => {
  assert.deepEqual(extractZipEntryBuffer(mixed, "xl/media/logo.png"), logo);
  assert.equal(extractZipEntryBuffer(mixed, "xl/worksheets/sheet1.xml")?.toString(), sheetXml);
  assert.equal(extractZipEntryBuffer(mixed, "xl/media/missing.png"), null);
  assert.equal(extractZipEntryBuffer(mixed, "XL/MEDIA/LOGO.PNG"), null);
});

test("workbooks written by the existing XLSX library remain readable after ZIP repacking", () => {
  for (const compression of [false, true]) {
    const original = workbook(compression);
    const entries = readZipEntries(original);
    const restored = writeZipEntries(entries);
    const parsed = XLSX.read(restored, { type: "buffer", cellFormula: true });
    assert.deepEqual(parsed.SheetNames, ["Receipts", "Notes"]);
    assert.equal(parsed.Sheets.Receipts.A2.v, "MMT1LSS00983607E9B4220");
    assert.equal(parsed.Sheets.Receipts.A3.v, "4713883585477");
    assert.equal(parsed.Sheets.Receipts.B2.v, 2500.5);
    assert.equal(parsed.Sheets.Receipts.B4.f, "SUM(B2:B3)");
    assert.equal(parsed.Sheets.Receipts.B4.v, 2575.75);
    assert.deepEqual(readZipEntries(restored), entries);
  }
});

test("written archives retain a known CRC32, matching headers and valid raw deflate data", () => {
  const data = Buffer.from("123456789");
  const result = writeZipEntries([{ name: "checksum.txt", data }]);
  const central = centralStart(result);
  assert.equal(result.readUInt32LE(14), 0xcbf43926);
  assert.equal(result.readUInt32LE(central + 16), 0xcbf43926);
  assert.equal(result.readUInt16LE(8), 8);
  assert.equal(result.readUInt16LE(central + 10), 8);
  assert.equal(result.readUInt32LE(22), 9);
  assert.equal(result.readUInt32LE(central + 24), 9);
  const start = 30 + result.readUInt16LE(26) + result.readUInt16LE(28);
  assert.deepEqual(inflateRawSync(result.subarray(start, start + result.readUInt32LE(18))), data);
});

test("empty archives, empty members and binary content round-trip without losing order", () => {
  assert.deepEqual(readZipEntries(writeZipEntries([])), []);
  const entries = [{ name: "empty.txt", data: Buffer.alloc(0) }, { name: "binary.dat", data: Buffer.from([0, 255, 128, 10, 0]) }];
  assert.deepEqual(readZipEntries(writeZipEntries(entries)), entries);
  assert.deepEqual(extractZipEntryBuffer(writeZipEntries(entries), "empty.txt"), Buffer.alloc(0));
});

test("updating a named member preserves other entries and does not mutate the input list", () => {
  const entries = readZipEntries(mixed);
  const before = entries[1].data.toString();
  let calls = 0;
  const updated = updateZipEntry(entries, "xl/worksheets/sheet1.xml", (data) => {
    calls += 1;
    assert.equal(data.toString(), sheetXml);
    return Buffer.from(data.toString().replace("2500.50", "3000.00"));
  });
  assert.equal(calls, 1);
  assert.equal(entries[1].data.toString(), before);
  assert.equal(updated[0], entries[0]);
  assert.equal(readZipEntries(writeZipEntries(updated))[1].data.toString(), "<worksheet><total>3000.00</total></worksheet>");
});

test("a null updater removes only the matching member and a missing name invokes no updater", () => {
  const entries = readZipEntries(mixed);
  assert.deepEqual(updateZipEntry(entries, "xl/worksheets/sheet1.xml", () => null), [entries[0]]);
  assert.deepEqual(updateZipEntry(entries, "missing.xml", () => { throw new Error("Must not run"); }), entries);
});

test("removing calculation-chain metadata preserves readable workbook values and formulas", () => {
  const entries = [...readZipEntries(workbook(true)), { name: "xl/calcChain.xml", data: Buffer.from("<calcChain/>") }];
  const updated = updateZipEntry(entries, "xl/calcChain.xml", () => null);
  const buffer = writeZipEntries(updated);
  assert.equal(readZipEntries(buffer).some(({ name }) => name === "xl/calcChain.xml"), false);
  const parsed = XLSX.read(buffer, { type: "buffer", cellFormula: true });
  assert.equal(parsed.Sheets.Receipts.B4.f, "SUM(B2:B3)");
  assert.equal(parsed.Sheets.Receipts.B4.v, 2575.75);
});

test("the directory reader retains data-descriptor support and the single-entry helper retains its existing null result", () => {
  assert.deepEqual(readZipEntries(descriptor), [{ name: "descriptor.txt", data: Buffer.from("descriptor fixture") }]);
  assert.equal(extractZipEntryBuffer(descriptor, "descriptor.txt"), null);
});

test("archive comments remain readable through the end-of-directory search", () => {
  const comment = Buffer.from("fixture archive comment");
  const withComment = Buffer.from(mixed);
  withComment.writeUInt16LE(comment.length, withComment.length - 2);
  assert.deepEqual(readZipEntries(Buffer.concat([withComment, comment])), readZipEntries(mixed));
});

test("invalid archives retain the existing missing-directory and corrupt-header errors", () => {
  assert.throws(() => readZipEntries(Buffer.from("not a zip")), /ZIP directory not found/);
  const badDirectory = Buffer.from(mixed);
  badDirectory.writeUInt32LE(0, centralStart(badDirectory));
  assert.throws(() => readZipEntries(badDirectory), /corrupt ZIP central directory/);
  const badLocal = Buffer.from(mixed);
  badLocal.writeUInt32LE(0, 0);
  assert.throws(() => readZipEntries(badLocal), /local ZIP header missing/);
});

test("unsupported compression methods retain an explicit read error and a null single-entry result", () => {
  const unsupported = Buffer.from(mixed);
  unsupported.writeUInt16LE(99, 8);
  unsupported.writeUInt16LE(99, centralStart(unsupported) + 10);
  assert.throws(() => readZipEntries(unsupported), /Unsupported XLSX compression method 99/);
  assert.equal(extractZipEntryBuffer(unsupported, "xl/media/logo.png"), null);
});

test("short buffers and out-of-bounds local member sizes retain a null extraction result", () => {
  assert.equal(extractZipEntryBuffer(Buffer.alloc(29), "logo"), null);
  const badName = Buffer.from(mixed);
  badName.writeUInt16LE(65535, 26);
  assert.equal(extractZipEntryBuffer(badName, "xl/media/logo.png"), null);
  const badSize = Buffer.from(mixed);
  badSize.writeUInt32LE(0xffffffff, 18);
  assert.equal(extractZipEntryBuffer(badSize, "xl/media/logo.png"), null);
});

test("corrupt deflate data propagates failure rather than returning successful bytes", () => {
  const broken = writeZipEntries([{ name: "broken.txt", data: Buffer.from("original payload") }]);
  const start = 30 + broken.readUInt16LE(26);
  broken.fill(255, start, start + broken.readUInt32LE(18));
  assert.throws(() => readZipEntries(broken));
  assert.throws(() => extractZipEntryBuffer(broken, "broken.txt"));
});
