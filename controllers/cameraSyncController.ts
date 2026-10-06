import type { Request, Response } from "express";
import crypto from "node:crypto";
import path from "path";
import fs from "fs";

export function createCameraSyncController() {
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
    fingerprint: string; // first 128 chars of base64 payload — content-based dedup key
    imageData: string;
    fileName: string;
    mimeType: string;
    captureType: string; // "equipment" | "ticket" | ""
    ts: number;
  };

  const camPendingStore = new Map<string, CamCaptureEntry[]>();
  const camLoadedUsers = new Set<string>();
  const CAM_STORE_DIR = path.join(process.cwd(), "uploads", "smart-capture");

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
    };
  };

  const camEnsureLoaded = async (empId: string): Promise<void> => {
    if (camLoadedUsers.has(empId)) return;
    camLoadedUsers.add(empId);
    try {
      const raw = await fs.promises.readFile(camUserStoragePath(empId), "utf8");
      const parsed = JSON.parse(raw);
      const diskEntries = Array.isArray(parsed?.images)
        ? parsed.images.map(normalizeCamEntry).filter(Boolean) as CamCaptureEntry[]
        : [];
      const existing = camPendingStore.get(empId) ?? [];
      const merged = [...existing, ...diskEntries]
        .sort((left, right) => right.ts - left.ts)
        .filter((entry, index, list) =>
          list.findIndex(candidate =>
            candidate.eventId === entry.eventId ||
            candidate.fingerprint === entry.fingerprint
          ) === index
        );
      if (merged.length > 0) {
        camPendingStore.set(empId, merged);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        console.warn(`[CAM] Could not load saved captures for empId=${empId}:`, error?.message || error);
      }
    }
  };

  const camPersist = async (empId: string): Promise<void> => {
    await fs.promises.mkdir(CAM_STORE_DIR, { recursive: true });
    const filePath = camUserStoragePath(empId);
    const tempPath = `${filePath}.tmp`;
    const images = camPendingStore.get(empId) ?? [];
    if (images.length === 0) {
      await fs.promises.rm(filePath, { force: true });
      await fs.promises.rm(tempPath, { force: true });
      return;
    }
    await fs.promises.writeFile(tempPath, JSON.stringify({ images }, null, 2), "utf8");
    await fs.promises.rename(tempPath, filePath);
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
   * Returns false (and does NOT store) if an entry with the same content
   * fingerprint already exists — prevents the same photo from being pushed
   * multiple times (e.g. offline-queue retry race conditions).
   */
  const camStorePending = async (empId: string, entry: CamCaptureEntry): Promise<boolean> => {
    await camEnsureLoaded(empId);
    const existing = camPendingStore.get(empId) ?? [];
    if (existing.some(e => e.eventId === entry.eventId || e.fingerprint === entry.fingerprint)) return false; // duplicate image
    camPendingStore.set(empId, [entry, ...existing].sort((left, right) => right.ts - left.ts));
    await camPersist(empId);
    return true;
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
    };

    try {
      const stored = await camStorePending(empId, entry);
      if (!stored) {
        // Same photo content already in the pending store — return the existing eventId
        const existing = (camPendingStore.get(empId) ?? []).find(e => e.fingerprint === fingerprint);
        console.log(`[CAM] Duplicate push rejected — empId=${empId} fingerprint=${fingerprint.substring(0,20)}…`);
        return res.json({ success: true, eventId: existing?.eventId ?? eventId, duplicate: true });
      }

      camBroadcast(empId, { type: "capture", ...entry });
      console.log(`[CAM] Push from mobile — empId=${empId} eventId=${eventId} file=${entry.fileName}`);
      res.json({ success: true, eventId });
    } catch (error: any) {
      console.error(`[CAM] Failed to save capture — empId=${empId}:`, error?.message || error);
      res.status(500).json({ error: "Failed to save captured image." });
    }
  };

  // Desktop polls this endpoint to fetch images it missed while disconnected.
  const pending = async (req: Request, res: Response) => {
    const resolved = resolveCamEmployeeId(req, (req.query as any).empId);
    if (!resolved.empId) {
      return res.status(resolved.status ?? 401).json({ error: resolved.error || "Not authenticated" });
    }
    const empId = resolved.empId;
    try {
      await camEnsureLoaded(empId);
      const since = Number((req.query as any).since) || 0;
      const images = (camPendingStore.get(empId) ?? []).filter(e => e.ts > since);
      res.json({ images });
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
      await camEnsureLoaded(empId);
      const eventId = String(req.params.eventId || "").trim();
      const existing = camPendingStore.get(empId) ?? [];
      const next = existing.filter(entry => entry.eventId !== eventId);
      camPendingStore.set(empId, next);
      await camPersist(empId);
      res.json({ success: true, deleted: next.length !== existing.length });
    } catch (error: any) {
      console.error(`[CAM] Failed to delete capture — empId=${empId}:`, error?.message || error);
      res.status(500).json({ error: "Failed to delete captured image." });
    }
  };

  return { events, push, pending, deletePending };
}
