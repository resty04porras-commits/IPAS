import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOcrWorkerPool } from "../services/ocr/workerPool.js";
import { createOcrRecognizer } from "../services/ocr/recognizer.js";

type Dependencies = Parameters<typeof createOcrWorkerPool>[0];
type FixtureSettings = { startup?: "error" | "silent"; fragment?: boolean; hangAll?: boolean; ignoreTerm?: boolean };
const logger = { log() {}, warn() {} };
const workerScript = `
  const readline = require('node:readline');
  const settings = JSON.parse(process.argv[1]);
  setInterval(() => {}, 1000);
  if (settings.ignoreTerm) process.on('SIGTERM', () => {});
  const emit = message => process.stdout.write(JSON.stringify(message)+'\\n');
  const snapshot = text => ({text,confidence:'0.9',width:'640',height:'480',
    lines:[{text:'  MODEL\\tSAMPLE  ',confidence:'0.8',bbox:{x0:'1',y0:'2',x1:'30',y1:'40'},words:[]}],words:[]});
  if (settings.startup === 'error') emit({type:'startup_error',error:'fixture model failed to load'});
  else if (settings.startup === 'silent') console.error('fixture startup diagnostic');
  else if (settings.fragment) {
    process.stdout.write('{"type":"rea');
    setTimeout(() => process.stdout.write('dy"}\\n'), 10);
  } else emit({type:'ready'});
  readline.createInterface({input:process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    process.stderr.write('fixture-request:'+JSON.stringify(request)+'\\n');
    let control;
    try { control = JSON.parse(Buffer.from(request.imageBase64,'base64').toString('utf8')); }
    catch { control = {label:'warmup'}; }
    if (control.exit) { console.error('fixture recognition crash'); process.exit(7); }
    if (settings.hangAll || control.hang) return;
    if (control.error) { emit({id:request.id,ok:false,error:control.error}); return; }
    setTimeout(() => {
      if (control.noise) {
        process.stdout.write('fixture non-JSON output\\n');
        emit({id:'unknown-request',ok:true,snapshot:snapshot('unrelated')});
      }
      const detail = {label:control.label,id:request.id,pid:process.pid,mode:request.mode,rectangle:request.rectangle};
      const reply = request.rectangles ? {id:request.id,ok:true,snapshots:Object.fromEntries(
        request.rectangles.map(probe => [probe.key,snapshot(JSON.stringify({...detail,key:probe.key,rectangle:probe.rectangle}))]))}
        : {id:request.id,ok:true,snapshot:snapshot(JSON.stringify(detail))};
      if (settings.fragment) {
        const text = JSON.stringify(reply)+'\\n', middle = Math.floor(text.length/2);
        process.stdout.write(text.slice(0,middle));
        setTimeout(() => process.stdout.write(text.slice(middle)),10);
      } else emit(reply);
    },control.delayMs || 0);
  });
`;

function request(control: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return { imageBase64: Buffer.from(JSON.stringify(control)).toString("base64"), ...options };
}

async function waitFor(condition: () => boolean) {
  for (let count = 0; count < 150 && !condition(); count++) await delay(20);
  assert.ok(condition(), "fixture condition did not become true");
}

function fixture(t: TestContext, overrides: Partial<Dependencies> = {}, settings: (launch: number) => FixtureSettings = () => ({})) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ipas-ocr-worker-test-"));
  const children: ChildProcessWithoutNullStreams[] = [];
  const launches: Array<{ command: string; args: string[]; options: any }> = [];
  const requests: any[] = [], warnings: string[] = [], messages: string[] = [];
  const pool = createOcrWorkerPool({ projectRoot: directory, workerScriptPath: path.join(directory, "worker.py"),
    serviceDirectory: path.join(directory, "ocr-service"), poolSize: 2,
    startupTimeoutMs: 2000, requestTimeoutMs: 2000, retryCount: 1, describeError: String,
    logger: { log(...values) { messages.push(values.join(" ")); }, warn(...values) { warnings.push(values.join(" ")); } },
    spawnProcess(command, args, options) {
      launches.push({ command, args, options });
      const child = spawn(process.execPath, ["-e", workerScript, JSON.stringify(settings(launches.length))], options);
      children.push(child);
      let buffer = "";
      child.stderr.on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (line.startsWith("fixture-request:")) requests.push(JSON.parse(line.slice(16)));
        }
      });
      return child;
    }, ...overrides });
  t.after(async () => {
    pool.reset("fixture cleanup");
    for (const child of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { pool, children, launches, requests, warnings, messages, directory };
}

test("creating an unused pool starts no process", (t) => {
  assert.equal(fixture(t).launches.length, 0);
});

test("worker transport preserves image bytes, crop, mode, startup options, and normalized snapshots", async (t) => {
  const { pool, launches, requests, directory } = fixture(t);
  const rectangle = { left: 10, top: 20, width: 30, height: 40 };
  const input = request({ label: "SERIAL-001" }, { rectangle, mode: "probe" });
  const result = await pool.submit(input);
  const detail = JSON.parse(result.snapshot!.text);
  assert.equal(detail.label, "SERIAL-001");
  assert.equal(detail.mode, "probe");
  assert.deepEqual(detail.rectangle, rectangle);
  assert.equal(result.snapshot?.confidence, 0.9);
  assert.equal(result.snapshot?.width, 640);
  assert.equal(result.snapshot?.lines[0].text, "MODEL SAMPLE");
  assert.deepEqual(result.snapshot?.lines[0].bbox, { x0: 1, y0: 2, x1: 30, y1: 40 });
  assert.equal(requests[0].imageBase64, input.imageBase64);
  assert.deepEqual(launches[0].args, ["-u", path.join(directory, "worker.py")]);
  const env = launches[0].options.env;
  assert.equal(env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK, "True");
  assert.equal(env.PADDLE_PDX_CACHE_HOME, process.env.PADDLE_PDX_CACHE_HOME || path.join(directory, ".paddlex"));
  assert.equal(env.PYTHONIOENCODING, "utf-8");
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONNOUSERSITE, "1");
  const second = await pool.submit(request({ label: "SERIAL-002" }));
  assert.equal(JSON.parse(second.snapshot!.text).pid, detail.pid);
  assert.equal(launches.length, 1);
});

test("fragmented JSON lines and unrelated or malformed output cannot replace a pending result", async (t) => {
  const { pool, warnings } = fixture(t, {}, () => ({ fragment: true }));
  const result = await pool.submit(request({ label: "EXPECTED", noise: true }));
  assert.equal(JSON.parse(result.snapshot!.text).label, "EXPECTED");
  assert.ok(warnings.some((message) => message.includes("Unexpected PaddleOCR worker output")));
});

test("batch probes preserve every key, crop rectangle, and normalized snapshot", async (t) => {
  const { pool, requests } = fixture(t);
  const rectangles = [{ key: "asset", rectangle: { left: 1, top: 2, width: 30, height: 40 } }, { key: "serial" }];
  const result = await pool.submit({ ...request({ label: "BATCH" }), mode: "probe", rectangles });
  assert.deepEqual(requests[0].rectangles, rectangles);
  assert.deepEqual(Object.keys(result.snapshots!), ["asset", "serial"]);
  assert.deepEqual(JSON.parse(result.snapshots!.asset.text).rectangle, rectangles[0].rectangle);
  assert.equal(JSON.parse(result.snapshots!.serial.text).key, "serial");
  assert.equal(result.snapshots!.serial.confidence, 0.9);
});

test("concurrent out-of-order replies remain associated with their original requests", async (t) => {
  const { pool, launches, requests } = fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => pool.submit(
    request({ label: `REQUEST-${index}`, delayMs: (12 - index) * 10 }), { workerSlot: 0 },
  )));
  assert.deepEqual(results.map((result) => JSON.parse(result.snapshot!.text).label), Array.from({ length: 12 }, (_, index) => `REQUEST-${index}`));
  assert.equal(new Set(requests.map((input) => input.id)).size, 12);
  assert.equal(launches.length, 1, "simultaneous startup for one slot must share one child");
});

test("a busy worker opens the next slot and later idle workers are reused", async (t) => {
  const { pool, launches, requests } = fixture(t);
  const slow = pool.submit(request({ label: "SLOW", delayMs: 250 }));
  await waitFor(() => requests.length === 1);
  const fast = await pool.submit(request({ label: "FAST" }));
  const first = await slow;
  assert.notEqual(JSON.parse(first.snapshot!.text).pid, JSON.parse(fast.snapshot!.text).pid);
  assert.equal(launches.length, 2);
  await pool.submit(request({ label: "REUSE" }));
  assert.equal(launches.length, 2);
});

test("explicit worker slot is preserved", async (t) => {
  const { pool, launches } = fixture(t);
  const selected = await pool.submit(request({ label: "SLOT-2" }), { workerSlot: 1 });
  const reused = await pool.submit(request({ label: "REUSED" }));
  assert.equal(JSON.parse(reused.snapshot!.text).pid, JSON.parse(selected.snapshot!.text).pid);
  assert.equal(launches.length, 1);
});

test("startup timeout includes diagnostics and never masquerades as an empty successful scan", async (t) => {
  const { pool, launches } = fixture(t, { startupTimeoutMs: 150 }, () => ({ startup: "silent" }));
  await assert.rejects(pool.submit(request({ label: "NEVER" })), /worker startup timed out.*fixture startup diagnostic/);
  assert.equal(launches.length, 1, "startup errors are not recognition timeout retries");
});

test("startup error rejects the request and leaves the slot available for another worker", async (t) => {
  const { pool, launches } = fixture(t, {}, (launch) => launch === 1 ? { startup: "error" } : {});
  await assert.rejects(pool.submit(request({ label: "FIRST" })), /fixture model failed to load/);
  const result = await pool.submit(request({ label: "RECOVERED" }));
  assert.equal(JSON.parse(result.snapshot!.text).label, "RECOVERED");
  assert.equal(launches.length, 2);
});

test("recognition errors retain their message and do not retry a non-timeout failure", async (t) => {
  const { pool, launches } = fixture(t);
  await assert.rejects(pool.submit(request({ error: "fixture recognition error" })), /fixture recognition error/);
  assert.equal(launches.length, 1);
  assert.equal(JSON.parse((await pool.submit(request({ label: "NEXT" }))).snapshot!.text).label, "NEXT");
});

test("worker exit rejects pending requests with diagnostics and permits a replacement", async (t) => {
  const { pool, launches } = fixture(t);
  await assert.rejects(pool.submit(request({ exit: true })), /exited with code 7[\s\S]*fixture recognition crash/);
  assert.equal(JSON.parse((await pool.submit(request({ label: "REPLACEMENT" }))).snapshot!.text).label, "REPLACEMENT");
  assert.equal(launches.length, 2);
});

test("request timeout resets and retries once without an old child clearing its replacement slot", async (t) => {
  const { pool, launches, warnings } = fixture(t, { requestTimeoutMs: 80 }, (launch) => ({ hangAll: launch === 1 }));
  const result = await pool.submit(request({ label: "RETRIED" }));
  assert.equal(JSON.parse(result.snapshot!.text).label, "RETRIED");
  assert.equal(launches.length, 2);
  assert.ok(warnings.some((message) => message.includes("Retrying EasyOCR request after timeout")));
  await delay(50);
  await pool.submit(request({ label: "REUSED-REPLACEMENT" }));
  assert.equal(launches.length, 2);
});

test("probe timeout with reset disabled retains the worker for later requests", async (t) => {
  const { pool, launches } = fixture(t);
  await assert.rejects(pool.submit(request({ hang: true }), { timeoutMs: 60, retries: 0, resetOnTimeout: false }), /request timed out/);
  assert.equal(JSON.parse((await pool.submit(request({ label: "AFTER-PROBE" }))).snapshot!.text).label, "AFTER-PROBE");
  assert.equal(launches.length, 1);
});

test("permanent recognition timeout stops at the configured retry count", async (t) => {
  const { pool, launches } = fixture(t, { requestTimeoutMs: 60, retryCount: 1 }, () => ({ hangAll: true }));
  await assert.rejects(pool.submit(request({ label: "NEVER" })), /request timed out/);
  assert.equal(launches.length, 2);
});

test("reset rejects pending work and escalates termination for a worker that ignores SIGTERM", { skip: process.platform === "win32" }, async (t) => {
  const { pool, children, requests } = fixture(t, {}, () => ({ ignoreTerm: true }));
  const pending = assert.rejects(pool.submit(request({ hang: true }), { retries: 0 }), /manual pool reset/);
  await waitFor(() => requests.length === 1);
  const closed = once(children[0], "close");
  pool.reset("manual pool reset");
  await pending;
  const [, signal] = await closed;
  assert.equal(signal, "SIGKILL");
});

test("warm-up starts each slot once, primes inference once, and reuses primed workers", async (t) => {
  const original = process.env.DISABLE_PADDLE_OCR;
  t.after(() => { if (original === undefined) delete process.env.DISABLE_PADDLE_OCR; else process.env.DISABLE_PADDLE_OCR = original; });
  delete process.env.DISABLE_PADDLE_OCR;
  const { pool, requests, launches, messages } = fixture(t);
  pool.prewarm(); pool.prewarm();
  await waitFor(() => messages.filter((message) => message.includes("inference warm-up completed")).length === 2);
  assert.equal(launches.length, 2);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((input) => input.mode === "full"));
  assert.ok(requests.every((input) => Buffer.from(input.imageBase64, "base64").subarray(1, 4).toString() === "PNG"));
  const logsBefore = messages.length;
  pool.prewarm();
  await waitFor(() => messages.length >= logsBefore + 2);
  assert.equal(requests.length, 2);
});

test("DISABLE_PADDLE_OCR disables prewarm without changing explicit worker requests", async (t) => {
  const original = process.env.DISABLE_PADDLE_OCR;
  t.after(() => { if (original === undefined) delete process.env.DISABLE_PADDLE_OCR; else process.env.DISABLE_PADDLE_OCR = original; });
  process.env.DISABLE_PADDLE_OCR = "true";
  const { pool, launches } = fixture(t);
  pool.prewarm();
  assert.equal(launches.length, 0);
  await pool.submit(request({ label: "EXPLICIT" }));
  assert.equal(launches.length, 1);
});

test("worker Python selection retains configured override, platform venv, and fallback", async (t) => {
  const original = process.env.PADDLE_OCR_PYTHON;
  t.after(() => { if (original === undefined) delete process.env.PADDLE_OCR_PYTHON; else process.env.PADDLE_OCR_PYTHON = original; });
  for (const mode of ["configured", "venv", "fallback"]) {
    const { pool, directory, launches } = fixture(t);
    const python = process.platform === "win32"
      ? path.join(directory, "ocr-service", ".venv", "Scripts", "python.exe")
      : path.join(directory, "ocr-service", ".venv", "bin", "python");
    delete process.env.PADDLE_OCR_PYTHON;
    if (mode === "configured") process.env.PADDLE_OCR_PYTHON = "  configured-worker-python  ";
    if (mode === "venv") { fs.mkdirSync(path.dirname(python), { recursive: true }); fs.writeFileSync(python, "fixture"); }
    await pool.submit(request({ label: mode }));
    assert.equal(launches[0].command, mode === "configured" ? "configured-worker-python" : mode === "venv" ? python : process.platform === "win32" ? "python" : "python3");
    pool.reset("selection fixture done");
  }
});

test("shared recognizer uses the extracted pool for legacy mode and successful HTTP-service fallback", async (t) => {
  const { pool, launches } = fixture(t);
  for (const engine of ["legacy", "easyocr"]) {
    const recognizer = createOcrRecognizer({ engine, requestWorker: pool.submit, probeTimeoutMs: 1000, logger,
      requestService: async () => { throw new Error(engine === "legacy" ? "unexpected HTTP request" : "fixture HTTP unavailable"); } });
    const result = await recognizer.recognizeOcrDetailed({ name: "fixture.png", kind: "image", contentType: "inlineData",
      mimeType: "image/png", content: request({ label: engine }).imageBase64 });
    assert.equal(result.engine, "legacy-worker");
    assert.equal(result.fallback, engine === "easyocr");
    assert.equal(JSON.parse(result.snapshot.text).label, engine);
    if (engine === "easyocr") assert.equal(result.primaryError, "fixture HTTP unavailable");
  }
  assert.equal(launches.length, 1);
});
