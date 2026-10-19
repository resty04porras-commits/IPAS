import { Buffer } from "node:buffer";
import type { BarcodeScanResult } from "../../types/barcode.js";
import type { OcrBatchProbe, OcrRecognizeOptions, OcrSourceFile, OcrWorkerResult } from "../../types/ocr.js";
import { buildPlainTextSnapshot, toOcrSnapshot } from "./snapshots.js";

type ServiceOptions = OcrRecognizeOptions & { rectangles?: OcrBatchProbe[] };

interface HttpClientDependencies<TRecord> {
  serviceUrl: string;
  timeoutMs: number;
  ensureReady: () => Promise<void>;
  scanBarcodeLocally: (file: OcrSourceFile, timeoutMs: number) => Promise<BarcodeScanResult<TRecord>>;
  logger?: Pick<Console, "log" | "warn">;
}

async function serviceError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = await response.json().catch(() => null);
    return String(payload?.error || payload?.detail || `OCR service returned ${response.status}.`);
  }
  return await response.text().catch(() => `OCR service returned ${response.status}.`);
}

function imageForm(file: OcrSourceFile): FormData {
  const form = new FormData();
  const bytes = Buffer.from(file.content, "base64");
  form.append("file", new Blob([bytes], { type: file.mimeType || "application/octet-stream" }), file.name || "image");
  return form;
}

/** Transport only. Service startup, worker processes and engine selection stay with their owners. */
export function createOcrHttpClient<TRecord = unknown>(dependencies: HttpClientDependencies<TRecord>) {
  const { serviceUrl, timeoutMs: requestTimeoutMs, ensureReady, scanBarcodeLocally, logger = console } = dependencies;

  async function requestOcr(file: OcrSourceFile, options: ServiceOptions = {}): Promise<OcrWorkerResult> {
    if (file.contentType !== "inlineData") {
      return { snapshot: buildPlainTextSnapshot(file.content || "") };
    }
    await ensureReady();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const form = imageForm(file);
    form.append("mode", options.mode || (options.rectangles ? "probe" : "full"));
    if (options.rectangle) form.append("rectangle", JSON.stringify(options.rectangle));
    if (options.rectangles) form.append("rectangles", JSON.stringify(options.rectangles));
    const startedAt = Date.now();
    try {
      const response = await fetch(`${serviceUrl}/ocr`, { method: "POST", body: form, signal: controller.signal });
      const elapsedMs = Date.now() - startedAt;
      if (!response.ok) throw new Error(await serviceError(response));
      const payload = await response.json();
      if (payload?.error) throw new Error(String(payload.error));
      const result: OcrWorkerResult = {};
      if (payload?.snapshot) result.snapshot = toOcrSnapshot(payload.snapshot);
      else if (payload?.text || payload?.lines) result.snapshot = toOcrSnapshot(payload);
      if (payload?.snapshots && typeof payload.snapshots === "object") {
        result.snapshots = Object.fromEntries(Object.entries(payload.snapshots).map(([key, snapshot]) => [key, toOcrSnapshot(snapshot)]));
      }
      logger.log(`[OCR] engine=easyocr-service file="${file.name}" elapsed=${elapsedMs}ms fallback=false`);
      return result;
    } catch (error: any) {
      if (error?.name === "AbortError") throw new Error(`Python EasyOCR service timed out after ${Math.round(requestTimeoutMs / 1000)} seconds.`);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  async function requestBarcode(file: OcrSourceFile, options: { timeoutMs?: number } = {}): Promise<BarcodeScanResult<TRecord>> {
    if (file.contentType !== "inlineData" || file.kind !== "image") {
      return { success: false, barcode: null, matched: false, record: null, message: "Barcode scan accepts image files only." };
    }
    await ensureReady();
    const controller = new AbortController();
    const timeoutMs = Math.max(500, Math.min(requestTimeoutMs, options.timeoutMs ?? requestTimeoutMs));
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const form = imageForm(file);
    const startedAt = Date.now();
    try {
      const response = await fetch(`${serviceUrl}/barcode`, { method: "POST", body: form, signal: controller.signal });
      const elapsedMs = Date.now() - startedAt;
      if (!response.ok) {
        if (response.status === 404) {
          logger.warn("[Barcode] OCR service does not expose /barcode yet. Falling back to local OpenCV worker.");
          return scanBarcodeLocally(file, timeoutMs);
        }
        throw new Error(await serviceError(response));
      }
      const payload = await response.json();
      const barcode = typeof payload?.barcode === "string" && payload.barcode.trim() ? payload.barcode.trim() : null;
      const engine = payload?.raw?.engine === "zxing-cpp" ? "zxing-cpp" : "opencv";
      logger.log(`[Barcode] engine=${engine}-service file="${file.name}" detected=${Boolean(barcode)} elapsed=${elapsedMs}ms`);
      return {
        success: Boolean(payload?.success), barcode,
        type: typeof payload?.type === "string" ? payload.type : null,
        matched: false, record: null,
        message: typeof payload?.message === "string" ? payload.message : barcode ? "Barcode detected." : "No barcode detected. Please capture a clearer image.",
        barcodes: Array.isArray(payload?.barcodes) ? payload.barcodes : [],
        engine,
        durationMs: typeof payload?.durationMs === "number" ? payload.durationMs : elapsedMs,
      };
    } catch (error: any) {
      if (error?.name === "AbortError") throw new Error(`Barcode scan timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  return { requestOcr, requestBarcode };
}
