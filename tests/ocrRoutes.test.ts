import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";
import express from "express";
import multer from "multer";
import type { AccountabilityControllerDependencies } from "../controllers/accountabilityController.js";
import { createAccountabilityRoutes } from "../routes/accountabilityRoutes.js";
import { createOcrRecognizer } from "../services/ocr/recognizer.js";
import { buildPlainTextSnapshot } from "../services/ocr/snapshots.js";

Object.assign(process.env, { DB_HOST: "127.0.0.1", DB_NAME: "isolated_ocr_test", DB_USER: "isolated_ocr_test", DB_PASSWORD: "isolated-test-only" });
const { createAccountabilityController } = await import("../controllers/accountabilityController.js");
const { db } = await import("../database/postgres.js");
after(() => db.end());
const snapshot = { ...buildPlainTextSnapshot("MONITOR M-2026-001"), width: 100, height: 80, confidence: 0.95 };
const logger = { log() {}, warn() {} };
const fail = async () => { throw new Error("engine unavailable"); };

async function withOcrApp(
  recognizer: ReturnType<typeof createOcrRecognizer>,
  check: (base: string, uploads: string) => Promise<void>,
  barcode: AccountabilityControllerDependencies["postToPaddleBarcodeService"] = async () => ({
    success: false, barcode: null, matched: false, record: null,
    message: "No barcode detected.", barcodes: [], engine: "opencv",
  }),
) {
  const uploads = await mkdtemp(path.join(os.tmpdir(), "ipas-ocr-route-test-"));
  const upload = multer({ dest: uploads });
  const supplied = {
    upload,
    apiHistory: [],
    buildPlainTextSnapshot,
    recognizeOcrDetailed: recognizer.recognizeOcrDetailed,
    postToPaddleBarcodeService: barcode,
    extractUpstreamErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    prepareUploadedFileForComparison: async (file: Express.Multer.File) => ({
      name: file.originalname,
      kind: file.mimetype.startsWith("image/") ? "image" : "excel",
      contentType: "inlineData",
      content: (await readFile(file.path)).toString("base64"),
      mimeType: file.mimetype,
    }),
  };
  const dependencies = new Proxy(supplied, {
    get(target, name: string) {
      if (name in target) return target[name as keyof typeof target];
      return () => { throw new Error(`Unexpected dependency used: ${name}`); };
    },
  }) as unknown as AccountabilityControllerDependencies;
  const app = express();
  app.use("/api", createAccountabilityRoutes(createAccountabilityController(dependencies)));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, uploads);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(uploads, { recursive: true, force: true });
  }
}

function imageForm(type = "image/png") {
  const form = new FormData();
  form.append("image", new Blob(["synthetic-upload-bytes"], { type }), "example.png");
  return form;
}

async function assertCleaned(directory: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await readdir(directory)).length === 0) return;
    await delay(10);
  }
  assert.deepEqual(await readdir(directory), [], "Temporary uploads should be removed");
}

test("OCR v2 success preserves the response shape, image dimensions, and cleanup", async () => {
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000,
    requestService: async (file) => {
      assert.equal(Buffer.from(file.content, "base64").toString(), "synthetic-upload-bytes");
      return { snapshot };
    }, requestWorker: fail,
  });
  await withOcrApp(recognizer, async (base, uploads) => {
    const response = await fetch(base + "/api/ocr-v2", { method: "POST", body: imageForm() });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.text, snapshot.text);
    assert.equal(result.width, 100);
    assert.equal(result.height, 80);
    assert.deepEqual(result.boundingBoxes, snapshot.lines.map((line) => line.bbox));
    assert.equal(result.raw.engine, "easyocr-service");
    assert.equal(result.raw.fallback, false);
    assert.equal(Object.hasOwn(result, "error"), false);
    await assertCleaned(uploads);
  });
});

test("successful fallback is HTTP 200 without a top-level error that could mark a good scan as failed", async () => {
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000,
    requestService: async () => { throw new Error("service timeout"); }, requestWorker: async () => ({ snapshot }),
  });
  await withOcrApp(recognizer, async (base, uploads) => {
    const response = await fetch(base + "/api/ocr-v2", { method: "POST", body: imageForm() });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.text, snapshot.text);
    assert.equal(result.raw.engine, "legacy-worker");
    assert.equal(result.raw.fallback, true);
    assert.equal(result.raw.primaryError, "service timeout");
    assert.equal(Object.hasOwn(result, "error"), false);
    await assertCleaned(uploads);
  });
});

test("both failed engines keep the HTTP 500 error contract and clean up the uploaded file", async () => {
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000, requestService: fail, requestWorker: fail });
  await withOcrApp(recognizer, async (base, uploads) => {
    const response = await fetch(base + "/api/ocr-v2", { method: "POST", body: imageForm() });
    assert.equal(response.status, 500);
    const result = await response.json();
    assert.match(result.error, /Both OCR engines failed/);
    assert.equal(result.text, "");
    assert.deepEqual(result.lines, []);
    assert.equal(result.snapshot.text, "");
    await assertCleaned(uploads);
  });
});

test("legacy mode applies to OCR v2 as well as the shared extraction helpers", async () => {
  const recognizer = createOcrRecognizer({ engine: "legacy", logger, probeTimeoutMs: 15000, requestService: fail, requestWorker: async () => ({ snapshot }) });
  await withOcrApp(recognizer, async (base) => {
    const response = await fetch(base + "/api/ocr-v2", { method: "POST", body: imageForm() });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.raw.engine, "legacy-worker");
    assert.equal(result.raw.fallback, false);
  });
});

test("missing files and unsupported input retain HTTP 400 without calling either engine", async () => {
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000, requestService: fail, requestWorker: fail });
  await withOcrApp(recognizer, async (base, uploads) => {
    let response = await fetch(base + "/api/ocr-v2", { method: "POST", body: new FormData() });
    assert.equal(response.status, 400);
    response = await fetch(base + "/api/ocr-v2", { method: "POST", body: imageForm("application/octet-stream") });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /image files only/);
    await assertCleaned(uploads);
  });
});

test("decoded candidates enrich OCR without replacing its text, confidence, or field meaning", async () => {
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000,
    requestService: async () => ({ snapshot }), requestWorker: fail });
  const barcodes = [
    { value: "EXAMPLE-SERIAL-001", type: "CODE_128", points: [[1, 2], [8, 2], [8, 6], [1, 6]] },
    { value: "4713883585477", type: "EAN_13" },
  ];
  await withOcrApp(recognizer, async (base, uploads) => {
    const response = await fetch(base + "/api/ocr-v2", { method: "POST", body: imageForm() });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.barcodes, barcodes);
    assert.equal(result.text, snapshot.text);
    assert.equal(result.confidence, snapshot.confidence);
    assert.deepEqual(result.snapshot, snapshot);
    assert.equal(result.raw.barcodeStatus, "decoded");
    assert.equal(result.raw.barcodeEngine, "zxing-cpp");
    assert.equal(Object.hasOwn(result, "serial"), false);
    assert.equal(Object.hasOwn(result, "hardwareId"), false);
    await assertCleaned(uploads);
  }, async (file, options) => {
    assert.equal(options?.timeoutMs, 5000);
    assert.equal(Buffer.from(file.content, "base64").toString(), "synthetic-upload-bytes");
    return { success: true, barcode: barcodes[0].value, type: "CODE_128", matched: false,
      record: null, message: "Barcode detected.", barcodes, engine: "zxing-cpp" };
  });
});

test("optional barcode failure retains successful OCR and temporary-file cleanup", async () => {
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000,
    requestService: async () => ({ snapshot }), requestWorker: fail });
  await withOcrApp(recognizer, async (base, uploads) => {
    const response = await fetch(base + "/api/ocr-v2", { method: "POST", body: imageForm() });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.text, snapshot.text);
    assert.equal(result.confidence, snapshot.confidence);
    assert.deepEqual(result.barcodes, []);
    assert.equal(result.raw.barcodeStatus, "unavailable");
    assert.equal(Object.hasOwn(result, "error"), false);
    await assertCleaned(uploads);
  }, () => { throw new Error("optional barcode reader unavailable"); });
});

test("a decoded barcode cannot disguise OCR engine failure as successful text recognition", async () => {
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000,
    requestService: fail, requestWorker: fail });
  await withOcrApp(recognizer, async (base, uploads) => {
    const response = await fetch(base + "/api/ocr-v2", { method: "POST", body: imageForm() });
    assert.equal(response.status, 500);
    const result = await response.json();
    assert.match(result.error, /Both OCR engines failed/);
    await assertCleaned(uploads);
  }, async () => ({ success: true, barcode: "EXAMPLE-CODE", matched: false, record: null,
    message: "Barcode detected.", engine: "zxing-cpp" }));
});

test("older barcode responses with only a primary value still provide an OCR candidate", async () => {
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000,
    requestService: async () => ({ snapshot }), requestWorker: fail });
  await withOcrApp(recognizer, async (base) => {
    const response = await fetch(base + "/api/ocr-v2", { method: "POST", body: imageForm() });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.barcodes, [{ value: "OLDER-CODE", type: "CODE_128" }]);
    assert.equal(result.raw.barcodeStatus, "decoded");
  }, async () => ({ success: true, barcode: "OLDER-CODE", type: "CODE_128", barcodes: [],
    matched: false, record: null, message: "Barcode detected." }));
});
