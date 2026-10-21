import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { GoogleGenAI, Type } from "@google/genai";
import {
  createStructuredAiClient, extractUpstreamErrorMessage, InvalidStructuredResponseError,
  isGeminiRateLimit, isGeminiUnavailable, isInvalidStructuredResponse, parseJsonResponse,
} from "../services/structuredAi.js";

const logger = { warn() {} };
const parts = [{ text: "Read the exact serial." }, { inlineData: { mimeType: "image/png", data: "AAH/" } }];
const schema = { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { serial: { type: Type.STRING } }, required: ["serial"] } };
type GenerateInput = Parameters<GoogleGenAI["models"]["generateContent"]>[0];

function ai(handler: (input: GenerateInput) => Promise<{ text?: string }>) {
  return { models: { generateContent: handler } } as unknown as GoogleGenAI;
}

function client(models = ["first", "second"]) {
  const delays: number[] = [], warnings: string[] = [];
  const transport = createStructuredAiClient({ models, sleep: async (milliseconds) => { delays.push(milliseconds); },
    logger: { warn(...values) { warnings.push(values.join(" ")); } } });
  return { ...transport, delays, warnings };
}

test("JSON parsing retains plain/fenced values without altering identifiers or adding validation", () => {
  const expected = [{ serial: "000123ABC", hardwareId: "MTR-2026-001" }];
  for (const value of [JSON.stringify(expected), `\n\x60\x60\x60json\n${JSON.stringify(expected)}\n\x60\x60\x60`,
    `\x60\x60\x60\n${JSON.stringify(expected)}\n\x60\x60\x60`]) {
    assert.deepEqual(parseJsonResponse(value), expected);
  }
  assert.equal(parseJsonResponse("null"), null);
  assert.equal(parseJsonResponse("123"), 123);
});

test("empty structured responses keep their error type and original diagnostic snippet", () => {
  assert.throws(() => parseJsonResponse(" \n "), (error) => {
    assert.ok(error instanceof InvalidStructuredResponseError);
    assert.equal(error.message, "Gemini returned an empty structured response.");
    assert.equal(error.responseSnippet, " \n ");
    assert.equal(isInvalidStructuredResponse(error), true);
    return true;
  });
  assert.equal(isInvalidStructuredResponse({ name: "InvalidStructuredResponseError" }), false);
});

test("malformed JSON keeps its SyntaxError cause and a bounded snippet", () => {
  const malformed = '{"serial":'+"x".repeat(700);
  assert.throws(() => parseJsonResponse(malformed), (error) => {
    assert.ok(error instanceof InvalidStructuredResponseError);
    assert.equal(error.message, "Gemini returned malformed structured JSON.");
    assert.equal(error.responseSnippet, malformed.slice(0, 500));
    assert.ok((error as Error & { cause?: unknown }).cause instanceof SyntaxError);
    return true;
  });
});

test("upstream error extraction retains nested API envelopes and plain messages", () => {
  assert.equal(extractUpstreamErrorMessage(new Error('{"error":{"message":"quota used"}}')), "quota used");
  assert.equal(extractUpstreamErrorMessage({ message: '{"message":"reader offline"}' }), "reader offline");
  assert.equal(extractUpstreamErrorMessage(new Error("{invalid")), "{invalid");
  assert.equal(extractUpstreamErrorMessage(new Error("plain failure")), "plain failure");
  assert.equal(extractUpstreamErrorMessage("string failure"), "string failure");
  assert.equal(extractUpstreamErrorMessage(null), "Unknown error");
});

test("retry classification preserves API status and message compatibility", () => {
  for (const error of [{ status: 429 }, new Error("HTTP 429"), new Error('{"error":{"message":"RESOURCE_EXHAUSTED"}}')]) {
    assert.equal(isGeminiRateLimit(error), true);
  }
  for (const error of [{ status: 503 }, new Error("HTTP 503"), new Error("UNAVAILABLE"), new Error("Service under HIGH DEMAND")]) {
    assert.equal(isGeminiUnavailable(error), true);
  }
  for (const error of [new Error("Permission denied"), { status: 400 }, new Error("malformed request")]) {
    assert.equal(isGeminiRateLimit(error), false);
    assert.equal(isGeminiUnavailable(error), false);
  }
});

test("transient retries keep the original exponential delay and eventual result", async () => {
  const transport = client(); let calls = 0;
  const value = await transport.withRetry(async () => {
    if (++calls <= 3) throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
    return "RECOVERED";
  });
  assert.equal(value, "RECOVERED");
  assert.equal(calls, 4);
  assert.deepEqual(transport.delays, [2000, 3000, 4500]);
  assert.equal(transport.warnings.length, 3);
});

test("transient retry exhaustion stops at six calls and throws the original error", async () => {
  const transport = client(); const error = Object.assign(new Error("quota"), { status: 429 }); let calls = 0;
  await assert.rejects(transport.withRetry(async () => { calls++; throw error; }), (actual) => actual === error);
  assert.equal(calls, 6);
  assert.deepEqual(transport.delays, [2000, 3000, 4500, 6750, 10125]);
});

test("non-retryable failure retains immediate rejection without waiting", async () => {
  const transport = client(); const error = new Error("Permission denied"); let calls = 0;
  await assert.rejects(transport.withRetry(async () => { calls++; throw error; }), (actual) => actual === error);
  assert.equal(calls, 1);
  assert.deepEqual(transport.delays, []);
});

test("an explicit zero retry budget retains the existing busy error without invoking work", async () => {
  const transport = client(); let calls = 0;
  await assert.rejects(transport.withRetry(async () => { calls++; return "unused"; }, 0), /Gemini is temporarily busy/);
  assert.equal(calls, 0);
});

test("structured calls preserve the configured model, multimodal parts, response schema, and token limit", async () => {
  const before = JSON.stringify({ parts, schema }); const calls: GenerateInput[] = [];
  const sdk = ai(async (input) => { calls.push(input); return { text: '[{"serial":"000123ABC"}]' }; });
  assert.deepEqual(await client().callStructuredOutput(sdk, parts, schema), [{ serial: "000123ABC" }]);
  assert.deepEqual(calls, [{ model: "first", contents: [{ parts }], config: { maxOutputTokens: 8192,
    responseMimeType: "application/json", responseSchema: schema } }]);
  assert.equal(JSON.stringify({ parts, schema }), before);
});

test("malformed output retries the same model before accepting a later valid response", async () => {
  const transport = client(); const models: string[] = [];
  const sdk = ai(async ({ model }) => { models.push(model); return { text: models.length < 3 ? "invalid JSON" : '[{"serial":"EXACT-001"}]' }; });
  assert.deepEqual(await transport.callStructuredOutput(sdk, parts, schema), [{ serial: "EXACT-001" }]);
  assert.deepEqual(models, ["first", "first", "first"]);
  assert.deepEqual(transport.delays, []);
});

test("three malformed responses move to the next configured model in order", async () => {
  const transport = client(); const models: string[] = [];
  const sdk = ai(async ({ model }) => { models.push(model); return { text: model === "first" ? "broken" : "[]" }; });
  assert.deepEqual(await transport.callStructuredOutput(sdk, parts, schema), []);
  assert.deepEqual(models, ["first", "first", "first", "second"]);
});

test("persistent malformed output on the last model preserves the typed error", async () => {
  const transport = client(); const models: string[] = [];
  const sdk = ai(async ({ model }) => { models.push(model); return { text: "last malformed output" }; });
  await assert.rejects(transport.callStructuredOutput(sdk, parts, schema), (error) => {
    assert.ok(error instanceof InvalidStructuredResponseError);
    assert.equal(error.responseSnippet, "last malformed output"); return true;
  });
  assert.deepEqual(models, ["first", "first", "first", "second", "second", "second"]);
});

test("unavailable models retain six transient attempts each and bounded fallback", async () => {
  const transport = client(); const models: string[] = [];
  const error = Object.assign(new Error("service busy"), { status: 503 });
  const sdk = ai(async ({ model }) => { models.push(model); throw error; });
  await assert.rejects(transport.callStructuredOutput(sdk, parts, schema), (actual) => actual === error);
  assert.deepEqual(models, [...Array(6).fill("first"), ...Array(6).fill("second")]);
  assert.equal(transport.delays.length, 10);
});

test("a permanent API error does not silently move to another model", async () => {
  const transport = client(); const models: string[] = []; const error = Object.assign(new Error("invalid schema"), { status: 400 });
  const sdk = ai(async ({ model }) => { models.push(model); throw error; });
  await assert.rejects(transport.callStructuredOutput(sdk, parts, schema), (actual) => actual === error);
  assert.deepEqual(models, ["first"]);
  assert.deepEqual(transport.delays, []);
});

test("transient transport recovery and malformed-response recovery retain separate budgets", async () => {
  const transport = client(); let calls = 0;
  const sdk = ai(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("quota temporarily busy"), { status: 429 });
    return { text: calls === 2 ? "bad JSON" : '[{"serial":"RECOVERED-001"}]' };
  });
  assert.deepEqual(await transport.callStructuredOutput(sdk, parts, schema), [{ serial: "RECOVERED-001" }]);
  assert.equal(calls, 3);
  assert.deepEqual(transport.delays, [2000]);
});

test("a missing response text retains the existing empty-array default", async () => {
  assert.deepEqual(await client().callStructuredOutput(ai(async () => ({})), parts, schema), []);
  assert.deepEqual(await client().callStructuredOutput(ai(async () => ({ text: "" })), parts, schema), []);
});

test("an empty model list retains the existing comparison failure", async () => {
  await assert.rejects(client([]).callStructuredOutput(ai(async () => { throw new Error("must not be called"); }), parts, schema), /Gemini comparison failed/);
});

test("the genuine SDK sends preserved structured requests to a local fixture through model fallback", async (t) => {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ url: req.url!, method: req.method!, body: JSON.parse(Buffer.concat(chunks).toString()) });
      const text = req.url!.includes("model-first") ? "malformed JSON" : '[{"serial":"SDK-EXACT-001"}]';
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }] }));
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const sdk = new GoogleGenAI({ vertexai: false, apiKey: "ipas-local-fixture-not-a-real-key",
    httpOptions: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiVersion: "v1beta", retryOptions: { attempts: 1 } } });
  const transport = client(["model-first", "model-second"]);
  assert.deepEqual(await transport.callStructuredOutput(sdk, parts, schema), [{ serial: "SDK-EXACT-001" }]);
  assert.equal(requests.length, 4);
  assert.ok(requests.slice(0, 3).every((entry) => entry.url.includes("model-first:generateContent")));
  assert.ok(requests[3].url.includes("model-second:generateContent"));
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.deepEqual(request.body.contents[0].parts, parts);
    assert.equal(request.body.generationConfig.maxOutputTokens, 8192);
    assert.equal(request.body.generationConfig.responseMimeType, "application/json");
    assert.equal(String(request.body.generationConfig.responseSchema.type).toUpperCase(), "ARRAY");
    assert.deepEqual(request.body.generationConfig.responseSchema.items.required, ["serial"]);
  }
});
