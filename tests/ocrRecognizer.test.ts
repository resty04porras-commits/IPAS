import assert from "node:assert/strict";
import test from "node:test";
import { createOcrRecognizer, shouldUseOcrService } from "../services/ocr/recognizer.js";
import { buildPlainTextSnapshot, toOcrSnapshot } from "../services/ocr/snapshots.js";
import type { OcrSourceFile } from "../types/ocr.js";

const image: OcrSourceFile = { name: "asset.png", kind: "image", contentType: "inlineData", content: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" };
const snapshot = { ...buildPlainTextSnapshot("MONITOR\nM-2026-001\nSN ABC123"), width: 640, height: 480, confidence: 0.95 };
const probes = [{ key: "asset", rectangle: { left: 1, top: 2, width: 100, height: 50 } }, { key: "serial" }];
const logger = { log() {}, warn() {} };
const fail = async () => { throw new Error("unexpected engine call"); };

for (const engine of ["easyocr", "paddle", " EasyOCR "]) {
  test(`${engine.trim()}: configured service is primary and the legacy worker stays unused`, async () => {
    const options = { mode: "probe" as const, rectangle: probes[0].rectangle };
    let serviceCalls = 0;
    const recognizer = createOcrRecognizer({ engine, logger, probeTimeoutMs: 15000,
      requestService: async (file, received) => {
        serviceCalls++;
        assert.deepEqual(file, image);
        assert.deepEqual(received, options);
        return { snapshot };
      }, requestWorker: fail,
    });
    assert.equal(await recognizer.recognizeOcrSnapshot(image, options), snapshot);
    assert.equal(serviceCalls, 1);
  });
}

for (const engine of ["legacy", "unrecognized-legacy-compatible-value"]) {
  test(`${engine}: worker mode does not contact the HTTP service`, async () => {
    assert.equal(shouldUseOcrService(engine), false);
    const recognizer = createOcrRecognizer({ engine, logger, probeTimeoutMs: 15000,
      requestService: fail,
      requestWorker: async (request) => {
        assert.deepEqual(request, { imageBase64: image.content, rectangle: undefined, mode: "full" });
        return { snapshot };
      },
    });
    const result = await recognizer.recognizeOcrDetailed(image);
    assert.equal(result.engine, "legacy-worker");
    assert.equal(result.fallback, false);
    assert.equal(result.primaryError, undefined);
  });
}

test("failed service falls back once and returns the successful worker snapshot with diagnostic metadata", async () => {
  const calls: string[] = [];
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000,
    requestService: async () => { calls.push("service"); throw new Error("service timeout"); },
    requestWorker: async () => { calls.push("worker"); return { snapshot }; },
  });
  const result = await recognizer.recognizeOcrDetailed(image);
  assert.deepEqual(calls, ["service", "worker"]);
  assert.equal(result.snapshot, snapshot);
  assert.equal(result.engine, "legacy-worker");
  assert.equal(result.fallback, true);
  assert.equal(result.primaryError, "service timeout");
});

test("both engine failures are reported instead of becoming an empty successful result", async () => {
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000,
    requestService: async () => { throw new Error("service down"); },
    requestWorker: async () => { throw new Error("worker down"); },
  });
  await assert.rejects(recognizer.recognizeOcrSnapshot(image), (error: AggregateError) => {
    assert.equal(error.errors.length, 2);
    assert.match(error.message, /service down/);
    assert.match(error.message, /worker down/);
    return true;
  });
});

test("missing service snapshot triggers recovery, but a valid blank image result does not", async () => {
  let workerCalls = 0;
  const missing = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000,
    requestService: async () => ({}), requestWorker: async () => { workerCalls++; return { snapshot }; },
  });
  assert.equal((await missing.recognizeOcrDetailed(image)).fallback, true);
  assert.equal(workerCalls, 1);
  const blank = buildPlainTextSnapshot("");
  const valid = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000,
    requestService: async () => ({ snapshot: blank }), requestWorker: fail,
  });
  assert.equal(await valid.recognizeOcrSnapshot(image), blank);
});

test("batch requests prefer the configured service and preserve every probe rectangle", async () => {
  const snapshots = { asset: snapshot, serial: snapshot };
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000,
    requestService: async (file, options) => {
      assert.deepEqual(file, image);
      assert.deepEqual(options, { rectangles: probes, mode: "probe" });
      return { snapshots };
    }, requestWorker: fail,
  });
  assert.equal(await recognizer.recognizeOcrSnapshotBatch(image, probes), snapshots);
});

test("an incomplete service batch recovers through the worker with the existing bounded probe options", async () => {
  const snapshots = { asset: snapshot, serial: snapshot };
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 17500,
    requestService: async () => ({ snapshots: { asset: snapshot } }),
    requestWorker: async (request, options) => {
      assert.deepEqual(request, { imageBase64: image.content, rectangles: probes, mode: "probe" });
      assert.deepEqual(options, { timeoutMs: 17500, retries: 0, resetOnTimeout: false });
      return { snapshots };
    },
  });
  assert.equal(await recognizer.recognizeOcrSnapshotBatch(image, probes), snapshots);
});

test("incomplete results from both batch engines fail rather than silently dropping a requested region", async () => {
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000,
    requestService: async () => ({ snapshots: { asset: snapshot } }),
    requestWorker: async () => ({ snapshots: {} }),
  });
  await assert.rejects(recognizer.recognizeOcrSnapshotBatch(image, probes), /Both OCR engines failed/);
});

test("text sources and empty probe requests do not launch an OCR engine", async () => {
  const recognizer = createOcrRecognizer({ engine: "easyocr", logger, probeTimeoutMs: 15000, requestService: fail, requestWorker: fail });
  const text: OcrSourceFile = { ...image, kind: "excel", contentType: "text", content: "  first line\nsecond line  " };
  const result = await recognizer.recognizeOcrDetailed(text);
  assert.equal(result.engine, "text");
  assert.equal(result.snapshot.text, "first line\nsecond line");
  const batch = await recognizer.recognizeOcrSnapshotBatch(text, probes);
  assert.equal(batch.asset.text, result.snapshot.text);
  assert.equal(batch.serial.text, result.snapshot.text);
  assert.deepEqual(await recognizer.recognizeOcrSnapshotBatch(image, []), {});
});

test("snapshot normalization retains confidence, word boxes, and image dimensions", () => {
  const box = { x0: 1, y0: 2, x1: 30, y1: 40 };
  const result = toOcrSnapshot({ text: "  ASSET\r\nCODE  ", confidence: 0.97, width: 100, height: 80,
    lines: [{ text: "  ASSET  ", confidence: 0.97, bbox: box, words: [{ text: "ASSET", confidence: 0.97, bbox: box }] }],
    words: [{ text: "ASSET", confidence: 0.97, bbox: box }],
  });
  assert.equal(result.text, "ASSET\n\nCODE");
  assert.deepEqual(result.lines[0].bbox, box);
  assert.deepEqual(result.lines[0].words[0].bbox, box);
  assert.deepEqual(result.words[0].bbox, box);
  assert.equal(result.confidence, 0.97);
  assert.equal(result.width, 100);
  assert.equal(result.height, 80);
});
