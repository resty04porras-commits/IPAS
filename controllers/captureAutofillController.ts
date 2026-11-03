import type { Request, Response } from "express";
import fs from "node:fs/promises";
import type { OcrSourceFile } from "../types/ocr.js";
import { CaptureAutofillError, type createCaptureAutofill } from "../services/captureAutofill.js";
import { equipmentCaptureSelection } from "../services/equipmentLabels.js";

export function createCaptureAutofillController(options: {
  autofill: ReturnType<typeof createCaptureAutofill>;
  getCapture: (employeeId: string, eventId: string) => Promise<{ imageData: string; fileName: string; mimeType: string; captureType: string; equipmentType?: string; equipmentUnitId?: string } | undefined>;
  prepareFile: (file: Express.Multer.File) => Promise<OcrSourceFile>;
}) {
  return async (req: Request, res: Response) => {
    const file = req.file;
    const stream = String(req.headers?.accept || "").includes("application/x-ndjson");
    const startedAt = Date.now();
    let firstDraftMs: number | undefined;
    function sendLine(value: unknown) {
      if (res.destroyed) return;
      if (!res.headersSent) {
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-store, no-transform");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
      }
      res.write(JSON.stringify(value) + "\n");
    }
    try {
      const employeeId = String((req as any).session?.user?.employeeId || "").trim();
      if (!employeeId) throw new CaptureAutofillError("Sign in to read captured images.", 401);
      let source: OcrSourceFile;
      let selection: ReturnType<typeof equipmentCaptureSelection>;
      const eventId = typeof req.body?.eventId === "string" ? req.body.eventId.trim() : "";
      if (eventId) {
        const capture = await options.getCapture(employeeId, eventId);
        if (!capture || capture.captureType === "ticket") throw new CaptureAutofillError("The equipment capture is no longer available for this account.", 404);
        selection = equipmentCaptureSelection(capture);
        const match = /^data:(image\/[^;,]+);base64,([a-z\d+/=\s]+)$/i.exec(capture.imageData);
        if (!match) throw new CaptureAutofillError("The captured image could not be read. Attach it again.", 400);
        source = { name: capture.fileName, kind: "image", contentType: "inlineData", content: match[2], mimeType: match[1] };
      } else {
        selection = equipmentCaptureSelection(req.body || {});
        if ((req.body?.equipmentType || req.body?.equipmentUnitId) && !selection) throw new CaptureAutofillError("Choose a valid equipment type and unit.", 400);
        if (!file || !file.mimetype.startsWith("image/")) throw new CaptureAutofillError("Attach one equipment image to read.", 400);
        source = await options.prepareFile(file);
      }
      const draft = await options.autofill.read(employeeId, source, req.body?.retry === true || req.body?.retry === "true", stream ? local => {
        if (firstDraftMs === undefined) firstDraftMs = Date.now() - startedAt;
        sendLine({ ...local, ...selection, employeeId, eventId: eventId || undefined, stage: "local", elapsedMs: Date.now() - startedAt });
      } : undefined);
      // A capture removed while its read was in flight must not repopulate UI.
      if (eventId && !await options.getCapture(employeeId, eventId)) throw new CaptureAutofillError("This capture was removed while reading.", 410);
      console.log(`[Capture reading] file="${source.name}" firstDraftMs=${firstDraftMs ?? Date.now() - startedAt} totalMs=${Date.now() - startedAt} cached=${draft.cached}`);
      if (stream) {
        sendLine({ ...draft, ...selection, employeeId, eventId: eventId || undefined, stage: "final", elapsedMs: Date.now() - startedAt });
        return res.end();
      }
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ...draft, ...selection, employeeId, eventId: eventId || undefined });
    } catch (error) {
      const known = error instanceof CaptureAutofillError;
      const message = known ? error.message : "Automatic reading could not finish. The photo was kept; review it manually or choose Retry reading.";
      if (res.headersSent) { sendLine({ stage: "error", error: message, status: known ? error.status : 503 }); return res.end(); }
      return res.status(known ? error.status : 503).json({ error: message });
    } finally { if (file) await fs.unlink(file.path).catch(() => undefined); }
  };
}
