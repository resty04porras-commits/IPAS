import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import multer from "multer";
import type { Multer } from "multer";
import type { createDocumentRepositoryController } from "../controllers/documentRepositoryController.js";
import { registerDocumentRepositoryRoutes } from "../routes/documentRepository.js";
import { getRepoMimeType } from "../services/documentRepositoryMime.js";

async function withApp(
  upload: Multer,
  check: (base: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  const methods = [
    "createFolder", "uploadToNextcloud", "repositoryFile", "listDocumentRecords",
    "getDocumentRecord", "createDocumentRecord", "updateDocumentRecord",
    "deleteDocumentRecord", "browseRepository",
  ];
  const controller = Object.fromEntries(methods.map((handler) => [
    handler,
    async (req: express.Request, res: express.Response) => res.json({
      handler,
      id: req.params.id || null,
      body: req.body,
      files: ((req.files || []) as Express.Multer.File[]).map((file) => ({
        name: file.originalname,
        content: file.buffer.toString(),
      })),
    }),
  ])) as ReturnType<typeof createDocumentRepositoryController>;
  registerDocumentRepositoryRoutes(app, { documentRepositoryController: controller, upload });
  app.all("/api/*", (_req, res) => res.status(404).json({ error: "API route not found" }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("all nine public document endpoints reach their original controller methods", async () => {
  await withApp(multer({ storage: multer.memoryStorage() }), async (base) => {
    const routes = [
      ["POST", "/api/create-folder", "createFolder"],
      ["POST", "/api/upload-to-nextcloud", "uploadToNextcloud"],
      ["POST", "/api/repository/file", "repositoryFile"],
      ["GET", "/api/repository/documents", "listDocumentRecords"],
      ["GET", "/api/repository/documents/document-123", "getDocumentRecord"],
      ["POST", "/api/repository/documents", "createDocumentRecord"],
      ["PUT", "/api/repository/documents/document-123", "updateDocumentRecord"],
      ["DELETE", "/api/repository/documents/document-123", "deleteDocumentRecord"],
      ["POST", "/api/repository/browse", "browseRepository"],
    ];
    for (const [method, path, handler] of routes) {
      const sendBody = ["POST", "PUT"].includes(method);
      const response = await fetch(base + path, {
        method,
        headers: sendBody ? { "Content-Type": "application/json" } : {},
        body: sendBody ? JSON.stringify({ marker: "preserve-request-body" }) : undefined,
      });
      assert.equal(response.status, 200, `${method} ${path}`);
      const result = await response.json();
      assert.equal(result.handler, handler);
      if (path.endsWith("document-123")) assert.equal(result.id, "document-123");
      if (sendBody) assert.deepEqual(result.body, { marker: "preserve-request-body" });
    }
    const missing = await fetch(base + "/api/repository/no-such-route");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "API route not found" });
  });
});

test("multipart upload preserves filenames, contents, and form fields", async () => {
  await withApp(multer({ storage: multer.memoryStorage() }), async (base) => {
    const form = new FormData();
    form.append("targetPath", "/IICTD Asset Management Record/Tests");
    form.append("files", new Blob(["first document"]), "first.txt");
    form.append("files", new Blob(["second document"]), "second.txt");
    const response = await fetch(base + "/api/upload-to-nextcloud", { method: "POST", body: form });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.handler, "uploadToNextcloud");
    assert.equal(result.body.targetPath, "/IICTD Asset Management Record/Tests");
    assert.deepEqual(result.files, [
      { name: "first.txt", content: "first document" },
      { name: "second.txt", content: "second document" },
    ]);
  });
});

test("unexpected file fields retain the existing HTTP 400 Multer error response", async () => {
  await withApp(multer({ storage: multer.memoryStorage() }), async (base) => {
    const form = new FormData();
    form.append("wrong-field", new Blob(["document"]), "test.txt");
    const response = await fetch(base + "/api/upload-to-nextcloud", { method: "POST", body: form });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Multer error: Unexpected field" });
  });
});

test("the existing maximum of 100 upload files is enforced", async () => {
  await withApp(multer({ storage: multer.memoryStorage() }), async (base) => {
    const form = new FormData();
    for (let index = 0; index < 101; index++) form.append("files", new Blob(["x"]), `${index}.txt`);
    const response = await fetch(base + "/api/upload-to-nextcloud", { method: "POST", body: form });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Multer error: Unexpected field" });
  });
});

test("filesystem errors with error codes remain HTTP 500 rather than becoming client errors", async () => {
  const upload = multer({ storage: {
    _handleFile(_req, _file, callback) {
      callback(Object.assign(new Error("storage unavailable"), { code: "EACCES" }));
    },
    _removeFile(_req, _file, callback) { callback(null); },
  } });
  await withApp(upload, async (base) => {
    const form = new FormData();
    form.append("files", new Blob(["document"]), "test.txt");
    const response = await fetch(base + "/api/upload-to-nextcloud", { method: "POST", body: form });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Unknown upload error: storage unavailable" });
  });
});

test("repository preview MIME types remain compatible, including uppercase extensions", () => {
  for (const [name, type] of [
    ["REPORT.PDF", "application/pdf"],
    ["photo.jpeg", "image/jpeg"],
    ["photo.heic", "image/heic"],
    ["form.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["table.csv", "text/csv"],
    ["archive.zip", "application/zip"],
    ["unknown.filetype", "application/octet-stream"],
  ]) assert.equal(getRepoMimeType(name), type);
});
