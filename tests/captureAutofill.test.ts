import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCaptureAutofill, sanitizeCaptureExportItems } from "../services/captureAutofill.js";
import { createCaptureAutofillController } from "../controllers/captureAutofillController.js";
import type { OcrSourceFile } from "../types/ocr.js";

const source = (name = "monitor.jpg", content = "fixture") => ({ name, kind: "image", contentType: "inlineData", content: Buffer.from(content).toString("base64"), mimeType: "image/jpeg" } as OcrSourceFile);
const result = () => ({ records: [{ sourceName: "monitor.jpg", components: "MONITOR", description: "ACER K222HQL", hardwareId: "MTR-2021-044", serial: "SERIAL123", remarks: "New Accountability", notes: "Observed labels" }], summary: { manual: 0 } });
function response() {
  return { statusCode: 200, body: null as any, headers: {} as any,
    status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.body = value; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; } } as any;
}
const request = (body: any = {}, actor: string | null = "owner") => ({ session: actor ? { user: { employeeId: actor } } : null, body } as any);

test("exports retain two explicitly selected units even when OCR values coincide", () => {
  const row = { ...result().records[0], equipmentType: "Monitor", equipmentUnitId: "unit-11111111-1111-1111-1111-111111111111", remarks: "" };
  assert.equal(sanitizeCaptureExportItems([row, { ...row, equipmentUnitId: "unit-22222222-2222-2222-2222-222222222222" }]).length, 2);
});
test("stored unit metadata overrides a forged request grouping hint", async () => {
  const equipment = { equipmentType: "Monitor", equipmentUnitId: "unit-11111111-1111-1111-1111-111111111111" };
  const controller = createCaptureAutofillController({ autofill: createCaptureAutofill({ extract: async () => result() }), prepareFile: async () => source(),
    getCapture: async () => ({ imageData: "data:image/jpeg;base64," + source().content, fileName: "phone.jpg", mimeType: "image/jpeg", captureType: "equipment", ...equipment }) });
  const res = response(); await controller(request({ eventId: "stored", equipmentType: "Printer", equipmentUnitId: "unit-22222222-2222-2222-2222-222222222222" }), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.equipmentUnitId, equipment.equipmentUnitId); assert.equal(res.body.equipmentType, "Monitor");
});

test("automatic drafts include observed fields and always blank Remarks", async () => {
  const service = createCaptureAutofill({ extract: async () => result() });
  const draft = await service.read("owner", source());
  assert.equal(draft.record.components, "MONITOR"); assert.equal(draft.record.serial, "SERIAL123");
  assert.equal(draft.record.remarks, ""); assert.equal(draft.needsReview, false); assert.equal(draft.cached, false);
});
test("phone and laptop requests for identical bytes share one in-flight read", async () => {
  let calls = 0; let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const service = createCaptureAutofill({ extract: async () => { calls++; await gate; return result(); } });
  const one = service.read("owner", source()); const two = service.read("owner", source("renamed.jpg"));
  release(); const [first, second] = await Promise.all([one, two]);
  assert.equal(calls, 1); assert.equal(first.cached, false); assert.equal(second.cached, true);
  assert.equal(second.record.sourceName, "renamed.jpg");
});
test("cached reads avoid another extraction and return independent objects", async () => {
  let calls = 0; const service = createCaptureAutofill({ extract: async () => { calls++; return result(); } });
  const first = await service.read("owner", source()); first.record.serial = "USER EDIT";
  const second = await service.read("owner", source()); assert.equal(calls, 1); assert.equal(second.cached, true); assert.equal(second.record.serial, "SERIAL123");
});
test("explicit retry reruns extraction while ordinary reload uses cache", async () => {
  let calls = 0; const flags: boolean[] = [];
  const service = createCaptureAutofill({ extract: async (_file, _publish, force) => { calls++; flags.push(Boolean(force)); return result(); } });
  await service.read("owner", source()); await service.read("owner", source()); await service.read("owner", source(), true);
  assert.equal(calls, 2);
  assert.deepEqual(flags, [false, true]);
});
test("one CPU/OCR read runs at a time across different images", async () => {
  let active = 0, peak = 0; const service = createCaptureAutofill({ extract: async () => {
    active++; peak = Math.max(active, peak); await new Promise(resolve => setTimeout(resolve, 5)); active--; return result();
  } });
  await Promise.all([service.read("owner", source("a.jpg", "a")), service.read("owner", source("b.jpg", "b"))]);
  assert.equal(peak, 1);
});
test("pending unique reads are bounded but duplicates can share the full queue", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const service = createCaptureAutofill({ maxPending: 1, extract: async () => { await gate; return result(); } });
  const first = service.read("owner", source()); const duplicate = service.read("owner", source());
  await assert.rejects(service.read("owner", source("other.jpg", "other")), { status: 429 });
  release(); await Promise.all([first, duplicate]);
});
test("partial and review-flagged values stay drafts with missing fields identified", async () => {
  const extraction = result(); extraction.records[0].serial = "unreadable"; extraction.summary.manual = 1;
  const service = createCaptureAutofill({ extract: async () => extraction }); const draft = await service.read("owner", source());
  assert.equal(draft.record.serial, ""); assert.equal(draft.needsReview, true); assert.deepEqual(draft.missingFields, ["serial"]);
});
test("ambiguous multi-row and empty extractions require manual review rather than guessing a row", async () => {
  const service = createCaptureAutofill({ extract: async () => ({ records: [], summary: { manual: 1 } }) });
  await assert.rejects(service.read("owner", source()), { status: 422 });
});
test("failed reads remain retryable without poisoning the queue", async () => {
  let calls = 0; const service = createCaptureAutofill({ extract: async () => { if (++calls === 1) throw new Error("fixture failure"); return result(); } });
  await assert.rejects(service.read("owner", source())); assert.equal((await service.read("owner", source())).record.serial, "SERIAL123");
});
test("accounts cannot reuse each other's draft cache", async () => {
  let calls = 0; const service = createCaptureAutofill({ extract: async () => { calls++; return result(); } });
  await service.read("owner", source()); await service.read("other", source()); assert.equal(calls, 2);
});
test("expired and evicted cache entries can be read again", async () => {
  let calls = 0, clock = 100; const service = createCaptureAutofill({ maxCache: 1, now: () => clock, extract: async () => { calls++; return result(); } });
  await service.read("owner", source()); clock += 25 * 60 * 60 * 1000; await service.read("owner", source());
  await service.read("owner", source("other.jpg", "other")); await service.read("owner", source()); assert.equal(calls, 4);
});
test("missing identities and non-image sources are rejected", async () => {
  const service = createCaptureAutofill({ extract: async () => result() });
  await assert.rejects(service.read("", source()), { status: 401 });
  await assert.rejects(service.read("owner", { ...source(), kind: "pdf" }), { status: 400 });
});
test("stored capture reads use only the authenticated account", async () => {
  const seen: string[] = []; const service = createCaptureAutofill({ extract: async () => result() });
  const controller = createCaptureAutofillController({ autofill: service,
    getCapture: async (actor, id) => { seen.push(actor); return actor === "owner" && id === "capture-id" ? { imageData: "data:image/jpeg;base64," + source().content, fileName: "phone.jpg", mimeType: "image/jpeg", captureType: "equipment" } : undefined; },
    prepareFile: async () => source() });
  const own = response(); await controller(request({ eventId: "capture-id", empId: "other" }), own);
  assert.equal(own.statusCode, 200); assert.equal(own.body.employeeId, "owner"); assert.equal(own.body.record.remarks, ""); assert.equal(own.headers["Cache-Control"], "no-store");
  const other = response(); await controller(request({ eventId: "capture-id", empId: "owner" }, "other"), other);
  assert.equal(other.statusCode, 404); assert.deepEqual(seen, ["owner", "owner", "other"]);
});
test("missing sessions, ticket captures and removed captures never produce equipment rows", async () => {
  let calls = 0; const service = createCaptureAutofill({ extract: async () => { calls++; return result(); } });
  const controller = createCaptureAutofillController({ autofill: service, prepareFile: async () => source(), getCapture: async () => ({ imageData: "data:image/jpeg;base64," + source().content, fileName: "ticket.jpg", mimeType: "image/jpeg", captureType: "ticket" }) });
  const noSession = response(); await controller(request({ eventId: "id" }, null), noSession); assert.equal(noSession.statusCode, 401);
  const ticket = response(); await controller(request({ eventId: "id" }), ticket); assert.equal(ticket.statusCode, 404); assert.equal(calls, 0);
});
test("removing a capture during reading suppresses its late response", async () => {
  let lookups = 0; const service = createCaptureAutofill({ extract: async () => result() });
  const controller = createCaptureAutofillController({ autofill: service, prepareFile: async () => source(), getCapture: async () => ++lookups === 1 ? { imageData: "data:image/jpeg;base64," + source().content, fileName: "removed.jpg", mimeType: "image/jpeg", captureType: "equipment" } : undefined });
  const res = response(); await controller(request({ eventId: "id" }), res); assert.equal(res.statusCode, 410); assert.equal(res.body.record, undefined);
});
test("local image upload is read without event id and temporary file is removed", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ipas-autofill-")); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const localPath = path.join(dir, "image.jpg"); await fs.writeFile(localPath, "fixture");
  const controller = createCaptureAutofillController({ autofill: createCaptureAutofill({ extract: async () => result() }), getCapture: async () => undefined, prepareFile: async () => source() });
  const req = request(); req.file = { path: localPath, mimetype: "image/jpeg" };
  const res = response(); await controller(req, res); assert.equal(res.statusCode, 200); await assert.rejects(fs.access(localPath));
});
test("unexpected upstream failures return a bounded message and retain photos", async () => {
  const controller = createCaptureAutofillController({ autofill: createCaptureAutofill({ extract: async () => { throw new Error("private fixture detail"); } }), getCapture: async () => undefined, prepareFile: async () => source() });
  const req = request(); req.file = { path: "/tmp/nonexistent-actual-file", mimetype: "image/jpeg" };
  const res = response(); await controller(req, res); assert.equal(res.statusCode, 503); assert.equal(res.body.error.includes("private fixture"), false);
});

test("blank Remarks remains blank after export normalization and duplicate consolidation", () => {
  const row = { ...result().records[0], remarks: "" };
  const rows = sanitizeCaptureExportItems([row, { ...row, sourceName: "another-photo.jpg" }]);
  assert.equal(rows.length, 1); assert.equal(rows[0].remarks, "");
});
test("export keeps explicitly entered Remarks for its corresponding asset", () => {
  const one = { ...result().records[0], remarks: "Manual remark" };
  const two = { ...one, hardwareId: "MTR-2021-045", serial: "SERIAL456", remarks: "Other manual remark" };
  const rows = sanitizeCaptureExportItems([one, two]);
  assert.equal(rows.length, 2); assert.equal(rows[0].remarks, "Manual remark"); assert.equal(rows[1].remarks, "Other manual remark");
});
test("export never invents Remarks for missing or malformed user input", () => {
  assert.deepEqual(sanitizeCaptureExportItems(undefined), []);
  const row = { ...result().records[0], remarks: undefined };
  assert.equal(sanitizeCaptureExportItems([row])[0].remarks, "");
});
test("export retains separate partial units with different hardware IDs", () => {
  const row = { ...result().records[0], serial: "", remarks: "" };
  const rows = sanitizeCaptureExportItems([row, { ...row, hardwareId: "MTR-2021-045" }]);
  assert.equal(rows.length, 2); assert.equal(rows[0].remarks, ""); assert.equal(rows[1].remarks, "");
});

test("local fields are published before the final extraction completes with blank Remarks", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  let localReady!: () => void; const local = new Promise<void>(resolve => localReady = resolve);
  const drafts: any[] = [];
  const service = createCaptureAutofill({ extract: async (_file, publish) => {
    publish?.({ ...result().records[0], components: "CPU ADAPTER", serial: "" });
    await gate; return result();
  } });
  const pending = service.read("owner", source(), false, draft => { drafts.push(draft); localReady(); });
  await local; assert.equal(drafts[0].record.components, "LAPTOP ADAPTER"); assert.equal(drafts[0].record.remarks, ""); assert.equal(drafts[0].record.serial, "");
  release(); assert.equal((await pending).record.serial, "SERIAL123");
});
test("a phone/laptop joining an in-flight read receives its latest local fields without another extraction", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  let localReady!: () => void; const local = new Promise<void>(resolve => localReady = resolve); let calls = 0;
  const service = createCaptureAutofill({ extract: async (_file, publish) => { calls++; publish?.(result().records[0]); await gate; return result(); } });
  const first = service.read("owner", source(), false, () => localReady()); await local;
  const observed: any[] = []; const second = service.read("owner", source("phone.jpg"), false, draft => observed.push(draft));
  assert.equal(observed.length, 1); assert.equal(observed[0].record.sourceName, "phone.jpg"); assert.equal(observed[0].record.remarks, "");
  release(); await Promise.all([first, second]); assert.equal(calls, 1);
});
test("a closed or mutating progress listener cannot corrupt another reader or the final draft", async () => {
  const service = createCaptureAutofill({ extract: async (_file, publish) => { publish?.(result().records[0]); return result(); } });
  const value = await service.read("owner", source(), false, draft => { draft.record.serial = "changed"; throw new Error("closed fixture client"); });
  assert.equal(value.record.serial, "SERIAL123");
});
function streamResponse() {
  const res = response(); res.headersSent = false; res.destroyed = false; res.chunks = [] as string[];
  res.flushHeaders = () => { res.headersSent = true; }; res.write = (text: string) => { res.chunks.push(text); return true; };
  res.end = () => { res.ended = true; return res; }; return res;
}
test("NDJSON sends local fields before final completion and still supports the old JSON endpoint", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  let localReady!: () => void; const local = new Promise<void>(resolve => localReady = resolve);
  const service = createCaptureAutofill({ extract: async (_file, publish) => { publish?.(result().records[0]); localReady(); await gate; return result(); } });
  const controller = createCaptureAutofillController({ autofill: service, getCapture: async () => ({ imageData: "data:image/jpeg;base64," + source().content, fileName: "saved.jpg", mimeType: "image/jpeg", captureType: "equipment" }), prepareFile: async () => source() });
  const req = request({ eventId: "saved-id" }); req.headers = { accept: "application/x-ndjson" }; const res = streamResponse();
  const pending = controller(req, res); await local;
  assert.equal(res.ended, undefined); assert.equal(JSON.parse(res.chunks[0]).stage, "local"); assert.equal(JSON.parse(res.chunks[0]).record.remarks, "");
  release(); await pending; assert.equal(res.ended, true); assert.equal(JSON.parse(res.chunks.at(-1)).stage, "final");
  const legacy = response(); await controller(request({ eventId: "saved-id" }), legacy); assert.equal(legacy.body.record.serial, "SERIAL123"); assert.equal(legacy.body.cached, true);
});
test("a streamed failure follows the local draft with a safe error and no fabricated final fields", async () => {
  const service = createCaptureAutofill({ extract: async (_file, publish) => { publish?.(result().records[0]); throw new Error("private fixture failure"); } });
  const controller = createCaptureAutofillController({ autofill: service, getCapture: async () => ({ imageData: "data:image/jpeg;base64," + source().content, fileName: "saved.jpg", mimeType: "image/jpeg", captureType: "equipment" }), prepareFile: async () => source() });
  const req = request({ eventId: "id" }); req.headers = { accept: "application/x-ndjson" }; const res = streamResponse(); await controller(req, res);
  assert.deepEqual(res.chunks.map((text: string) => JSON.parse(text).stage), ["local", "error"]); assert.equal(res.chunks.join("").includes("private fixture failure"), false);
});
