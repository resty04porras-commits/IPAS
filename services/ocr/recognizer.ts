import type {
  OcrBatchProbe, OcrRecognition, OcrRecognizeOptions, OcrSnapshot,
  OcrSourceFile, OcrWorkerResult,
} from "../../types/ocr.js";
import { buildPlainTextSnapshot } from "./snapshots.js";

type ServiceOptions = OcrRecognizeOptions & { rectangles?: OcrBatchProbe[] };
type WorkerRequest = ServiceOptions & { imageBase64: string };
type WorkerOptions = { timeoutMs?: number; retries?: number; resetOnTimeout?: boolean; workerSlot?: number };

interface OcrDependencies {
  engine: string;
  requestService: (file: OcrSourceFile, options?: ServiceOptions) => Promise<OcrWorkerResult>;
  requestWorker: (request: WorkerRequest, options?: WorkerOptions) => Promise<OcrWorkerResult>;
  probeTimeoutMs: number;
  logger?: Pick<Console, "log" | "warn">;
}

// "paddle" remains the existing compatibility alias for the HTTP OCR service.
export function shouldUseOcrService(engine: string): boolean {
  return ["easyocr", "paddle"].includes(engine.trim().toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOcrRecognizer(dependencies: OcrDependencies) {
  const { requestService, requestWorker, probeTimeoutMs, logger = console } = dependencies;
  const useService = shouldUseOcrService(dependencies.engine);

  async function run<T>(
    file: OcrSourceFile,
    service: () => Promise<T>,
    worker: () => Promise<T>,
  ): Promise<{ value: T; engine: "easyocr-service" | "legacy-worker"; fallback: boolean; primaryError?: string }> {
    const startedAt = Date.now();
    let primaryError: unknown;
    if (useService) {
      try {
        const value = await service();
        logger.log(`[OCR] engine=easyocr-service file="${file.name}" elapsed=${Date.now() - startedAt}ms fallback=false`);
        return { value, engine: "easyocr-service", fallback: false };
      } catch (error) {
        primaryError = error;
        logger.warn(`[OCR] engine=easyocr-service file="${file.name}" failed=true error=${errorMessage(error)}`);
      }
    }
    try {
      const value = await worker();
      logger.log(`[OCR] engine=legacy-worker file="${file.name}" elapsed=${Date.now() - startedAt}ms fallback=${useService}`);
      return {
        value,
        engine: "legacy-worker",
        fallback: useService,
        ...(useService ? { primaryError: errorMessage(primaryError) } : {}),
      };
    } catch (error) {
      if (!useService) throw error;
      throw new AggregateError(
        [primaryError, error],
        `Both OCR engines failed. EasyOCR service: ${errorMessage(primaryError)}; legacy worker: ${errorMessage(error)}`,
      );
    }
  }

  function requireSnapshot(result: OcrWorkerResult): OcrSnapshot {
    if (!result?.snapshot || typeof result.snapshot !== "object") {
      throw new Error("OCR engine returned no snapshot.");
    }
    return result.snapshot;
  }

  async function recognizeOcrDetailed(file: OcrSourceFile, options: OcrRecognizeOptions = {}): Promise<OcrRecognition> {
    if (file.contentType !== "inlineData") {
      return { snapshot: buildPlainTextSnapshot(file.content || ""), engine: "text", fallback: false };
    }
    const settings = { rectangle: options.rectangle, mode: options.mode || "full" };
    const result = await run(
      file,
      async () => requireSnapshot(await requestService(file, settings)),
      async () => requireSnapshot(await requestWorker({ imageBase64: file.content, ...settings })),
    );
    const { value: snapshot, ...metadata } = result;
    return { snapshot, ...metadata };
  }

  async function recognizeOcrSnapshot(file: OcrSourceFile, options: OcrRecognizeOptions = {}): Promise<OcrSnapshot> {
    return (await recognizeOcrDetailed(file, options)).snapshot;
  }

  async function recognizeOcrSnapshotBatch(file: OcrSourceFile, probes: OcrBatchProbe[]): Promise<Record<string, OcrSnapshot>> {
    if (probes.length === 0) return {};
    if (file.contentType !== "inlineData") {
      const snapshot = buildPlainTextSnapshot(file.content || "");
      return Object.fromEntries(probes.map((probe) => [probe.key, snapshot]));
    }
    function requireSnapshots(result: OcrWorkerResult): Record<string, OcrSnapshot> {
      const snapshots = result?.snapshots;
      if (!snapshots || probes.some(({ key }) => !Object.hasOwn(snapshots, key) || !snapshots[key] || typeof snapshots[key] !== "object")) {
        throw new Error("OCR engine returned an incomplete batch of probe snapshots.");
      }
      return snapshots;
    }
    const result = await run(
      file,
      async () => requireSnapshots(await requestService(file, { rectangles: probes, mode: "probe" })),
      async () => requireSnapshots(await requestWorker(
        { imageBase64: file.content, rectangles: probes, mode: "probe" },
        { timeoutMs: probeTimeoutMs, retries: 0, resetOnTimeout: false },
      )),
    );
    return result.value;
  }

  return { recognizeOcrDetailed, recognizeOcrSnapshot, recognizeOcrSnapshotBatch };
}
