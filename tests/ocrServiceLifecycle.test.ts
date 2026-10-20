import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once, type EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOcrServiceLifecycle } from "../services/ocr/serviceLifecycle.js";

type Dependencies = Parameters<typeof createOcrServiceLifecycle>[0];
const logger = { log() {}, warn() {} };
const events = ["exit", "SIGINT", "SIGTERM"] as const;
const processEvents: EventEmitter = process;
const readerScript = `
  const http = require('node:http');
  const port = Number(process.argv.at(-1));
  http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({status:'ok',modelLoaded:true}));
  }).listen(port, '127.0.0.1', () => {
    console.log('reader fixture ready');
    console.error('reader fixture diagnostic');
  });
`;

async function endpoint(t: TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function lifecycle(serviceUrl: string, overrides: Partial<Dependencies> = {}) {
  return createOcrServiceLifecycle({ serviceUrl, serviceDirectory: os.tmpdir(), autoStart: true,
    probeTimeoutMs: 150, startupProbeTimeoutMs: 4000, shouldUseService: () => true,
    appendRotatingLog() {}, describeError: (error) => String(error), logger,
    spawnProcess: () => { throw new Error("Unexpected managed service startup"); }, ...overrides });
}

async function managed(t: TestContext, overrides: Partial<Dependencies> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ipas-ocr-lifecycle-test-"));
  const reservation = http.createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const serviceUrl = `http://127.0.0.1:${port}`;
  const children: ChildProcessWithoutNullStreams[] = [];
  const launches: Array<{ command: string; args: string[]; options: any }> = [];
  const logs: string[] = [];
  const listeners = new Map(events.map((event) => [event, new Set(processEvents.listeners(event))]));
  const service = lifecycle(serviceUrl, { serviceDirectory: directory,
    appendRotatingLog(fileName, message) { assert.equal(fileName, "ocr.log"); logs.push(message); },
    spawnProcess(command, args, options) {
      launches.push({ command, args, options });
      const child = spawn(process.execPath, ["-e", readerScript, "--", args.at(-1)!], options);
      children.push(child);
      return child;
    }, ...overrides });
  t.after(async () => {
    service.stop();
    for (const child of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill();
        await closed;
      }
    }
    for (const event of events) {
      for (const listener of processEvents.listeners(event)) {
        if (!listeners.get(event)!.has(listener)) processEvents.removeListener(event, listener as (...args: any[]) => void);
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { service, children, launches, logs, directory, serviceUrl, port };
}

test("legacy readiness does not probe HTTP or start a Python process", async (t) => {
  let requests = 0;
  const url = await endpoint(t, (_req, res) => { requests++; res.end("{}"); });
  await lifecycle(url, { shouldUseService: () => false }).ensureReady();
  assert.equal(requests, 0);
});

test("health retains status/modelLoaded compatibility and rejects HTTP or malformed failures", async (t) => {
  let body = "{}", status = 200;
  const url = await endpoint(t, (req, res) => {
    assert.equal(req.url, "/health");
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(body);
  });
  const service = lifecycle(url);
  for (const [payload, code, expected] of [
    ['{"status":"ok","modelLoaded":true}', 200, true],
    ['{"status":"ok"}', 200, true],
    ['{"status":"ok","modelLoaded":false}', 200, false],
    ['{"status":"loading"}', 200, false],
    ['{"status":"ok","modelLoaded":true}', 503, false],
    ["{", 200, false], ["null", 200, false],
  ] as const) {
    body = payload; status = code;
    assert.equal(await service.isHealthy(), expected, payload);
  }
});

test("health timeout aborts a stalled response body and permits a later healthy probe", async (t) => {
  let stalled = true;
  const url = await endpoint(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders();
    if (!stalled) res.end('{"status":"ok","modelLoaded":true}');
  });
  const service = lifecycle(url);
  assert.equal(await service.isHealthy(50), false);
  stalled = false;
  assert.equal(await service.isHealthy(), true);
});

test("an already healthy external service is reused without registering process cleanup", async (t) => {
  const url = await endpoint(t, (_req, res) => { res.end('{"status":"ok","modelLoaded":true}'); });
  const before = events.map((event) => process.listenerCount(event));
  const service = lifecycle(url);
  await Promise.all([service.ensureReady(), service.ensureReady()]);
  service.stop();
  assert.deepEqual(events.map((event) => process.listenerCount(event)), before);
  assert.equal(await service.isHealthy(), true);
});

test("unhealthy external service with auto-start disabled reports its existing error", async (t) => {
  const url = await endpoint(t, (_req, res) => { res.writeHead(503); res.end(); });
  await assert.rejects(lifecycle(url, { autoStart: false }).ensureReady(), {
    message: `Python EasyOCR service is not available at ${url}.`,
  });
});

test("concurrent callers share one child with original uvicorn arguments, environment, and logs", async (t) => {
  const fixture = await managed(t);
  const { service, launches, children, logs, directory, port } = fixture;
  await Promise.all(Array.from({ length: 8 }, () => service.ensureReady()));
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].args, ["-m", "uvicorn", "ocr_api:app", "--host", "127.0.0.1", "--port", String(port)]);
  assert.equal(launches[0].options.cwd, directory);
  assert.equal(launches[0].options.env.PYTHONUTF8, "1");
  assert.equal(launches[0].options.windowsHide, true);
  assert.ok(logs.some((line) => /stdout: reader fixture ready/.test(line)));
  assert.ok(logs.some((line) => /stderr: reader fixture diagnostic/.test(line)));
  const exited = once(children[0], "exit");
  service.stop(); await exited;
  await delay(2200);
  assert.equal(launches.length, 1, "intentional stop must not schedule recovery");
});

test("unexpected child exit clears startup state and recovers with one replacement", async (t) => {
  const { service, launches, children } = await managed(t);
  await service.ensureReady();
  const exited = once(children[0], "exit");
  children[0].kill(); await exited;
  for (let attempt = 0; attempt < 50 && launches.length < 2; attempt++) await delay(100);
  assert.equal(launches.length, 2);
  await service.ensureReady();
  assert.equal(await service.isHealthy(), true);
  assert.equal(launches.length, 2);
});

test("a service that never loads its model reaches the original startup timeout", async (t) => {
  const url = await endpoint(t, (_req, res) => { res.end('{"status":"ok","modelLoaded":false}'); });
  const { service } = await managed(t, { serviceUrl: url, startupProbeTimeoutMs: 100 });
  await assert.rejects(service.ensureReady(), /did not become ready within 0 seconds/);
});

test("missing Python executable is logged and readiness fails rather than reporting success", async (t) => {
  const warnings: string[] = [];
  const { service, directory } = await managed(t, {
    startupProbeTimeoutMs: 100, logger: { log() {}, warn(message) { warnings.push(message); } },
    spawnProcess(_command, args, options) {
      return spawn(path.join(os.tmpdir(), "ipas-no-such-python-executable"), args, options);
    },
  });
  assert.ok(directory);
  await assert.rejects(service.ensureReady(), /did not become ready/);
  assert.ok(warnings.some((line) => /failed to start:.*ENOENT/.test(line)));
});

test("Python selection retains configured override, venv candidates, and platform fallback", async (t) => {
  const original = process.env.OCR_SERVICE_PYTHON;
  t.after(() => { if (original === undefined) delete process.env.OCR_SERVICE_PYTHON; else process.env.OCR_SERVICE_PYTHON = original; });
  for (const mode of ["configured", "windows-venv", "posix-venv", "fallback"]) {
    const fixture = await managed(t);
    const windows = path.join(fixture.directory, ".venv", "Scripts", "python.exe");
    const posix = path.join(fixture.directory, ".venv", "bin", "python");
    for (const file of [windows, posix]) {
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "fixture");
    }
    delete process.env.OCR_SERVICE_PYTHON;
    if (mode === "configured") process.env.OCR_SERVICE_PYTHON = "  configured-python  ";
    if (mode === "posix-venv" || mode === "fallback") fs.unlinkSync(windows);
    if (mode === "fallback") fs.unlinkSync(posix);
    await fixture.service.ensureReady();
    const expected = mode === "configured" ? "configured-python" : mode === "windows-venv" ? windows : mode === "posix-venv" ? posix : process.platform === "win32" ? "python" : "python3";
    assert.equal(fixture.launches[0].command, expected);
    fixture.service.stop();
  }
});

test("app exit, SIGINT, and SIGTERM stop the owned child with the existing exit codes", { skip: process.platform === "win32" }, async (t) => {
  const moduleUrl = new URL("../services/ocr/serviceLifecycle.ts", import.meta.url).href;
  for (const [action, expectedCode] of [["exit", 0], ["SIGINT", 130], ["SIGTERM", 143]] as const) {
    await t.test(action, async (t) => {
      const parentScript = `
        import http from 'node:http';
        import { spawn } from 'node:child_process';
        import { once } from 'node:events';
        import { createOcrServiceLifecycle } from ${JSON.stringify(moduleUrl)};
        const reservation = http.createServer().listen(0, '127.0.0.1');
        await once(reservation, 'listening');
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        const service = createOcrServiceLifecycle({
          serviceUrl: 'http://127.0.0.1:'+port, serviceDirectory: process.cwd(),
          autoStart: true, probeTimeoutMs: 150, startupProbeTimeoutMs: 5000,
          shouldUseService: () => true, appendRotatingLog() {}, describeError: String,
          logger: {log() {}, warn() {}},
          spawnProcess(command, args, options) {
            const child = spawn(process.execPath, ['-e', ${JSON.stringify(readerScript)}, '--', args.at(-1)], options);
            console.log('managed-child:'+child.pid);
            return child;
          }
        });
        process.on('message', () => process.exit(0));
        await service.ensureReady();
        console.log('app-ready');
      `;
      const parent = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", parentScript], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let output = "", errors = "";
      parent.stdout.on("data", (chunk) => { output += chunk; });
      parent.stderr.on("data", (chunk) => { errors += chunk; });
      t.after(() => {
        if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
        const pid = Number(output.match(/managed-child:(\d+)/)?.[1]);
        if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      });
      for (let attempt = 0; attempt < 100 && !output.includes("app-ready"); attempt++) {
        assert.equal(parent.exitCode, null, errors);
        await delay(100);
      }
      assert.match(output, /app-ready/, errors);
      const closed = once(parent, "close");
      if (action === "exit") parent.send("exit"); else parent.kill(action);
      const [code, signal] = await closed;
      assert.equal(code, expectedCode, errors);
      assert.equal(signal, null);
      const pid = Number(output.match(/managed-child:(\d+)/)?.[1]);
      assert.ok(pid);
      let running = true;
      for (let attempt = 0; attempt < 30 && running; attempt++) {
        try {
          process.kill(pid, 0);
          // Some container PID 1 processes retain an exited grandchild as a zombie.
          // A zombie has already terminated; kill(pid, 0) alone cannot distinguish it.
          if (process.platform === "linux") {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
            if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) running = false;
          }
          if (running) await delay(100);
        } catch { running = false; }
      }
      assert.equal(running, false, "owned reader must exit when its app exits");
    });
  }
});
