import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createCameraSyncController } from "../controllers/cameraSyncController.js";

// The controller imports the database repository, but this flow must never
// query it. Use an isolated test configuration and reject any attempted query.
Object.assign(process.env, { DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "fixture", DB_USER: "fixture", DB_PASSWORD: "fixture" });
const { db } = await import("../database/postgres.js");
db.query = (() => { throw new Error("Storage cleanup must not read or mutate saved database records"); }) as any;
const { createDocumentRepositoryController } = await import("../controllers/documentRepositoryController.js");

const owner = "fixture-owner";
const bytes = (label: string) => Buffer.from((label + "-fixture-content-").repeat(500));
const hash = (value: Buffer) => crypto.createHash("sha256").update(value).digest("hex");
function response() {
  return { statusCode: 200, body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; }, setHeader() {} } as any;
}
async function fixture(t: any) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ipas-storage-capture-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const storeDirectory = path.join(root, "captures");
  const camera = createCameraSyncController({ storeDirectory });
  const remote = new Map<string, Buffer>();
  const state = { uploads: 0, failAt: 0, failConnection: false, falseAt: 0,
    afterPut: null as null | (() => Promise<void>) };
  const client = { exists: async () => true, createDirectory: async () => {},
    putFileContents: async (name: string, data: Buffer) => {
      state.uploads++;
      if (state.failAt === state.uploads) throw new Error("Synthetic remote upload failure");
      if (state.falseAt === state.uploads) return false;
      remote.set(name, Buffer.from(data));
      if (state.afterPut) await state.afterPut();
      return true;
    } };
  const controller = createDocumentRepositoryController({
    normalizeNextcloudPath: value => value, sanitizeNextcloudSegment: value => value,
    getWebDAVClient: () => client, resolveNextcloudConfig: () => ({ url: "https://fixture.invalid", username: "fixture", password: "fixture" }),
    verifyWebDAVConnection: async () => { if (state.failConnection) throw new Error("Synthetic connection failure"); },
    createWebDAVClient: () => client, readFile: fs.promises.readFile, unlinkFile: fs.promises.unlink,
    getSafeFileName: path.posix.basename, getFileName: path.basename, getRepoMimeType: () => "image/jpeg",
    prepareCaptureUpload: camera.prepareStorageUpload,
  });
  return { root, state, remote, camera, storeDirectory,
    async push(name: string, data = bytes(name), captureType = "equipment", actor = owner, sourceSha256?: string) {
      const res = response();
      await camera.push({ session: { user: { employeeId: actor } }, body: {
        fileName: name, captureType, mimeType: "image/jpeg", imageData: "data:image/jpeg;base64," + data.toString("base64"), sourceSha256,
      } } as any, res);
      assert.equal(res.statusCode, 200); return res.body.eventId as string;
    },
    async pending(actor = owner, reload = false) {
      const res = response(); const which = reload ? createCameraSyncController({ storeDirectory }) : camera;
      await which.pending({ session: { user: { employeeId: actor } }, query: {} } as any, res);
      return res.body.images as any[];
    },
    async upload(files: { name: string; data: Buffer }[], actor: string | null = owner) {
      const requestFiles = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index]; const localPath = path.join(root, crypto.randomUUID());
        await fs.promises.writeFile(localPath, file.data);
        requestFiles.push({ originalname: file.name, path: localPath, size: file.data.length });
      }
      const res = response();
      await controller.uploadToNextcloud({ session: actor ? { user: { employeeId: actor } } : null,
        body: { targetPath: "/Saved equipment", empId: owner }, files: requestFiles } as any, res);
      for (const file of requestFiles) await assert.rejects(fs.promises.access(file.path));
      return res;
    },
  };
}

test("successful storage upload retires only its matching captures and preserves remote files, tickets and other accounts", async t => {
  const f = await fixture(t);
  const uploaded = await f.push("uploaded.jpg"); const kept = await f.push("keep.jpg");
  await f.push("same-ticket.jpg", bytes("ticket content"), "ticket");
  await f.push("same-other.jpg", bytes("uploaded.jpg"), "equipment", "another-owner");
  const res = await f.upload([{ name: "uploaded.jpg", data: bytes("uploaded.jpg") }, { name: "record.pdf", data: bytes("record-pdf") },
    { name: "same-ticket.jpg", data: bytes("ticket content") }]);
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
  assert.deepEqual(res.body.captureCleanup.removedEventIds, [uploaded]);
  assert.ok((await f.pending(owner, true)).some(entry => entry.eventId === kept));
  assert.equal((await f.pending()).length, 2); assert.equal((await f.pending("another-owner", true)).length, 1);
  assert.deepEqual(f.remote.get("/Saved equipment/uploaded.jpg"), bytes("uploaded.jpg"));
  assert.deepEqual(f.remote.get("/Saved equipment/record.pdf"), bytes("record-pdf"));
});

test("a partially failed batch keeps every capture, including files already uploaded", async t => {
  const f = await fixture(t); await f.push("first.jpg"); await f.push("second.jpg"); f.state.failAt = 2;
  const res = await f.upload([{ name: "first.jpg", data: bytes("first.jpg") }, { name: "second.jpg", data: bytes("second.jpg") }]);
  assert.equal(res.statusCode, 500); assert.equal(res.body.captureCleanup, undefined);
  assert.equal((await f.pending(owner, true)).length, 2); assert.equal(f.remote.size, 1);
});

test("a storage connection failure keeps captures", async t => {
  const f = await fixture(t); await f.push("keep.jpg"); f.state.failConnection = true;
  assert.equal((await f.upload([{ name: "keep.jpg", data: bytes("keep.jpg") }])).statusCode, 500);
  assert.equal((await f.pending(owner, true)).length, 1); assert.equal(f.remote.size, 0);
});

test("storage returning false cannot clear a captured image", async t => {
  const f = await fixture(t); await f.push("keep.jpg"); f.state.falseAt = 1;
  assert.equal((await f.upload([{ name: "keep.jpg", data: bytes("keep.jpg") }])).statusCode, 500);
  assert.equal((await f.pending(owner, true)).length, 1);
});

test("captures arriving during the upload survive even with the same filename", async t => {
  const f = await fixture(t); const old = await f.push("shared.jpg"); let fresh = "";
  f.state.afterPut = async () => { fresh = await f.push("shared.jpg", bytes("new content")); };
  const res = await f.upload([{ name: "shared.jpg", data: bytes("shared.jpg") }]);
  assert.deepEqual(res.body.captureCleanup.removedEventIds, [old]);
  assert.deepEqual((await f.pending(owner, true)).map(entry => entry.eventId), [fresh]);
});

test("an original phone photo matches its resized capture using the original checksum", async t => {
  const f = await fixture(t); const original = bytes("original phone image");
  const id = await f.push("phone.jpg", bytes("resized phone image"), "equipment", owner, hash(original));
  const restored = await f.pending(owner, true); assert.equal(restored[0].sourceSha256, hash(original));
  const res = await f.upload([{ name: "phone.jpg", data: original }]);
  assert.deepEqual(res.body.captureCleanup.removedEventIds, [id]); assert.deepEqual(await f.pending(owner, true), []);
  assert.deepEqual(f.remote.get("/Saved equipment/phone.jpg"), original);
});

test("a same-name image with different content is retained", async t => {
  const f = await fixture(t); await f.push("shared.jpg", bytes("camera image"));
  const res = await f.upload([{ name: "shared.jpg", data: bytes("different image") }]);
  assert.equal(res.body.success, true); assert.deepEqual(res.body.captureCleanup.removedEventIds, []);
  assert.equal((await f.pending(owner, true)).length, 1);
});

test("duplicate destination filenames retire only the content actually left in storage", async t => {
  const f = await fixture(t); const first = await f.push("shared.jpg", bytes("first content"));
  const last = await f.push("shared.jpg", bytes("last content"));
  const res = await f.upload([{ name: "shared.jpg", data: bytes("first content") }, { name: "shared.jpg", data: bytes("last content") }]);
  assert.deepEqual(res.body.captureCleanup.removedEventIds, [last]);
  assert.deepEqual((await f.pending(owner, true)).map(entry => entry.eventId), [first]);
  assert.deepEqual(f.remote.get("/Saved equipment/shared.jpg"), bytes("last content"));
});

test("unauthenticated uploads cannot select a capture account using body empId", async t => {
  const f = await fixture(t); await f.push("keep.jpg");
  const res = await f.upload([{ name: "keep.jpg", data: bytes("keep.jpg") }], null);
  assert.equal(res.statusCode, 200); assert.equal(res.body.captureCleanup.status, "retained");
  assert.equal((await f.pending(owner, true)).length, 1); assert.equal(f.remote.size, 1);
});

test("cleanup failure preserves captures and still reports the completed remote upload", async t => {
  const f = await fixture(t); await f.push("uploaded.jpg"); await f.push("other.jpg");
  const rename = fs.promises.rename;
  f.state.afterPut = async () => {
    fs.promises.rename = async (from, to) => {
      if (String(from).startsWith(f.storeDirectory)) throw new Error("Synthetic capture cleanup disk failure");
      return rename(from, to);
    };
  };
  let res: any;
  try { res = await f.upload([{ name: "uploaded.jpg", data: bytes("uploaded.jpg") }]); }
  finally { fs.promises.rename = rename; }
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
  assert.equal(res.body.captureCleanup.status, "retained");
  assert.equal((await f.pending(owner, true)).length, 2); assert.equal(f.remote.size, 1);
  assert.equal((await fs.promises.readdir(f.storeDirectory)).some(name => name.endsWith(".tmp")), false);
});

test("empty uploads do not touch storage or captures", async t => {
  const f = await fixture(t); await f.push("keep.jpg");
  assert.equal((await f.upload([])).statusCode, 400);
  assert.equal(f.state.uploads, 0); assert.equal((await f.pending(owner, true)).length, 1);
});
