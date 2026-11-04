import type { Request, Response } from "express";
import type { ComparisonContext, ComparisonProgress } from "./comparisonWorkflow.js";

/** Optional progress protocol; old JSON clients keep the same result array. */
export function createComparisonResponse(req: Request, res: Response) {
  const streaming = String(req.headers.accept || "").includes("application/x-ndjson");
  const started = Date.now(); let cancelled = false; let heartbeat: ReturnType<typeof setInterval> | undefined;
  const closed = () => { if (!res.writableEnded) cancelled = true; };
  const aborted = () => { cancelled = true; };
  res.on("close", closed); req.on("aborted", aborted);
  function send(value: unknown) {
    if (cancelled || res.destroyed || res.writableEnded) return;
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-transform"); res.setHeader("X-Accel-Buffering", "no"); res.flushHeaders();
      heartbeat = setInterval(() => send({ stage: "heartbeat", elapsedMs: Date.now() - started }), 10000);
      heartbeat.unref?.();
    }
    res.write(JSON.stringify(value) + "\n");
  }
  const progress = (value: ComparisonProgress) => { if (streaming) send({ stage: "progress", progress: value, elapsedMs: Date.now() - started }); };
  const context: ComparisonContext = { employeeId: String((req as any).session?.user?.employeeId || "").trim(),
    isCancelled: () => cancelled || res.destroyed, onProgress: streaming ? progress : undefined };
  return {
    context, progress,
    finish(results: unknown) {
      if (cancelled || res.destroyed) return;
      if (streaming) { send({ stage: "final", results, elapsedMs: Date.now() - started }); return res.end(); }
      res.setHeader("Cache-Control", "no-store"); return res.json(results);
    },
    fail(message: string, status: number) {
      if (cancelled || res.destroyed) return;
      if (streaming && res.headersSent) { send({ stage: "error", error: message, status }); return res.end(); }
      return res.status(status).json({ error: message });
    },
    dispose() { if (heartbeat) clearInterval(heartbeat); res.off("close", closed); req.off("aborted", aborted); },
  };
}
