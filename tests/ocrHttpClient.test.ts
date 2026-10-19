import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { createOcrHttpClient } from "../services/ocr/httpClient.js";
import type { OcrSourceFile } from "../types/ocr.js";

const image: OcrSourceFile = {
  name: "label with spaces.png", kind: "image", contentType: "inlineData",
  content: Buffer.from([0, 1, 9, 128, 255]).toString("base64"), mimeType: "image/png",
};
const snapshot = { text: "MODEL SAMPLE-001", confidence: 0.93, width: 640, height: 480,
  lines: [{ text: "MODEL SAMPLE-001", confidence: 0.93, bbox: { x0: 1, y0: 2, x1: 90, y1: 20 }, words: [] }], words: [] };
const logger = { log() {}, warn() {} };
type Handler = (req: Request, res: Response) => void;

async function withService(handler: Handler, check: (url: string) => Promise<void>) {
  const app = express();
  app.post(["/ocr", "/barcode"], multer({ storage: multer.memoryStorage() }).any(), handler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function client(url: string, options: Partial<Parameters<typeof createOcrHttpClient>[0]> = {}) {
  return createOcrHttpClient({ serviceUrl: url, timeoutMs: 3000, ensureReady: async () => {},
    scanBarcodeLocally: async () => { throw new Error("Unexpected local worker call"); }, logger, ...options });
}

test("HTTP OCR preserves filename, MIME type, exact bytes, crop, mode, and normalized snapshot", async () => {
  let ready = false;
  const rectangle = { left: 10, top: 20, width: 300, height: 200 };
  await withService((req, res) => {
    assert.equal(ready, true);
    const uploaded = (req.files as Express.Multer.File[])[0];
    assert.equal(uploaded.originalname, image.name);
    assert.equal(uploaded.mimetype, image.mimeType);
    assert.deepEqual(uploaded.buffer, Buffer.from(image.content, "base64"));
    assert.deepEqual(JSON.parse(req.body.rectangle), rectangle);
    assert.equal(req.body.mode, "probe");
    res.json({ snapshot });
  }, async (url) => {
    const result = await client(url, { ensureReady: async () => { ready = true; } }).requestOcr(image, { rectangle, mode: "probe" });
    assert.equal(result.snapshot?.text, snapshot.text);
    assert.equal(result.snapshot?.confidence, 0.93);
    assert.equal(result.snapshot?.width, 640);
    assert.deepEqual(result.snapshot?.lines[0].bbox, snapshot.lines[0].bbox);
  });
});

test("HTTP OCR retains flat-response compatibility and complete named probe batches", async () => {
  const probes = [{ key: "first", rectangle: { left: 0, top: 0, width: 50, height: 40 } }, { key: "second" }];
  let calls = 0;
  await withService((req, res) => {
    calls++;
    if (calls === 1) {
      assert.equal(req.body.mode, "full");
      res.json(snapshot);
    } else {
      assert.equal(req.body.mode, "probe");
      assert.deepEqual(JSON.parse(req.body.rectangles), probes);
      res.json({ snapshots: { first: snapshot, second: { ...snapshot, text: "SECOND" } } });
    }
  }, async (url) => {
    const transport = client(url);
    assert.equal((await transport.requestOcr(image)).snapshot?.text, snapshot.text);
    const result = await transport.requestOcr(image, { rectangles: probes });
    assert.equal(result.snapshots?.first.text, snapshot.text);
    assert.equal(result.snapshots?.second.text, "SECOND");
  });
});

test("plain text and unsupported barcode inputs do not start a service or a worker", async () => {
  const transport = client("http://127.0.0.1:1", {
    ensureReady: async () => { throw new Error("Unexpected service startup"); },
  });
  const text = { ...image, kind: "excel" as const, contentType: "text" as const, content: "KNOWN TEXT" };
  assert.equal((await transport.requestOcr(text)).snapshot?.text, "KNOWN TEXT");
  assert.deepEqual(await transport.requestBarcode(text), { success: false, barcode: null, matched: false, record: null, message: "Barcode scan accepts image files only." });
  assert.equal((await transport.requestBarcode({ ...image, kind: "pdf" })).success, false);
});

test("service startup failure propagates for the recognizer to handle", async () => {
  const transport = client("http://127.0.0.1:1", { ensureReady: async () => { throw new Error("Startup failed"); } });
  await assert.rejects(transport.requestOcr(image), /Startup failed/);
  await assert.rejects(transport.requestBarcode(image), /Startup failed/);
});

for (const format of ["json-detail", "plain-text", "invalid-json"] as const) {
  test(`HTTP errors preserve upstream messages: ${format}`, async () => {
    await withService((_req, res) => {
      if (format === "json-detail") res.status(503).json({ detail: "Reader busy" });
      else if (format === "plain-text") res.status(502).type("text/plain").send("Upstream offline");
      else res.status(502).type("application/json").send("{");
    }, async (url) => {
      const expected = format === "json-detail" ? /Reader busy/ : format === "plain-text" ? /Upstream offline/ : /OCR service returned 502/;
      await assert.rejects(client(url).requestOcr(image), expected);
      await assert.rejects(client(url).requestBarcode(image), expected);
    });
  });
}

test("a successful HTTP status containing an OCR error still triggers recognizer recovery", async () => {
  await withService((_req, res) => { res.json({ error: "Model execution failed", snapshot }); }, async (url) => {
    await assert.rejects(client(url).requestOcr(image), /Model execution failed/);
  });
});

test("malformed successful OCR JSON is not accepted as a blank scan", async () => {
  await withService((_req, res) => { res.type("application/json").send("{"); }, async (url) => {
    await assert.rejects(client(url).requestOcr(image), SyntaxError);
  });
});

test("barcode transport preserves distinct candidates and engine without claiming a database match", async () => {
  const barcodes = [{ value: "TEST-CODE128", type: "CODE_128", points: [[1, 2], [5, 2], [5, 8], [1, 8]] }, { value: "4713883585477", type: "EAN_13" }];
  await withService((req, res) => {
    assert.equal(req.path, "/barcode");
    assert.equal(req.body.mode, undefined);
    assert.deepEqual((req.files as Express.Multer.File[])[0].buffer, Buffer.from(image.content, "base64"));
    res.json({ success: true, barcode: " TEST-CODE128 ", type: "CODE_128", barcodes,
      raw: { engine: "zxing-cpp" }, durationMs: 123, matched: true, record: { unverified: true } });
  }, async (url) => {
    const result = await client(url).requestBarcode(image);
    assert.equal(result.barcode, "TEST-CODE128");
    assert.deepEqual(result.barcodes, barcodes);
    assert.equal(result.engine, "zxing-cpp");
    assert.equal(result.durationMs, 123);
    assert.equal(result.matched, false);
    assert.equal(result.record, null);
  });
});

test("only barcode HTTP 404 falls back to a local worker with the bounded timeout and original image", async () => {
  let workerCalls = 0;
  await withService((_req, res) => { res.sendStatus(404); }, async (url) => {
    const result = await client(url, { scanBarcodeLocally: async (file, timeoutMs) => {
      workerCalls++;
      assert.deepEqual(file, image);
      assert.equal(timeoutMs, 500);
      return { success: true, barcode: "LOCAL-CODE", matched: false, record: null, message: "Barcode detected." };
    } }).requestBarcode(image, { timeoutMs: 100 });
    assert.equal(result.barcode, "LOCAL-CODE");
    assert.equal(workerCalls, 1);
  });
});

test("a timed-out OCR response body is aborted and reports the existing timeout error", async () => {
  await withService((_req, res) => {
    res.status(200).type("application/json");
    res.flushHeaders();
    setTimeout(() => res.end(JSON.stringify({ snapshot })), 1000).unref();
  }, async (url) => {
    await assert.rejects(client(url, { timeoutMs: 100 }).requestOcr(image), /Python EasyOCR service timed out/);
  });
});

test("barcode timeout does not silently invoke the worker or return a false successful scan", async () => {
  await withService((_req, res) => {
    setTimeout(() => res.json({ success: false, barcode: null }), 1500).unref();
  }, async (url) => {
    await assert.rejects(client(url).requestBarcode(image, { timeoutMs: 500 }), /Barcode scan timed out after 1 seconds/);
  });
});
