import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import multer from "multer";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import type { AccountabilityControllerDependencies } from "../controllers/accountabilityController.js";
import type { ComparisonContext } from "../services/comparisonWorkflow.js";

Object.assign(process.env, { DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "unused_comparison_test", DB_USER: "unused_comparison_test", DB_PASSWORD: "unused-fixture-password" });
const { createAccountabilityController } = await import("../controllers/accountabilityController.js");
const { db } = await import("../database/postgres.js");
after(() => db.end());
const input = { source1: { name: "reference.xlsx" }, source2: [{ name: "photo.jpg" }] };
const result = [{ doc: { serial: "0001" }, img: { serial: "0001" }, status: "match", mismatchedFields: [] }];

async function withApp(run: AccountabilityControllerDependencies["runGeminiComparison"], check: (base: string, directory: string) => Promise<void>, prepareFailure = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ipas-comparison-test-"));
  const supplied = {
    runGeminiComparison: run,
    extractUpstreamErrorMessage: (error: any) => error.message,
    isInvalidStructuredResponse: (error: any) => error.code === "INVALID_STRUCTURED_RESPONSE",
    isGeminiUnavailable: (error: any) => error.status === 503,
    prepareUploadedFileForComparison: async (file: Express.Multer.File) => {
      if (prepareFailure) throw new Error("Unreadable upload");
      return { name: file.originalname, kind: "image", contentType: "inlineData", content: (await readFile(file.path)).toString("base64"), mimeType: file.mimetype };
    },
  };
  const dependencies = new Proxy(supplied, { get(target, key: string) {
    if (key in target) return target[key as keyof typeof target];
    return () => { throw new Error(`Unexpected dependency: ${key}`); };
  } }) as unknown as AccountabilityControllerDependencies;
  const controller = createAccountabilityController(dependencies), app = express();
  app.use(express.json()); app.use((req, _res, next) => { (req as any).session = { user: { employeeId: "fixture-owner" } }; next(); });
  app.post("/api/compare", controller.compare);
  app.post("/api/compare-upload", multer({ dest: directory }).fields([{ name: "source1", maxCount: 1 }, { name: "source2", maxCount: 20 }]), controller.compareUpload);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try { await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, directory); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
}
function post(base: string, streaming = false, change = {}) {
  return fetch(base + "/api/compare", { method: "POST", headers: { "Content-Type": "application/json", Accept: streaming ? "application/x-ndjson" : "application/json" }, body: JSON.stringify(input), ...change });
}
function form(complete = true) { const data = new FormData(); data.append("source1", new Blob(["source"]), "reference.pdf"); if (complete) data.append("source2", new Blob(["photo"]), "photo.jpg"); return data; }
async function cleaned(directory: string) { for (let i = 0; i < 50 && (await readdir(directory)).length; i++) await delay(10); assert.deepEqual(await readdir(directory), []); }

test("legacy JSON retains the original result array and employee scope", async () => {
  await withApp(async (_source, _files, context) => { assert.equal(context?.employeeId, "fixture-owner"); return result; }, async base => {
    const response = await post(base); assert.equal(response.status, 200); assert.deepEqual(await response.json(), result); assert.equal(response.headers.get("Cache-Control"), "no-store");
  });
});
test("stream headers and initial progress arrive before blocked extraction finishes", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await withApp(async (_source, _files, context) => { await gate; context?.onProgress?.({ stage: "evidence", completed: 1, total: 7, message: "Read 1 of 7" }); return result; }, async base => {
    const response = await post(base, true); assert.match(response.headers.get("Content-Type") || "", /ndjson/); assert.equal(response.headers.get("X-Accel-Buffering"), "no");
    const reader = response.body!.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /Preparing the comparison/);
    release(); let text = ""; for (;;) { const item = await reader.read(); if (item.done) break; text += new TextDecoder().decode(item.value); }
    const updates = text.trim().split("\n").map(line => JSON.parse(line)); assert.equal(updates[0].progress.total, 7); assert.deepEqual(updates.at(-1).results, result);
  });
});
test("stream failures are explicit terminal messages instead of malformed successful arrays", async () => {
  await withApp(async () => { throw Object.assign(new Error("budget unavailable"), { status: 429 }); }, async base => {
    const response = await post(base, true); const updates = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(updates.at(-1).stage, "error"); assert.equal(updates.at(-1).status, 429); assert.match(updates.at(-1).error, /budget/); assert.ok(!updates.some(update => update.stage === "final"));
  });
});
test("legacy error codes explain disabled source reading, timeout and incomplete data", async () => {
  for (const [code, status] of [["AI_DISABLED", 503], ["AI_TIMEOUT", 504], ["INVALID_STRUCTURED_RESPONSE", 502]] as const) {
    await withApp(async () => { throw Object.assign(new Error("fixture"), { code }); }, async base => { const response = await post(base); assert.equal(response.status, status); assert.ok((await response.json()).error); });
  }
});
test("local daily/minute budget and cooldown messages are distinct from provider quota", async () => {
  for (const [code, explanation] of [["AI_DAILY_BUDGET", /past 24 hours/], ["AI_MINUTE_BUDGET", /per minute/], ["AI_COOLDOWN", /earlier provider error/]] as const) {
    await withApp(async () => { throw Object.assign(new Error("fixture"), {code,status:429}); }, async base => {
      const response = await post(base,true); const messages = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(messages.at(-1).status,429); assert.match(messages.at(-1).error,explanation); assert.match(messages.at(-1).error,/[Ll]ocal/);
    });
  }
});
test("missing JSON source validation retains HTTP 400 before streaming", async () => {
  await withApp(async () => { throw new Error("must not run"); }, async base => { const response = await post(base, true, { body: "{}" }); assert.equal(response.status, 400); assert.match((await response.json()).error, /missing source files/); });
});
test("multipart success preserves filenames and removes temporary uploads", async () => {
  await withApp(async (source, files) => { assert.equal(source.name, "reference.pdf"); assert.equal(files[0].name, "photo.jpg"); return result; }, async (base, directory) => {
    const response = await fetch(base + "/api/compare-upload", { method: "POST", body: form(), headers: { Accept: "application/x-ndjson" } });
    assert.match(await response.text(), /"stage":"final"/); await cleaned(directory);
  });
});
test("multipart preparation and validation errors also remove uploads", async () => {
  for (const complete of [true, false]) await withApp(async () => result, async (base, directory) => {
    const response = await fetch(base + "/api/compare-upload", { method: "POST", body: form(complete) }); assert.equal(response.status, complete ? 500 : 400); await response.text(); await cleaned(directory);
  }, true);
});
test("disconnect marks context cancelled and multipart files are removed after the current read ends", async () => {
  let context: ComparisonContext | undefined, release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  await withApp(async (_source, _files, received) => { context = received; started(); await gate; return result; }, async (base, directory) => {
    const abort = new AbortController(); const response = await fetch(base + "/api/compare-upload", { method: "POST", body: form(), headers: { Accept: "application/x-ndjson" }, signal: abort.signal });
    await entered; abort.abort(); await response.body!.cancel().catch(() => undefined);
    for (let i = 0; i < 50 && !context?.isCancelled?.(); i++) await delay(10);
    assert.equal(context?.isCancelled?.(), true); release(); await cleaned(directory);
  });
});
