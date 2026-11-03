import type { Request, Response } from "express";
import crypto from "node:crypto";
import path from "path";
import fs from "fs";
import { equipmentCaptureSelection, canonicalEquipmentComponent } from "../services/equipmentLabels.js";

export type CaptureUploadFile = { fileName: string; sha256: string };
export type CaptureUploadReceipt = {
  status: "complete" | "retained";
  employeeId?: string;
  removedEventIds?: string[];
  savedFiles?: CaptureUploadFile[];
  warning?: string;
};

export function createCameraSyncController(options: { storeDirectory?: string } = {}) {
  //
  // Architecture:
  //   • Mobile   → POST /api/cam/push    (sends base64 image)
  //   • Server   → broadcasts to all SSE listeners for same employeeId
  //   • Desktop  → GET  /api/cam/events  (SSE stream, receives captures)
  //   • Desktop  → GET  /api/cam/pending (polls for missed images on reconnect)
  //
  // Images are stored server-side by employeeId so captures taken while a
  // desktop is offline are available the next time the same account opens.
  // Channel is scoped by employeeId — same user on mobile + desktop.
  // ─────────────────────────────────────────────────────────────────────

  /** employeeId → Set of active SSE response objects */
  const camSseClients = new Map<string, Set<any>>();

  /** employeeId → array of recent captures (newest first) */
  type CamCaptureEntry = {
    eventId: string;
    fingerprint: string; // content-based dedup key that skips common image headers
    imageData: string;
    fileName: string;
    mimeType: string;
    captureType: string; // "equipment" | "ticket" | ""
    ts: number;
    sourceSha256?: string; // original phone photo, before its transmitted copy is resized
    equipmentType?: string;
    equipmentUnitId?: string;
    equipmentUnitNumber?: number;
    equipmentCaptureIndex?: number;
    equipmentCaptureCount?: number;
    equipmentProgressVersion?: number;
  };

  const camPendingStore = new Map<string, CamCaptureEntry[]>();
  const camLoadedUsers = new Set<string>();
  const CAM_STORE_DIR = options.storeDirectory || path.join(process.cwd(), "uploads", "smart-capture");
  const camUserQueues = new Map<string, Promise<unknown>>();

  // Reads, loading and writes for one account share a queue. A late push/poll
  // must not persist an older snapshot after a deletion has been acknowledged.
  const camSerial = <T>(empId: string, action: () => Promise<T>): Promise<T> => {
    const previous = camUserQueues.get(empId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    camUserQueues.set(empId, next);
    return next.finally(() => {
      if (camUserQueues.get(empId) === next) camUserQueues.delete(empId);
    });
  };

  const camUserStoragePath = (empId: string): string => {
    const userKey = crypto.createHash("sha256").update(empId).digest("hex").slice(0, 32);
    return path.join(CAM_STORE_DIR, `${userKey}.json`);
  };

  const normalizeCamEntry = (value: any): CamCaptureEntry | null => {
    if (!value || typeof value !== "object") return null;
    if (typeof value.eventId !== "string" || !value.eventId.trim()) return null;
    if (typeof value.imageData !== "string" || !value.imageData.startsWith("data:")) return null;
    return {
      eventId: value.eventId.trim(),
      fingerprint: typeof value.fingerprint === "string" && value.fingerprint.trim()
        ? value.fingerprint.trim()
        : camFingerprint(value.imageData),
      imageData: value.imageData,
      fileName: typeof value.fileName === "string" && value.fileName.trim()
        ? value.fileName.trim()
        : `capture-${Number(value.ts) || Date.now()}.jpg`,
      mimeType: typeof value.mimeType === "string" && value.mimeType.trim()
        ? value.mimeType.trim()
        : "image/jpeg",
      captureType: typeof value.captureType === "string" ? value.captureType.trim() : "",
      ts: Number(value.ts) || Date.now(),
      sourceSha256: validSha256(value.sourceSha256),
      ...(value.captureType === "equipment" ? equipmentCaptureSelection(value) : undefined),
      ...(value.captureType === "equipment" && equipmentCaptureSelection(value) ? {
        equipmentUnitNumber: positiveInteger(value.equipmentUnitNumber),
        equipmentProgressVersion: positiveInteger(value.equipmentProgressVersion),
      } : undefined),
    };
  };

  const positiveInteger = (value: unknown): number | undefined =>
    Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
  const typeKey = (value: string) => canonicalEquipmentComponent(value).toUpperCase();
  // All fields are derived under the account's existing mutation queue. Client
  // counters/numbers never authorize a fifth photo or overwrite the server's.
  function numberUnits(images: CamCaptureEntry[], changedUnit?: string): CamCaptureEntry[] {
    const next = images.map(entry => ({ ...entry }));
    const units = new Map<string, CamCaptureEntry[]>();
    next.slice().reverse().sort((a,b) => a.ts - b.ts).forEach(entry => {
      if (entry.captureType !== "equipment" || !equipmentCaptureSelection(entry)) return;
      const members = units.get(entry.equipmentUnitId!) || []; members.push(entry); units.set(entry.equipmentUnitId!, members);
    });
    const maxima = new Map<string, number>();
    units.forEach(members => {
      const number = members.map(entry => positiveInteger(entry.equipmentUnitNumber)).find(Boolean);
      if (number) maxima.set(typeKey(members[0].equipmentType!), Math.max(maxima.get(typeKey(members[0].equipmentType!)) || 0, number));
    });
    units.forEach((members, id) => {
      const key = typeKey(members[0].equipmentType!);
      let number = members.map(entry => positiveInteger(entry.equipmentUnitNumber)).find(Boolean);
      if (!number) { number = (maxima.get(key) || 0) + 1; maxima.set(key, number); }
      const previousVersion = Math.max(...members.map(entry => entry.equipmentProgressVersion || entry.ts));
      const version = changedUnit === id ? Math.max(Date.now(), previousVersion + 1) : previousVersion;
      members.forEach((entry,index) => Object.assign(entry, { equipmentUnitNumber: number, equipmentCaptureIndex: index + 1,
        equipmentCaptureCount: members.length, equipmentProgressVersion: version }));
    });
    return next;
  }
  const progressOf = (entry: CamCaptureEntry) => entry.equipmentUnitId ? {
    ...equipmentCaptureSelection(entry), equipmentUnitNumber: entry.equipmentUnitNumber,
    equipmentCaptureIndex: entry.equipmentCaptureIndex, equipmentCaptureCount: entry.equipmentCaptureCount,
    equipmentCaptureLimit: 4, equipmentProgressVersion: entry.equipmentProgressVersion,
  } : {};
  const unitSummaries = (images: CamCaptureEntry[]) => images.filter((entry,index) => entry.equipmentUnitId &&
    images.findIndex(other => other.equipmentUnitId === entry.equipmentUnitId) === index).map(entry => ({
      ...progressOf(entry), captures: images.filter(other => other.equipmentUnitId === entry.equipmentUnitId)
        .sort((a,b) => (a.equipmentCaptureIndex || 0) - (b.equipmentCaptureIndex || 0))
        .map(other => ({ eventId: other.eventId, equipmentCaptureIndex: other.equipmentCaptureIndex })),
    }));
  const removedProgress = (entry: CamCaptureEntry, remaining: CamCaptureEntry[]) => {
    if (!entry.equipmentUnitId) return {};
    const saved = remaining.find(other => other.equipmentUnitId === entry.equipmentUnitId);
    return { ...progressOf(saved || entry), equipmentCaptureCount: saved?.equipmentCaptureCount || 0,
      equipmentProgressVersion: saved?.equipmentProgressVersion || Math.max(Date.now(), (entry.equipmentProgressVersion || 0) + 1) };
  };

  const camEnsureLoaded = async (empId: string): Promise<void> => {
    if (camLoadedUsers.has(empId)) return;
    try {
      const raw = await fs.promises.readFile(camUserStoragePath(empId), "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.images)) throw new Error("Invalid capture storage format.");
      const diskEntries = Array.isArray(parsed?.images)
        ? parsed.images.map(normalizeCamEntry).filter(Boolean) as CamCaptureEntry[]
        : [];
      const merged = diskEntries
        .sort((left, right) => right.ts - left.ts)
        .filter((entry, index, list) =>
          list.findIndex(candidate =>
            candidate.eventId === entry.eventId ||
            candidate.fingerprint === entry.fingerprint
          ) === index
        );
      camPendingStore.set(empId, numberUnits(merged));
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        console.warn(`[CAM] Could not load saved captures for empId=${empId}:`, error?.message || error);
        throw error;
      }
    }
    camLoadedUsers.add(empId);
  };

  const camPersist = async (empId: string, images: CamCaptureEntry[]): Promise<void> => {
    await fs.promises.mkdir(CAM_STORE_DIR, { recursive: true, mode: 0o700 });
    const filePath = camUserStoragePath(empId);
    const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    if (images.length === 0) {
      await fs.promises.rm(filePath, { force: true });
      return;
    }
    try {
      await fs.promises.writeFile(tempPath, JSON.stringify({ images }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await fs.promises.rename(tempPath, filePath);
    } finally { await fs.promises.rm(tempPath, { force: true }).catch(() => undefined); }
  };

  const resolveCamEmployeeId = (
    req: Request,
    suppliedEmpId?: unknown
  ): { empId: string; status?: number; error?: string } => {
    const sessionEmpId = String((req as any).session?.user?.employeeId || "").trim();
    const requestedEmpId = typeof suppliedEmpId === "string" ? suppliedEmpId.trim() : "";

    if (sessionEmpId && requestedEmpId && sessionEmpId !== requestedEmpId) {
      return { empId: "", status: 403, error: "Capture account does not match the logged-in account." };
    }

    const empId = sessionEmpId || requestedEmpId;
    if (!empId) {
      return { empId: "", status: 401, error: "Not authenticated" };
    }

    return { empId };
  };

  /**
   * Derive a fingerprint from a data-URL that is unique per image content.
   * Canvas toDataURL("image/jpeg", quality) produces identical JFIF headers,
   * quantization tables, and Huffman tables for all images at the same quality
   * level — the first ~1024 base64 chars are shared by every photo. Sampling
   * those bytes causes every second capture to be treated as a duplicate.
   * Fix: skip the common header region and sample from the actual scan data.
   */
  const camFingerprint = (imageData: string): string => {
    const raw = imageData.replace(/^data:[^;]+;base64,/, "");
    const len = raw.length;
    const pos = Math.max(1200, Math.floor(len * 0.35));
    return len + ":" + raw.substring(pos, pos + 180);
  };

  const validSha256 = (value: unknown): string | undefined =>
    typeof value === "string" && /^[a-f\d]{64}$/i.test(value) ? value.toLowerCase() : undefined;
  const imageSha256 = (entry: CamCaptureEntry): string | undefined => {
    const match = /^data:[^,]*;base64,([a-z\d+/=\s]+)$/i.exec(entry.imageData);
    return match ? crypto.createHash("sha256").update(Buffer.from(match[1], "base64")).digest("hex") : undefined;
  };

  /** Write an SSE event to every desktop listener for this user. */
  const camBroadcast = (empId: string, payload: Record<string, unknown>): void => {
    const clients = camSseClients.get(empId);
    if (!clients?.size) return;
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const clientRes of clients) {
      try { clientRes.write(msg); } catch (_) { /* client already gone */ }
    }
  };

  /**
   * Add a capture to the pending store and persist it server-side.
   * Returns the existing entry (and does NOT store) if the same content
   * fingerprint already exists — prevents the same photo from being pushed
   * multiple times (e.g. offline-queue retry race conditions).
   */
  const camStorePending = (empId: string, entry: CamCaptureEntry) => camSerial(empId, async () => {
    await camEnsureLoaded(empId);
    const existing = camPendingStore.get(empId) ?? [];
    if (entry.equipmentUnitId && existing.some(saved => saved.equipmentUnitId === entry.equipmentUnitId && saved.equipmentType !== entry.equipmentType)) {
      throw Object.assign(new Error("This equipment unit already has a different type. Choose New unit."), { status: 400 });
    }
    const duplicate = existing.find(e => e.eventId === entry.eventId || e.fingerprint === entry.fingerprint);
    if (duplicate) return { stored: false, entry: duplicate };
    const members = entry.equipmentUnitId ? existing.filter(saved => saved.equipmentUnitId === entry.equipmentUnitId) : [];
    if (entry.equipmentUnitId && members.length >= 4) {
      throw Object.assign(new Error("This unit already has four photos. Continue with a new unit, or remove an unneeded photo before attaching another."), {
        status: 409, code: "EQUIPMENT_CAPTURE_LIMIT", progress: progressOf(members[0]),
      });
    }
    const next = numberUnits([entry, ...existing].sort((left, right) => right.ts - left.ts), entry.equipmentUnitId);
    await camPersist(empId, next);
    camPendingStore.set(empId, next);
    const saved = next.find(saved => saved.eventId === entry.eventId)!;
    camBroadcast(empId, { type: "capture", ...saved });
    return { stored: true, entry: saved };
  });

  // Snapshot before WebDAV writes. The returned closure is called ONLY after
  // every file succeeds. New captures, tickets and other accounts stay intact.
  const prepareStorageUpload = async (req: Request, files: CaptureUploadFile[]) => {
    const empId = String((req as any).session?.user?.employeeId || "").trim();
    if (!empId) throw new Error("Sign in to clear captures after uploading. The saved files were kept.");
    const hashes = new Set(files.map(file => validSha256(file.sha256)).filter(Boolean));
    const selectedIds = await camSerial(empId, async () => {
      await camEnsureLoaded(empId);
      return new Set((camPendingStore.get(empId) ?? [])
        .filter(entry => entry.captureType !== "ticket" &&
          (hashes.has(imageSha256(entry)) || (entry.sourceSha256 && hashes.has(entry.sourceSha256))))
        .map(entry => entry.eventId));
    });
    return (): Promise<CaptureUploadReceipt> => camSerial(empId, async () => {
      const existing = camPendingStore.get(empId) ?? [];
      const removed = existing.filter(entry => selectedIds.has(entry.eventId));
      if (removed.length) {
        let next = existing.filter(entry => !selectedIds.has(entry.eventId));
        for (const id of new Set(removed.map(entry => entry.equipmentUnitId).filter(Boolean))) next = numberUnits(next, id);
        await camPersist(empId, next);
        camPendingStore.set(empId, next);
        for (const entry of removed) camBroadcast(empId, {
          type: "deleted", reason: "uploaded", eventId: entry.eventId,
          fileName: entry.fileName, captureType: entry.captureType,
          imageSha256: imageSha256(entry), sourceSha256: entry.sourceSha256,
          ...removedProgress(entry, next),
        });
      }
      return { status: "complete", employeeId: empId,
        removedEventIds: removed.map(entry => entry.eventId), savedFiles: files };
    });
  };

  // Desktop opens this SSE stream to receive live camera captures from mobile.
  const events = (req: Request, res: Response) => {
    // Accept empId from session (preferred) or explicit query param (fallback for HTTP where
    // Secure cookies are not forwarded).  The client always sends the empId it received from
    // the login response, so this is safe for this internal single-org deployment.
    const resolved = resolveCamEmployeeId(req, (req.query as any).empId);
    if (!resolved.empId) {
      return res.status(resolved.status ?? 401).json({ error: resolved.error || "Not authenticated" });
    }
    const empId = resolved.empId;

    // Override the middleware-set application/json content-type BEFORE flush.
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // prevent nginx from buffering SSE
    res.flushHeaders();

    // Confirm connection to the client.
    res.write(`data: ${JSON.stringify({ type: "connected", empId, ts: Date.now() })}\n\n`);

    // Register this desktop client.
    if (!camSseClients.has(empId)) camSseClients.set(empId, new Set());
    camSseClients.get(empId)!.add(res);
    console.log(`[CAM] Desktop SSE connected — empId=${empId} clients=${camSseClients.get(empId)!.size}`);

    // Keep-alive ping every 25 s (browsers close idle SSE after ~30 s).
    const ping = setInterval(() => {
      try { res.write(`data: ${JSON.stringify({ type: "ping", ts: Date.now() })}\n\n`); }
      catch (_) { /* already closed */ }
    }, 25_000);

    // Cleanup on disconnect.
    req.on("close", () => {
      clearInterval(ping);
      const set = camSseClients.get(empId);
      set?.delete(res);
      if (!set?.size) camSseClients.delete(empId);
      console.log(`[CAM] Desktop SSE disconnected — empId=${empId}`);
    });
  };

  // Mobile posts a captured image here; server broadcasts it to all desktops.
  const push = async (req: Request, res: Response) => {
    const body = req.body as Record<string, string>;
    const resolved = resolveCamEmployeeId(req, body.empId);
    if (!resolved.empId) {
      return res.status(resolved.status ?? 401).json({ error: resolved.error || "Not authenticated" });
    }
    const empId = resolved.empId;

    const { imageData, fileName, mimeType, captureType } = body;

    const selection = captureType === "equipment" ? equipmentCaptureSelection(body) : undefined;
    if (captureType === "equipment" && (body.equipmentType || body.equipmentUnitId) && !selection) {
      return res.status(400).json({ error: "Choose a valid equipment type and unit before capturing." });
    }

    if (typeof imageData !== "string" || !imageData.startsWith("data:")) {
      return res.status(400).json({ error: "imageData must be a base64 data URL." });
    }

    const fingerprint = camFingerprint(imageData);
    const eventId     = crypto.randomUUID();
    const entry = {
      eventId,
      fingerprint,
      imageData,
      fileName: (typeof fileName === "string" && fileName.trim())
        ? fileName.trim()
        : `capture-${Date.now()}.jpg`,
      mimeType: (typeof mimeType === "string" && mimeType.trim())
        ? mimeType.trim()
        : "image/jpeg",
      captureType: (typeof captureType === "string" && captureType.trim())
        ? captureType.trim()
        : "",
      ts: Date.now(),
      sourceSha256: validSha256(body.sourceSha256),
      ...selection,
    };

    try {
      const result = await camStorePending(empId, entry);
      if (!result.stored) {
        // Same photo content already in the pending store — return the existing eventId
        console.log(`[CAM] Duplicate push rejected — empId=${empId} fingerprint=${fingerprint.substring(0,20)}…`);
        return res.json({ success: true, eventId: result.entry.eventId, duplicate: true, ...progressOf(result.entry) });
      }

      console.log(`[CAM] Push from mobile — empId=${empId} eventId=${eventId} file=${entry.fileName}`);
      res.json({ success: true, eventId, ...progressOf(result.entry) });
    } catch (error: any) {
      if (error?.status === 400) return res.status(400).json({ error: error.message });
      if (error?.status === 409) return res.status(409).json({ error: error.message, code: error.code, ...error.progress });
      console.error(`[CAM] Failed to save capture — empId=${empId}:`, error?.message || error);
      res.status(500).json({ error: "Failed to save captured image." });
    }
  };

  // Desktop polls this endpoint to fetch images it missed while disconnected.
  const pending = async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const resolved = resolveCamEmployeeId(req, (req.query as any).empId);
    if (!resolved.empId) {
      return res.status(resolved.status ?? 401).json({ error: resolved.error || "Not authenticated" });
    }
    const empId = resolved.empId;
    try {
      const since = Number((req.query as any).since) || 0;
      const snapshot = await camSerial(empId, async () => {
        await camEnsureLoaded(empId);
        const all = camPendingStore.get(empId) ?? [];
        return { images: req.query.unitsOnly === "true" ? [] : all.filter(e => e.ts > since), units: unitSummaries(all) };
      });
      res.json(snapshot);
    } catch (error: any) {
      console.error(`[CAM] Failed to load captures — empId=${empId}:`, error?.message || error);
      res.status(500).json({ error: "Failed to load captured images." });
    }
  };

  const deletePending = async (req: Request, res: Response) => {
    const resolved = resolveCamEmployeeId(req, (req.query as any).empId);
    if (!resolved.empId) {
      return res.status(resolved.status ?? 401).json({ error: resolved.error || "Not authenticated" });
    }

    const empId = resolved.empId;
    try {
      const eventId = String(req.params.eventId || "").trim();
      if (!eventId) return res.status(400).json({ error: "Capture id is required." });
      const deleted = await camSerial(empId, async () => {
        await camEnsureLoaded(empId);
        const existing = camPendingStore.get(empId) ?? [];
        const entry = existing.find(value => value.eventId === eventId);
        if (!entry) return false;
        const next = numberUnits(existing.filter(value => value.eventId !== eventId), entry.equipmentUnitId);
        await camPersist(empId, next);
        camPendingStore.set(empId, next);
        camBroadcast(empId, { type: "deleted", eventId, fileName: entry.fileName, captureType: entry.captureType,
          ...removedProgress(entry, next),
        });
        return true;
      });
      res.json({ success: true, deleted });
    } catch (error: any) {
      console.error(`[CAM] Failed to delete capture — empId=${empId}:`, error?.message || error);
      res.status(500).json({ error: "Failed to delete captured image." });
    }
  };

  const getCaptureForAutofill = (employeeId: string, eventId: string) => camSerial(employeeId, async () => {
    await camEnsureLoaded(employeeId);
    const entry = (camPendingStore.get(employeeId) ?? []).find(entry => entry.eventId === eventId);
    return entry ? { ...entry } : undefined;
  });
  return { events, push, pending, deletePending, prepareStorageUpload, getCaptureForAutofill };
}
