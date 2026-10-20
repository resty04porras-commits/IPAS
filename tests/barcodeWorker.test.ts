import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBarcodeWorker } from "../services/ocr/barcodeWorker.js";
import { createOcrHttpClient } from "../services/ocr/httpClient.js";
import type { OcrSourceFile } from "../types/ocr.js";

type Dependencies = Parameters<typeof createBarcodeWorker>[0];
type Settings = { payload?: unknown; raw?: string; stderr?: string; exitCode?: number; hang?: boolean; echoBarcode?: boolean; split?: boolean; delayMs?: number };
const image: OcrSourceFile = { name: "label with spaces.png", kind: "image", contentType: "inlineData",
  content: Buffer.from([0, 1, 9, 128, 255]).toString("base64"), mimeType: "image/png" };
const logger = { log() {}, warn() {} };
const fixtureScript = `
  const settings = JSON.parse(process.argv[1]);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const request = JSON.parse(input);
    console.error('fixture-input:'+JSON.stringify(request));
    if (settings.stderr) console.error(settings.stderr);
    if (settings.hang) { setInterval(() => {}, 1000); return; }
    const payload = settings.echoBarcode ? {success:true,barcode:request.imageBase64} : settings.payload ?? {success:true,barcode:'LOCAL-CODE'};
    const output = settings.raw === undefined ? JSON.stringify(payload) : settings.raw;
    setTimeout(() => {
      if (settings.split) {
        const half = Math.floor(output.length/2);
        process.stdout.write(output.slice(0,half));
        setTimeout(() => process.stdout.write(output.slice(half), () => process.exit(settings.exitCode || 0)),10);
      } else process.stdout.write(output, () => process.exit(settings.exitCode || 0));
    },settings.delayMs || 0);
  });
`;

function fixture(t: TestContext, settings: (launch: number) => Settings = () => ({}), overrides: Partial<Dependencies> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ipas-barcode-worker-test-"));
  const children: ChildProcessWithoutNullStreams[] = [];
  const launches: Array<{ command: string; args: string[]; options: any }> = [];
  const inputs: any[] = [], messages: string[] = [];
  const worker = createBarcodeWorker({ workerScriptPath: path.join(directory, "barcode_scan_worker.py"),
    serviceDirectory: path.join(directory, "ocr-service"), timeoutMs: 3000, describeError: (error) => error instanceof Error ? error.message : String(error),
    logger: { log(...values) { messages.push(values.join(" ")); } },
    spawnProcess(command, args, options) {
      launches.push({ command, args, options });
      const child = spawn(process.execPath, ["-e", fixtureScript, JSON.stringify(settings(launches.length))], options);
      children.push(child);
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", () => {
        for (const line of stderr.split("\n")) {
          if (line.startsWith("fixture-input:")) inputs.push(JSON.parse(line.slice(14)));
        }
      });
      return child;
    }, ...overrides });
  t.after(async () => {
    for (const child of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGKILL"); await closed;
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { worker, children, launches, inputs, messages, directory };
}

test("creating a barcode worker and passing unsupported inputs starts no child", async (t) => {
  const { worker, launches } = fixture(t);
  for (const file of [{ ...image, kind: "pdf" as const }, { ...image, kind: "excel" as const }, { ...image, contentType: "text" as const }]) {
    assert.deepEqual(await worker.scan(file), { success: false, barcode: null, matched: false, record: null,
      message: "Barcode scan accepts image files only." });
  }
  assert.equal(launches.length, 0);
});

test("one-shot input preserves base64, MIME, Python arguments, and UTF-8 environment", async (t) => {
  const { worker, launches, inputs, directory, messages } = fixture(t);
  const result = await worker.scan(image);
  assert.equal(result.barcode, "LOCAL-CODE");
  assert.deepEqual(inputs, [{ imageBase64: image.content, mimeType: image.mimeType }]);
  assert.deepEqual(launches[0].args, ["-u", path.join(directory, "barcode_scan_worker.py")]);
  assert.deepEqual(launches[0].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(launches[0].options.env.PYTHONIOENCODING, "utf-8");
  assert.equal(launches[0].options.env.PYTHONUTF8, "1");
  assert.equal(launches[0].options.env.PYTHONNOUSERSITE, "1");
  assert.ok(messages.some((line) => line.includes('engine=opencv-worker file="label with spaces.png" detected=true')));
});

test("candidate values, types, and points are preserved without claiming a database match", async (t) => {
  const barcodes = [{ value: "SERIAL-001", type: "CODE_128", points: [[1, 2], [3, 4]] }, { value: "4713883585477", type: "EAN_13" }];
  const payload = { success: true, barcode: "  SERIAL-001  ", type: "CODE_128", message: "Decoded fixture",
    barcodes, matched: true, record: { invented: true }, engine: "unverified", durationMs: 999 };
  const result = await fixture(t, () => ({ payload })).worker.scan(image);
  assert.deepEqual(result, { success: true, barcode: "SERIAL-001", type: "CODE_128", message: "Decoded fixture",
    barcodes, matched: false, record: null });
});

test("normalization retains default messages and valid empty barcode results", async (t) => {
  const cases = [
    { payload: { success: false, barcode: "   ", type: 1, barcodes: {} }, barcode: null, message: "No barcode detected. Please capture a clearer image." },
    { payload: { success: true, barcode: "ABC", message: 123 }, barcode: "ABC", message: "Barcode detected." },
    { payload: { barcode: 123, message: "No usable barcode" }, barcode: null, message: "No usable barcode" },
  ];
  for (const { payload, barcode, message } of cases) {
    const result = await fixture(t, () => ({ payload })).worker.scan(image);
    assert.equal(result.barcode, barcode);
    assert.equal(result.message, message);
    assert.deepEqual(result.barcodes, []);
    assert.equal(result.type, null);
  }
});

test("fragmented stdout is accumulated until close before JSON parsing", async (t) => {
  const payload = { success: true, barcode: "FRAGMENTED-CODE", message: "Complete output" };
  const result = await fixture(t, () => ({ payload, split: true })).worker.scan(image);
  assert.equal(result.barcode, "FRAGMENTED-CODE");
  assert.equal(result.message, "Complete output");
});

test("a valid worker failure payload from a nonzero exit retains its failure message", async (t) => {
  const payload = { success: false, barcode: null, type: null, message: "ValueError: damaged image" };
  const result = await fixture(t, () => ({ payload, exitCode: 1 })).worker.scan(image);
  assert.equal(result.success, false);
  assert.equal(result.barcode, null);
  assert.equal(result.message, payload.message);
});

test("malformed JSON rejects with parse diagnostics instead of becoming a blank successful scan", async (t) => {
  await assert.rejects(fixture(t, () => ({ raw: "not JSON", stderr: "decoder diagnostic" })).worker.scan(image),
    /Could not parse barcode worker output[\s\S]*decoder diagnostic/);
});

test("empty stdout reports worker stderr instead of a success payload", async (t) => {
  await assert.rejects(fixture(t, () => ({ raw: "", stderr: "decoder could not initialize", exitCode: 4 })).worker.scan(image),
    /decoder could not initialize/);
});

test("empty stdout with no diagnostic preserves the exit-code error", async (t) => {
  // The fixture input trace is intentionally filtered out for this exact empty-stderr case.
  const worker = createBarcodeWorker({ workerScriptPath: "unused.py", serviceDirectory: os.tmpdir(), timeoutMs: 3000,
    describeError: String, logger, spawnProcess(_command, _args, options) {
      return spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end',()=>process.exit(4))"], options);
    } });
  await assert.rejects(worker.scan(image), /Barcode worker exited with code 4/);
});

test("missing Python executable rejects its original process error", async () => {
  const worker = createBarcodeWorker({ workerScriptPath: "unused.py", serviceDirectory: os.tmpdir(), timeoutMs: 3000,
    describeError: String, logger, spawnProcess(_command, args, options) {
      return spawn(path.join(os.tmpdir(), "ipas-no-such-barcode-python"), args, options);
    } });
  await assert.rejects(worker.scan(image), /ENOENT/);
});

test("explicit timeout kills a stalled child and rejects the scan", async (t) => {
  const { worker, children } = fixture(t, () => ({ hang: true }));
  await assert.rejects(worker.scan(image, 150), /Barcode scan timed out after 0 seconds/);
  const [, signal] = await once(children[0], "close");
  assert.equal(signal, "SIGKILL");
});

test("default timeout applies when the caller provides no override", async (t) => {
  const { worker } = fixture(t, () => ({ hang: true }), { timeoutMs: 150 });
  await assert.rejects(worker.scan(image), /Barcode scan timed out after 0 seconds/);
});

test("concurrent scans use independent one-shot processes and retain their own results", async (t) => {
  const { worker, launches } = fixture(t, (launch) => ({ echoBarcode: true, delayMs: (5 - launch) * 20 }));
  const files = Array.from({ length: 4 }, (_, index) => ({ ...image, content: Buffer.from(`IMAGE-${index}`).toString("base64") }));
  const results = await Promise.all(files.map((file) => worker.scan(file)));
  assert.deepEqual(results.map((result) => result.barcode), files.map((file) => file.content));
  assert.equal(launches.length, 4);
});

test("Python selection preserves BARCODE override, PADDLE fallback, platform venv, and system fallback", async (t) => {
  const barcodePython = process.env.BARCODE_SCAN_PYTHON, paddlePython = process.env.PADDLE_OCR_PYTHON;
  t.after(() => {
    if (barcodePython === undefined) delete process.env.BARCODE_SCAN_PYTHON; else process.env.BARCODE_SCAN_PYTHON = barcodePython;
    if (paddlePython === undefined) delete process.env.PADDLE_OCR_PYTHON; else process.env.PADDLE_OCR_PYTHON = paddlePython;
  });
  for (const mode of ["barcode", "paddle", "venv", "system"]) {
    const { worker, directory, launches } = fixture(t);
    const python = process.platform === "win32" ? path.join(directory, "ocr-service", ".venv", "Scripts", "python.exe")
      : path.join(directory, "ocr-service", ".venv", "bin", "python");
    delete process.env.BARCODE_SCAN_PYTHON; delete process.env.PADDLE_OCR_PYTHON;
    if (mode === "barcode") { process.env.BARCODE_SCAN_PYTHON = "  barcode-python  "; process.env.PADDLE_OCR_PYTHON = "other-python"; }
    if (mode === "paddle") { process.env.BARCODE_SCAN_PYTHON = "   "; process.env.PADDLE_OCR_PYTHON = "  paddle-python  "; }
    if (mode === "venv") { fs.mkdirSync(path.dirname(python), { recursive: true }); fs.writeFileSync(python, "fixture"); }
    await worker.scan(image);
    assert.equal(launches[0].command, mode === "barcode" ? "barcode-python" : mode === "paddle" ? "paddle-python"
      : mode === "venv" ? python : process.platform === "win32" ? "python" : "python3");
  }
});

test("the existing HTTP client invokes the extracted worker for barcode 404 only", async (t) => {
  let status = 404;
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(status); res.end("missing endpoint"); }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const { worker, launches, inputs } = fixture(t);
  const client = createOcrHttpClient({ serviceUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    timeoutMs: 3000, ensureReady: async () => {}, scanBarcodeLocally: worker.scan, logger });
  const result = await client.requestBarcode(image);
  assert.equal(result.barcode, "LOCAL-CODE");
  assert.equal(launches.length, 1);
  assert.deepEqual(inputs[0], { imageBase64: image.content, mimeType: image.mimeType });
  status = 503;
  await assert.rejects(client.requestBarcode(image), /missing endpoint/);
  assert.equal(launches.length, 1);
});
