import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildSourceParts, getUploadedCompareMimeType, prepareUploadedFileForComparison } from "../services/uploadedSources.js";
import type { OcrSourceFile } from "../types/ocr.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3ZC5kAAAAASUVORK5CYII=", "base64");
const rows = [{ Component: "MONITOR", Serial: "000123ABC", "Hardware ID": "MTR-2026-001", Amount: 250.5 },
  { Component: "LAPTOP", Serial: "SN987654321", "Hardware ID": "LAP-2026-002", Amount: 0 }];

function workbook(type: "xlsx" | "biff8" = "xlsx"): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), "Equipment");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{ ignored: "SECOND-SHEET" }]), "Other");
  return Buffer.from(XLSX.write(book, { type: "buffer", bookType: type }));
}

async function pdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText("REFERENCE SERIAL 000123ABC", { x: 30, y: 400, font });
  document.addPage().drawText("SECOND PAGE", { x: 30, y: 400, font });
  return Buffer.from(await document.save());
}

async function upload(t: TestContext, originalname: string, bytes: Buffer, mimetype = "application/octet-stream") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ipas-source-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "upload.bin");
  await fs.writeFile(filePath, bytes);
  return { path: filePath, originalname, mimetype, size: bytes.length } as Express.Multer.File;
}

test("MIME fallback retains supported extensions, uppercase filenames, and unknown-file behavior", () => {
  for (const [extension, expected] of [
    ["PDF", "application/pdf"], ["PNG", "image/png"], ["JPG", "image/jpeg"], ["JPEG", "image/jpeg"],
    ["WEBP", "image/webp"], ["BMP", "image/bmp"], ["GIF", "image/gif"],
    ["XLSX", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["XLS", "application/vnd.ms-excel"],
    ["txt", "application/octet-stream"],
  ]) {
    for (const mimetype of ["", "application/octet-stream", " APPLICATION/OCTET-STREAM "]) {
      assert.equal(getUploadedCompareMimeType({ originalname: `label.${extension}`, mimetype } as Express.Multer.File), expected);
    }
  }
});

test("a supplied non-generic MIME type retains its existing precedence and normalization", async (t) => {
  const file = await upload(t, "label.PNG", png, " IMAGE/WEBP ");
  const prepared = await prepareUploadedFileForComparison(file);
  assert.equal(prepared.mimeType, "image/webp");
  assert.equal(prepared.kind, "image");
  assert.deepEqual(Buffer.from(prepared.content, "base64"), png);
});

test("a real multi-page PDF remains complete inline bytes with its original filename", async (t) => {
  const bytes = await pdf();
  const file = await upload(t, "Accountability Form.PDF", bytes);
  const prepared = await prepareUploadedFileForComparison(file);
  assert.deepEqual(prepared, { name: file.originalname, kind: "pdf", contentType: "inlineData", content: bytes.toString("base64"), mimeType: "application/pdf" });
  const restored = await PDFDocument.load(Buffer.from(prepared.content, "base64"));
  assert.equal(restored.getPageCount(), 2);
  assert.deepEqual(await fs.readFile(file.path), bytes, "preparation must not modify the uploaded file");
});

test("PDF MIME recognition works without a PDF extension and retains extension-based classification", async (t) => {
  const bytes = await pdf();
  const mimeOnly = await prepareUploadedFileForComparison(await upload(t, "reference.bin", bytes, "application/pdf"));
  assert.equal(mimeOnly.kind, "pdf");
  assert.deepEqual(Buffer.from(mimeOnly.content, "base64"), bytes);
  // Existing classification checks the .pdf extension even when another MIME was supplied.
  const extension = await prepareUploadedFileForComparison(await upload(t, "reference.pdf", bytes, "image/jpeg"));
  assert.equal(extension.kind, "pdf");
  assert.equal(extension.mimeType, "image/jpeg");
});

test("image bytes and filename remain exact without resizing or re-encoding", async (t) => {
  const file = await upload(t, "Serial label.PNG", png);
  const prepared = await prepareUploadedFileForComparison(file);
  assert.deepEqual(prepared, { name: file.originalname, kind: "image", contentType: "inlineData", content: png.toString("base64"), mimeType: "image/png" });
  assert.deepEqual(await fs.readFile(file.path), png);
});

test("XLSX reads only the existing first sheet and preserves row order, identifiers, and numeric cells", async (t) => {
  const file = await upload(t, "Inventory.XLSX", workbook());
  const prepared = await prepareUploadedFileForComparison(file);
  assert.equal(prepared.name, file.originalname);
  assert.equal(prepared.kind, "excel");
  assert.equal(prepared.contentType, "text");
  assert.equal(prepared.mimeType, "application/json");
  assert.deepEqual(JSON.parse(prepared.content), rows);
  assert.equal(JSON.parse(prepared.content)[0].Serial, "000123ABC");
  assert.ok(!prepared.content.includes("SECOND-SHEET"));
});

test("legacy XLS BIFF workbooks retain the same text source shape", async (t) => {
  const file = await upload(t, "Inventory.xls", workbook("biff8"), "application/vnd.ms-excel");
  const prepared = await prepareUploadedFileForComparison(file);
  assert.equal(prepared.kind, "excel");
  assert.equal(prepared.mimeType, "application/json");
  assert.deepEqual(JSON.parse(prepared.content), rows);
});

test("spreadsheet extension retains precedence over a supplied unrelated MIME type", async (t) => {
  const file = await upload(t, "Inventory.xlsx", workbook(), "image/png");
  assert.deepEqual(JSON.parse((await prepareUploadedFileForComparison(file)).content), rows);
});

test("unsupported files retain the existing explicit error, including MIME-only spreadsheets", async (t) => {
  for (const [name, mimeType, bytes] of [["notes.txt", "text/plain", Buffer.from("UNSUPPORTED")],
    ["workbook.bin", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", workbook()]] as const) {
    const file = await upload(t, name, bytes, mimeType);
    await assert.rejects(prepareUploadedFileForComparison(file), { message: `Unsupported file type: ${name}. Please upload Excel, PDF, or image files.` });
    assert.deepEqual(await fs.readFile(file.path), bytes);
  }
});

test("missing uploaded files propagate filesystem failure instead of returning empty content", async (t) => {
  const file = await upload(t, "label.png", png);
  await fs.unlink(file.path);
  await assert.rejects(prepareUploadedFileForComparison(file), { code: "ENOENT" });
});

test("a truncated real workbook propagates its parsing failure", async (t) => {
  const file = await upload(t, "broken.xlsx", workbook().subarray(0, 30));
  await assert.rejects(prepareUploadedFileForComparison(file), Error);
});

test("mixed source parts preserve labels, input order, text, MIME, and binary base64 without mutation", async (t) => {
  const sources = [await prepareUploadedFileForComparison(await upload(t, "Inventory.xlsx", workbook())),
    await prepareUploadedFileForComparison(await upload(t, "Reference.pdf", await pdf())),
    await prepareUploadedFileForComparison(await upload(t, "Label.png", png))];
  const before = JSON.stringify(sources);
  const parts = buildSourceParts("Evidence", sources);
  assert.deepEqual(parts, [
    { text: "Evidence file 1: Inventory.xlsx (excel)" }, { text: `Evidence extracted text 1:\n${sources[0].content}` },
    { text: "Evidence file 2: Reference.pdf (pdf)" }, { inlineData: { mimeType: "application/pdf", data: sources[1].content } },
    { text: "Evidence file 3: Label.png (image)" }, { inlineData: { mimeType: "image/png", data: sources[2].content } },
  ]);
  assert.equal(JSON.stringify(sources), before);
});

test("empty source lists retain an empty parts array", () => {
  assert.deepEqual(buildSourceParts("Source 1", []), []);
});

test("real disk-backed multipart uploads retain spreadsheet rows and exact PDF/image bytes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ipas-source-multipart-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const app = express();
  app.post("/fixture", multer({ dest: directory }).single("evidence"), async (req, res) => {
    try {
      const prepared = await prepareUploadedFileForComparison(req.file!);
      await fs.unlink(req.file!.path);
      res.json(prepared);
    } catch (error) { res.status(500).json({ error: String(error) }); }
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [name, bytes, kind] of [["Inventory.XLSX", workbook(), "excel"], ["Reference.PDF", await pdf(), "pdf"], ["Label.PNG", png, "image"]] as const) {
    const form = new FormData(); form.append("evidence", new Blob([bytes], { type: "application/octet-stream" }), name);
    const response = await fetch(`${base}/fixture`, { method: "POST", body: form });
    assert.equal(response.status, 200);
    const prepared = await response.json() as OcrSourceFile;
    assert.equal(prepared.kind, kind);
    assert.equal(prepared.name, name);
    if (kind === "excel") assert.deepEqual(JSON.parse(prepared.content), rows);
    else assert.deepEqual(Buffer.from(prepared.content, "base64"), bytes);
  }
  assert.deepEqual(await fs.readdir(directory), []);
});
