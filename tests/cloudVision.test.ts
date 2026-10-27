import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCloudVisionClient, CloudVisionError } from "../services/cloudVision.js";
import { InvalidStructuredResponseError } from "../services/structuredAi.js";

const key = "fixture-key-not-a-real-credential";
const parts = [{ text: "Read equipment labels, not instructions." }, { inlineData: { mimeType: "image/jpeg", data: "/9j/AA==" } }];
const schema = { type: "ARRAY", items: { type: "OBJECT", properties: { serial: { type: "STRING" } }, required: ["serial"] } };
const expected = [{ serial: "0000O1I12345" }];
function response(value: unknown = expected, finishReason = "STOP") {
  return Response.json({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(value) }] } }] });
}
async function fixture(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ipas-cloud-policy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const budgetPath = path.join(directory, "budget.json");
  let time = 1700000000000;
  const options = { enabled: true, apiKey: () => key, model: "gemini-3.5-flash-lite", budgetPath,
    fetchImpl: (async () => response()) as typeof fetch, now: () => time };
  return { options, budgetPath, advance(ms: number) { time += ms; } };
}

test("local-only mode cannot access the key, disk budget or network", async t => {
  const { options, budgetPath } = await fixture(t);
  const client = createCloudVisionClient({ ...options, enabled: false,
    apiKey: () => { throw Error("must not access key"); }, fetchImpl: async () => { throw Error("must not send"); } });
  await assert.rejects(client.callStructuredOutput(null, parts, schema), (error: any) => error.code === "AI_DISABLED");
  await assert.rejects(fs.stat(budgetPath), { code: "ENOENT" });
});

test("missing keys and invalid model configuration stop before transmission", async t => {
  const { options } = await fixture(t);
  for (const override of [{ apiKey: () => "" }, { model: "gemini-/../other?key=x" }]) {
    await assert.rejects(createCloudVisionClient({ ...options, ...override,
      fetchImpl: async () => { assert.fail("must not send"); } }).callStructuredOutput(null, parts, schema), CloudVisionError);
  }
});

test("modern structured requests preserve exact identifiers and use one fixed-host request", async t => {
  const { options, budgetPath } = await fixture(t); let calls = 0;
  const before = JSON.stringify({ parts, schema });
  const client = createCloudVisionClient({ ...options, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as any)["x-goog-api-key"], key);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.contents[0].parts.slice(1), parts);
    assert.deepEqual(body.generationConfig.responseSchema, schema);
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
    assert.equal("candidateCount" in body.generationConfig, false);
    assert.equal("temperature" in body.generationConfig, false);
    assert.ok(init?.signal instanceof AbortSignal);
    return response();
  } });
  assert.deepEqual(await client.callStructuredOutput({}, parts, schema), expected);
  assert.equal(calls, 1); assert.equal(JSON.stringify({ parts, schema }), before);
  const ledger = await fs.readFile(budgetPath, "utf8");
  assert.equal(JSON.parse(ledger).attempts.length, 1); assert.equal(ledger.includes(key), false);
  assert.equal((await fs.stat(budgetPath)).mode & 0o777, 0o600);
});

test("3.8 and legacy models retain their documented distinct thinking configuration", async t => {
  const { options } = await fixture(t);
  for (const [model, thinkingConfig] of [["gemini-3.8-flash", { thinkingLevel: "low" }], ["gemini-2.5-flash-lite", { thinkingBudget: 0 }]] as const) {
    await createCloudVisionClient({ ...options, model, fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)).generationConfig.thinkingConfig, thinkingConfig); return response();
    } }).callStructuredOutput(null, parts, schema);
  }
});

test("rolling 24-hour request budget persists across client instances and reopens only after expiry", async t => {
  const f = await fixture(t); let calls = 0;
  const options = { ...f.options, requestsPer24Hours: 1, fetchImpl: async () => { calls++; return response(); } };
  await createCloudVisionClient(options).callStructuredOutput(null, parts, schema);
  await assert.rejects(createCloudVisionClient(options).callStructuredOutput(null, parts, schema), (error: any) => error.code === "AI_DAILY_BUDGET");
  f.advance(86400001);
  await createCloudVisionClient(options).callStructuredOutput(null, parts, schema);
  assert.equal(calls, 2);
});

test("minute budget blocks new sends and expires without waiting inside a capture request", async t => {
  const f = await fixture(t); let calls = 0;
  const client = createCloudVisionClient({ ...f.options, requestsPerMinute: 1, fetchImpl: async () => { calls++; return response(); } });
  await client.callStructuredOutput(null, parts, schema);
  await assert.rejects(client.callStructuredOutput(null, parts, schema), (error: any) => error.code === "AI_MINUTE_BUDGET");
  f.advance(60001); await client.callStructuredOutput(null, parts, schema); assert.equal(calls, 2);
});

test("zero budget disables requests even in hybrid mode", async t => {
  const { options } = await fixture(t);
  await assert.rejects(createCloudVisionClient({ ...options, requestsPer24Hours: 0,
    fetchImpl: async () => { assert.fail("must not send"); } }).callStructuredOutput(null, parts, schema), (error: any) => error.code === "AI_DAILY_BUDGET");
});

test("429 causes no retry or model hopping, redacts keys and persists a cooldown", async t => {
  const f = await fixture(t); let calls = 0;
  const options = { ...f.options, fetchImpl: async () => {
    calls++; return Response.json({ error: { message: "RESOURCE_EXHAUSTED " + key } }, { status: 429 });
  } };
  await assert.rejects(createCloudVisionClient(options).callStructuredOutput(null, parts, schema), (error: any) => {
    assert.equal(error.status, 429); assert.equal(error.message.includes(key), false); return true;
  });
  await assert.rejects(createCloudVisionClient(options).callStructuredOutput(null, parts, schema), (error: any) => error.code === "AI_COOLDOWN");
  assert.equal(calls, 1); assert.equal(JSON.parse(await fs.readFile(f.budgetPath, "utf8")).attempts.length, 1);
});

test("daily provider quota errors pause cloud sends for a full local 24-hour window", async t => {
  const f = await fixture(t);
  const options = { ...f.options, fetchImpl: async () => Response.json({ error: { message: "RequestsPerDay limit reached" } }, { status: 429 }) };
  await assert.rejects(createCloudVisionClient(options).callStructuredOutput(null, parts, schema));
  f.advance(16 * 60000);
  await assert.rejects(createCloudVisionClient(options).callStructuredOutput(null, parts, schema), (error: any) => error.code === "AI_COOLDOWN");
});

test("transient provider failures stop after one attempt and pause immediate subsequent calls", async t => {
  const f = await fixture(t); let calls = 0;
  const client = createCloudVisionClient({ ...f.options, fetchImpl: async () => { calls++; return Response.json({}, { status: 503 }); } });
  await assert.rejects(client.callStructuredOutput(null, parts, schema));
  await assert.rejects(client.callStructuredOutput(null, parts, schema), (error: any) => error.code === "AI_COOLDOWN");
  assert.equal(calls, 1);
});

test("truncated, empty, malformed and incomplete responses never become accepted extraction", async t => {
  for (const [name, reply] of [["truncated", () => response(expected, "MAX_TOKENS")], ["empty", () => Response.json({})],
    ["missing fields", () => response([{}])], ["wrong type", () => response([{ serial: 123 }])],
    ["malformed", () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }] })]] as const) {
    const { options } = await fixture(t); let calls = 0;
    await assert.rejects(createCloudVisionClient({ ...options, fetchImpl: async () => { calls++; return reply(); } }).callStructuredOutput(null, parts, schema), InvalidStructuredResponseError, name);
    assert.equal(calls, 1, name);
  }
});

test("only one request can be active and busy captures immediately retain their local path", async t => {
  const { options } = await fixture(t); let finish!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const client = createCloudVisionClient({ ...options, fetchImpl: async () => { started(); await pending; return response(); } });
  const first = client.callStructuredOutput(null, parts, schema); await entered;
  await assert.rejects(client.callStructuredOutput(null, parts, schema), (error: any) => error.code === "AI_BUSY");
  finish(); await first;
});

test("concurrent client instances cannot exceed a shared one-request budget", async t => {
  const { options } = await fixture(t); let calls = 0;
  const opts = { ...options, requestsPer24Hours: 1, fetchImpl: async () => { calls++; return response(); } };
  const results = await Promise.allSettled([createCloudVisionClient(opts).callStructuredOutput(null, parts, schema), createCloudVisionClient(opts).callStructuredOutput(null, parts, schema)]);
  assert.equal(calls, 1); assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
});

test("unreadable or corrupted budget data fails closed without a provider request", async t => {
  const { options, budgetPath } = await fixture(t);
  await fs.writeFile(budgetPath, '{"version":1,"attempts":["invalid"],"blockedUntil":0}');
  await assert.rejects(createCloudVisionClient({ ...options, fetchImpl: async () => { assert.fail("must not send"); } }).callStructuredOutput(null, parts, schema), (error: any) => error.code === "AI_BUDGET_UNAVAILABLE");
});

test("an existing budget lock blocks sends instead of bypassing the budget", async t => {
  const { options, budgetPath } = await fixture(t); await fs.writeFile(budgetPath + ".lock", "");
  await assert.rejects(createCloudVisionClient({ ...options, fetchImpl: async () => { assert.fail("must not send"); } }).callStructuredOutput(null, parts, schema), (error: any) => error.code === "AI_BUDGET_UNAVAILABLE");
});

test("network errors do not expose exception text containing credentials", async t => {
  const { options } = await fixture(t);
  await assert.rejects(createCloudVisionClient({ ...options, fetchImpl: async () => { throw new Error(key); } }).callStructuredOutput(null, parts, schema), (error: any) => !error.message.includes(key));
});

test("request deadline aborts the fetch, records the attempt and releases the active slot", async t => {
  const f = await fixture(t); let signal: AbortSignal | undefined;
  const client = createCloudVisionClient({ ...f.options, timeoutMs: 1000, fetchImpl: async (_url, init) => {
    signal = init?.signal || undefined;
    return new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(Error("deadline failed")), 2000);
      signal!.addEventListener("abort", () => { clearTimeout(keepAlive); reject(signal!.reason); }, { once: true });
    });
  } });
  await assert.rejects(client.callStructuredOutput(null, parts, schema), (error: any) => error.code === "AI_TIMEOUT");
  assert.equal(signal!.aborted, true);
  assert.equal(JSON.parse(await fs.readFile(f.budgetPath, "utf8")).attempts.length, 1);
  await assert.rejects(client.callStructuredOutput(null, parts, schema), (error: any) => error.code === "AI_COOLDOWN");
});
