import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createCameraSyncController } from "../controllers/cameraSyncController.js";

const actor = "fixture-owner";
const equipment = { equipmentType: "Monitor", equipmentUnitId: "unit-11111111-1111-1111-1111-111111111111" };

test("four photos fill one unit and a fifth is rejected without changing its saved photos", async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 4; i++) {
    const res = response(); await f.controller.push(request({ body: { ...photo("limit-" + i), ...equipment } }), res);
    assert.equal(res.statusCode, 200); assert.equal(res.body.equipmentUnitNumber, 1);
    assert.equal(res.body.equipmentCaptureIndex, i); assert.equal(res.body.equipmentCaptureCount, i);
  }
  const fifth = response(); await f.controller.push(request({ body: { ...photo("limit-5"), ...equipment } }), fifth);
  assert.equal(fifth.statusCode, 409); assert.equal(fifth.body.code, "EQUIPMENT_CAPTURE_LIMIT");
  assert.equal((await f.pending(f.reload())).body.images.length, 4);
});
test("retrying the fourth photo remains idempotent when the unit is full", async t => {
  const f = await fixture(t); const responses = [];
  for (let i = 1; i <= 4; i++) { const res = response(); await f.controller.push(request({ body: { ...photo("retry-full-" + i), ...equipment } }), res); responses.push(res.body); }
  const duplicate = response(); await f.controller.push(request({ body: { ...photo("retry-full-4"), ...equipment } }), duplicate);
  assert.equal(duplicate.statusCode, 200); assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.eventId, responses[3].eventId); assert.equal(duplicate.body.equipmentCaptureCount, 4);
});
test("simultaneous phone captures cannot bypass the four-photo limit", async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 7 }, async (_,i) => { const res = response(); await f.controller.push(request({ body: { ...photo("parallel-unit-" + i), ...equipment } }), res); return res; }));
  assert.equal(results.filter(res => res.statusCode === 200).length, 4); assert.equal(results.filter(res => res.statusCode === 409).length, 3);
  assert.equal((await f.pending(f.reload())).body.images.length, 4);
});
test("same-type units receive distinct durable numbers and independent limits", async t => {
  const f = await fixture(t);
  for (const [unit, number] of [[equipment.equipmentUnitId, 1], ["unit-22222222-2222-2222-2222-222222222222", 2]] as const) {
    for (let i = 1; i <= 4; i++) {
      const res = response(); await f.controller.push(request({ body: { ...photo(unit + i), ...equipment, equipmentUnitId: unit, equipmentUnitNumber: 99, equipmentCaptureCount: 0 } }), res);
      assert.equal(res.statusCode, 200); assert.equal(res.body.equipmentUnitNumber, number); assert.equal(res.body.equipmentCaptureCount, i);
    }
  }
  const restored = (await f.pending(f.reload())).body;
  assert.deepEqual(restored.units.map((unit: any) => unit.equipmentUnitNumber).sort(), [1,2]);
  assert.ok(restored.units.every((unit: any) => unit.equipmentCaptureCount === 4));
});
test("metadata-only progress contains no image bytes and respects the account", async t => {
  const f = await fixture(t); const added = response(); await f.controller.push(request({ body: { ...photo("metadata-only"), ...equipment } }), added);
  const res = response(); await f.controller.pending(request({ query: { unitsOnly: "true" } }), res);
  assert.deepEqual(res.body.images, []); assert.equal(res.body.units.length, 1);
  assert.doesNotMatch(JSON.stringify(res.body), /imageData|base64|fingerprint|sourceSha256/);
  const other = response(); await f.controller.pending(request({ session: { user: { employeeId: "other" } }, query: { unitsOnly: "true" } }), other);
  assert.deepEqual(other.body.units, []);
});
test("removing a photo frees one slot and retains the unit number", async t => {
  const f = await fixture(t); const ids = [];
  for (let i = 1; i <= 4; i++) { const res = response(); await f.controller.push(request({ body: { ...photo("replace-" + i), ...equipment } }), res); ids.push(res.body.eventId); }
  await f.remove(ids[1]); const added = response(); await f.controller.push(request({ body: { ...photo("replacement"), ...equipment } }), added);
  assert.equal(added.statusCode, 200); assert.equal(added.body.equipmentUnitNumber, 1); assert.equal(added.body.equipmentCaptureCount, 4);
  assert.deepEqual((await f.pending(f.reload())).body.images.map((entry: any) => entry.equipmentCaptureIndex).sort(), [1,2,3,4]);
});
test("ticket capture counts retain their existing behavior above four images", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) assert.equal((await f.push("ticket-limit-" + i, "ticket")).statusCode, 200);
  assert.equal((await f.pending()).body.images.length, 6); assert.deepEqual((await f.pending()).body.units, []);
});

test("unit metadata is persisted, replayed and isolated from another employee", async t => {
  const f = await fixture(t); const res = response();
  await f.controller.push(request({ body: { ...photo("selected-unit"), ...equipment } }), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.equipmentUnitId, equipment.equipmentUnitId);
  const restored = (await f.pending(f.reload())).body.images[0];
  assert.equal(restored.equipmentType, "Monitor"); assert.equal(restored.equipmentUnitId, equipment.equipmentUnitId);
  assert.equal((await f.pending(f.reload(), "other-owner")).body.images.length, 0);
});
test("tickets ignore equipment metadata and invalid equipment selections are rejected", async t => {
  const f = await fixture(t); const ticket = response();
  await f.controller.push(request({ body: { ...photo("ticket", "ticket"), ...equipment } }), ticket);
  assert.equal(ticket.statusCode, 200); assert.equal((await f.pending()).body.images[0].equipmentUnitId, undefined);
  const bad = response(); await f.controller.push(request({ body: { ...photo("bad"), ...equipment, equipmentType: "Tickets" } }), bad);
  assert.equal(bad.statusCode, 400); assert.equal((await f.pending()).body.images.length, 1);
});
test("one stable unit cannot change type when subsequent labels arrive", async t => {
  const f = await fixture(t); const one = response(), two = response();
  await f.controller.push(request({ body: { ...photo("unit-one"), ...equipment } }), one);
  await f.controller.push(request({ body: { ...photo("unit-two"), ...equipment, equipmentType: "Printer" } }), two);
  assert.equal(one.statusCode, 200); assert.equal(two.statusCode, 400); assert.equal((await f.pending()).body.images.length, 1);
});
function photo(name: string, captureType = "equipment") {
  return { fileName: name + ".jpg", captureType, mimeType: "image/jpeg",
    imageData: "data:image/jpeg;base64," + Buffer.from((name + "-fixture-").repeat(500)).toString("base64") };
}
function request(values: any = {}) {
  return Object.assign(new EventEmitter(), { session: { user: { employeeId: actor } }, body: {}, query: {}, params: {} }, values) as any;
}
function response() {
  return { statusCode: 200, body: null as any, writes: [] as string[], headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; }, flushHeaders() {}, write(value: string) { this.writes.push(value); } } as any;
}
async function fixture(t: any) {
  const storeDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ipas-capture-test-"));
  t.after(() => fs.promises.rm(storeDirectory, { recursive: true, force: true }));
  const controller = createCameraSyncController({ storeDirectory });
  return { storeDirectory, controller,
    reload() { return createCameraSyncController({ storeDirectory }); },
    async push(name: string, captureType = "equipment", empId = actor) {
      const res = response(); await controller.push(request({ body: photo(name, captureType), session: { user: { employeeId: empId } } }), res); return res;
    },
    async pending(which = controller, empId = actor) {
      const res = response(); await which.pending(request({ session: { user: { employeeId: empId } } }), res); return res;
    },
    async remove(eventId: string, which = controller, empId = actor) {
      const res = response(); await which.deletePending(request({ params: { eventId }, session: { user: { employeeId: empId } } }), res); return res;
    },
  };
}

test("saved captures restore after a new controller loads the same disk store", async t => {
  const f = await fixture(t); const added = await f.push("equipment-one");
  assert.equal(added.statusCode, 200); assert.ok(added.body.eventId);
  const restored = await f.pending(f.reload());
  assert.deepEqual(restored.body.images.map((image: any) => image.eventId), [added.body.eventId]);
});

test("deleting a saved capture survives reload and removes its last storage file", async t => {
  const f = await fixture(t); const added = await f.push("remove-me");
  assert.deepEqual((await f.remove(added.body.eventId)).body, { success: true, deleted: true });
  assert.deepEqual((await f.pending()).body.images, []);
  assert.deepEqual((await f.pending(f.reload())).body.images, []);
  assert.deepEqual(await fs.promises.readdir(f.storeDirectory), []);
});

test("clearing seven selected equipment captures retains tickets and other accounts", async t => {
  const f = await fixture(t); const ids = [];
  for (let index = 0; index < 7; index++) ids.push((await f.push("selected-" + index)).body.eventId);
  const ticket = await f.push("keep-ticket", "ticket");
  const other = await f.push("keep-other-owner", "equipment", "other-account");
  for (const id of ids) await f.remove(id);
  const reloaded = f.reload();
  assert.deepEqual((await f.pending(reloaded)).body.images.map((image: any) => image.eventId), [ticket.body.eventId]);
  assert.deepEqual((await f.pending(reloaded, "other-account")).body.images.map((image: any) => image.eventId), [other.body.eventId]);
});

test("a delete cannot switch to another account using the query parameter", async t => {
  const f = await fixture(t); const added = await f.push("keep"); const res = response();
  await f.controller.deletePending(request({ params: { eventId: added.body.eventId }, query: { empId: "another-account" } }), res);
  assert.equal(res.statusCode, 403); assert.equal((await f.pending()).body.images.length, 1);
});

test("unknown event ids are idempotent and empty ids are rejected", async t => {
  const f = await fixture(t); await f.push("keep");
  assert.deepEqual((await f.remove("not-found")).body, { success: true, deleted: false });
  assert.equal((await f.remove("")).statusCode, 400); assert.equal((await f.pending()).body.images.length, 1);
});

test("unidentified requests cannot read, delete or push captures", async t => {
  const f = await fixture(t);
  for (const handler of [f.controller.pending, f.controller.deletePending, f.controller.push]) {
    const res = response(); await handler(request({ session: null }), res); assert.equal(res.statusCode, 401);
  }
});

test("the existing explicit employee-id channel fallback is retained", async t => {
  const f = await fixture(t); const res = response();
  await f.controller.push(request({ session: null, body: { ...photo("legacy-channel"), empId: actor } }), res);
  assert.equal(res.statusCode, 200); assert.equal((await f.pending()).body.images.length, 1);
});

test("parallel uploads retain every distinct image on disk", async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) => f.push("parallel-" + index)));
  assert.ok(results.every(result => result.statusCode === 200));
  assert.equal((await f.pending(f.reload())).body.images.length, 16);
});

test("simultaneous retries of the same photo resolve to one persisted event", async t => {
  const f = await fixture(t); const results = await Promise.all(Array.from({ length: 8 }, () => f.push("one-photo")));
  assert.equal(new Set(results.map(result => result.body.eventId)).size, 1);
  assert.equal(results.filter(result => !result.body.duplicate).length, 1);
  assert.equal((await f.pending(f.reload())).body.images.length, 1);
});

test("an acknowledged delete cannot be resurrected by concurrent uploads", async t => {
  const f = await fixture(t); const target = await f.push("delete-target");
  await Promise.all([f.remove(target.body.eventId), ...Array.from({ length: 12 }, (_, index) => f.push("fresh-" + index))]);
  const images = (await f.pending(f.reload())).body.images;
  assert.equal(images.length, 12); assert.ok(images.every((image: any) => image.eventId !== target.body.eventId));
});

test("a cold-start read, deletion and new upload serialize without restoring deleted disk entries", async t => {
  const f = await fixture(t); const target = await f.push("cold-target"); const fresh = f.reload();
  const pushed = response();
  await Promise.all([f.pending(fresh), f.remove(target.body.eventId, fresh), fresh.push(request({ body: photo("cold-new") }), pushed)]);
  const images = (await f.pending(f.reload())).body.images;
  assert.equal(images.length, 1); assert.equal(images[0].fileName, "cold-new.jpg");
});

test("failed persistence retains the old in-memory and on-disk capture list", async t => {
  const f = await fixture(t); const target = await f.push("retain-target"); await f.push("retain-other");
  const rename = t.mock.method(fs.promises, "rename", async () => { throw Object.assign(new Error("fixture disk failure"), { code: "EIO" }); });
  const result = await f.remove(target.body.eventId); rename.mock.restore();
  assert.equal(result.statusCode, 500);
  assert.equal((await f.pending()).body.images.length, 2); assert.equal((await f.pending(f.reload())).body.images.length, 2);
  assert.ok((await fs.promises.readdir(f.storeDirectory)).every(file => !file.endsWith(".tmp")));
});

test("corrupt saved data is not silently replaced by a new push", async t => {
  const f = await fixture(t); await f.push("saved");
  const file = path.join(f.storeDirectory, (await fs.promises.readdir(f.storeDirectory))[0]);
  await fs.promises.writeFile(file, "not valid json");
  const res = response(); await f.reload().push(request({ body: photo("new") }), res);
  assert.equal(res.statusCode, 500); assert.equal(await fs.promises.readFile(file, "utf8"), "not valid json");
});

test("deletions broadcast only to the matching account after persistence", async t => {
  const f = await fixture(t); const owner = request(), other = request({ session: { user: { employeeId: "other" } } });
  const ownerResponse = response(), otherResponse = response();
  t.after(() => { owner.emit("close"); other.emit("close"); });
  f.controller.events(owner, ownerResponse); f.controller.events(other, otherResponse);
  const target = await f.push("broadcast"); await f.remove(target.body.eventId);
  const messages = ownerResponse.writes.filter((value: string) => value.startsWith("data: ")).map((value: string) => JSON.parse(value.slice(6)));
  assert.deepEqual(messages.map((value: any) => value.type), ["connected", "capture", "deleted"]);
  assert.equal(messages[2].eventId, target.body.eventId); assert.equal(messages[2].fileName, "broadcast.jpg");
  assert.equal(otherResponse.writes.length, 1); assert.deepEqual((await f.pending(f.reload())).body.images, []);
});

test("new uploads, including intentionally reattached image content, work after clearing", async t => {
  const f = await fixture(t); const first = await f.push("reattach"); await f.remove(first.body.eventId);
  const next = await f.push("reattach"); assert.equal(next.body.duplicate, undefined);
  assert.notEqual(next.body.eventId, first.body.eventId); assert.equal((await f.pending(f.reload())).body.images.length, 1);
});
