import { generateLiquidationReferencePdfExport } from "./services/liquidationPdf.js";
import {
  getLiquidationReferenceExcelPath,
  normalizeLiquidationTableTime,
  generateLiquidationExcelExport,
} from "./services/liquidationWorkbook.js";
import { extractZipEntryBuffer } from "./services/zipArchive.js";
import {
  normalizeLiquidationRecord,
  buildManualLiquidationFallback,
  sanitizeLiquidationPayload,
  parseCurrencyNumber,
  calculateLiquidationTotals,
  type LiquidationRecord,
  type LiquidationFormPayload,
} from "./services/liquidationRecords.js";
import type {
  OcrSourceFile as CompareSourceFile, OcrBBox, OcrLineEntry, OcrSnapshot, OcrRecognizeOptions,
} from "./types/ocr.js";
import { buildPlainTextSnapshot, sanitizeOcrValue } from "./services/ocr/snapshots.js";
import { createLiquidationTextParser } from "./services/liquidationText.js";
import { createStructuredAiClient, extractUpstreamErrorMessage, isGeminiRateLimit, isGeminiUnavailable, isInvalidStructuredResponse } from "./services/structuredAi.js";
import { buildSourceParts, prepareUploadedFileForComparison } from "./services/uploadedSources.js";
import { createBarcodeWorker } from "./services/ocr/barcodeWorker.js";
import { createOcrWorkerPool } from "./services/ocr/workerPool.js";
import { createOcrServiceLifecycle } from "./services/ocr/serviceLifecycle.js";
import { createOcrHttpClient } from "./services/ocr/httpClient.js";
import { createOcrRecognizer, shouldUseOcrService } from "./services/ocr/recognizer.js";
import express, { Request } from "express";
import dns from "node:dns/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "net";
import os from "os";
import path from "path";
import multer from "multer";
import { createClient } from "webdav";
import {
  normalizeNextcloudPath,
  sanitizeNextcloudSegment,
  resolveNextcloudConfig,
  getWebDAVClient,
  verifyWebDAVConnection,
} from "./services/nextcloudClient.js";
import fs from "fs";
import cookieSession from "cookie-session";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import * as XLSX from "xlsx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import terRoutes from "./routes/terRoutes.js";
import { createTerLiquidationController } from "./controllers/terController.js";
import assetRoutes from "./routes/assetRoutes.js";
import { createAccountabilityController } from "./controllers/accountabilityController.js";
import { createAccountabilityRoutes } from "./routes/accountabilityRoutes.js";
import { createManagementController } from "./controllers/managementController.js";
import { createManagementRoutes } from "./routes/managementRoutes.js";
import { createAuthController } from "./controllers/authController.js";
import { createAuthRoutes } from "./routes/authRoutes.js";
import { createDocumentRepositoryController } from "./controllers/documentRepositoryController.js";
import { registerDocumentRepositoryRoutes } from "./routes/documentRepository.js";
import { getRepoMimeType } from "./services/documentRepositoryMime.js";
import { createCameraSyncController } from "./controllers/cameraSyncController.js";
import { createCameraSyncRoutes } from "./routes/cameraSyncRoutes.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true } as any);
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true, quiet: true } as any);

type CompareRecord = {
  sn: string;
  district: string;
  branch: string;
  components: string;
  description: string;
  hardwareId: string;
  serial: string;
  remarks: string;
};

type CompareResult = {
  doc: CompareRecord;
  img: CompareRecord;
  status: "match" | "mismatch" | "missing";
  mismatchedFields: string[];
  fieldNotes?: Partial<Record<ComparisonField, string>>;
  notes?: string;
};

type ExtractedCompareRecord = CompareRecord & {
  notes?: string;
};

type ComparisonField = "components" | "description" | "hardwareId" | "serial";

type IntakeRecord = {
  sourceName: string;
  components: string;
  description: string;
  hardwareId: string;
  serial: string;
  remarks: string;
  notes?: string;
};

type IntakeExtractionSummary = {
  requested: number;
  extracted: number;
  cached: number;
  manual: number;
  usedFallback: boolean;
  message?: string;
};

type IntakeExtractionResponse = {
  records: IntakeRecord[];
  summary: IntakeExtractionSummary;
};

type ReferenceRecord = IntakeRecord;

type BarcodeScanResult = import("./types/barcode.js").BarcodeScanResult<IntakeRecord>;

type AccountabilityFormPayload = {
  employeeName: string;
  employeeId: string;
  designation: string;
  department: string;
  effectiveDate: string;
  signature: string;
  signatureDataUrl?: string;
  processedBy: string;
  processedDate: string;
  checkedBy: string;
  checkedDate: string;
  verifiedBy: string;
  verifiedTitle: string;
  verifiedDate: string;
  notedBy: string;
  notedTitle: string;
  notedDate: string;
  items: IntakeRecord[];
};

type AccountabilityExportFormat = "xlsx" | "pdf";

type PersistedTerTravelEntry = LiquidationRecord & {
  id: string;
  terId: string;
  createdAt: string;
  updatedAt: string;
  ticketFileName?: string;
  ticketMimeType?: string;
  ticketImageData?: string;
};

type LiquidationExtractionSummary = {
  requested: number;
  extracted: number;
  manual: number;
  usedFallback: boolean;
  message?: string;
};

type LiquidationExtractionResponse = {
  records: LiquidationRecord[];
  summary: LiquidationExtractionSummary;
};

type LiquidationExportFormat = "xlsx" | "pdf";

const preferredCompareModel = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const compareModels = Array.from(new Set([
  preferredCompareModel,
  "gemini-2.5-flash",
  "gemini-2.0-flash",
]));
const { callStructuredOutput: callGeminiForStructuredOutput } = createStructuredAiClient({ models: compareModels });
const OCR_EXTRACTION_VERSION = "ocr-v9-configured-engine";

function readBoundedIntegerEnv(name: string, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

const intakeExtractionCache = new Map<string, IntakeRecord>();
const projectRoot = fs.existsSync(path.join(process.cwd(), "server.ts"))
  ? process.cwd()
  : fs.existsSync(path.join(process.cwd(), "..", "server.ts"))
    ? path.resolve(process.cwd(), "..")
    : process.cwd();
const logsDirectory = path.join(projectRoot, "logs");

function appendRotatingLog(fileName: string, message: string, maxBytes = 5 * 1024 * 1024, retain = 5) {
  try {
    fs.mkdirSync(logsDirectory, { recursive: true });
    const logPath = path.join(logsDirectory, fileName);
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > maxBytes) {
      for (let index = retain - 1; index >= 1; index -= 1) {
        const source = `${logPath}.${index}`;
        const target = `${logPath}.${index + 1}`;
        if (fs.existsSync(source)) {
          fs.renameSync(source, target);
        }
      }
      fs.renameSync(logPath, `${logPath}.1`);
    }
    fs.appendFileSync(logPath, message, "utf8");
  } catch {
    // Logging must never break request handling or OCR recovery.
  }
}

const paddleOcrWorkerScriptPath = path.join(projectRoot, "tools", "paddle_ocr_worker.py");
const barcodeScanWorkerScriptPath = path.join(projectRoot, "tools", "barcode_scan_worker.py");
const paddleOcrStartupTimeoutMs = readBoundedIntegerEnv("PADDLE_OCR_STARTUP_TIMEOUT_MS", 300 * 1000, 30 * 1000);
const paddleOcrRequestTimeoutMs = readBoundedIntegerEnv("PADDLE_OCR_REQUEST_TIMEOUT_MS", 180 * 1000, 30 * 1000);
const paddleOcrProbeRequestTimeoutMs = readBoundedIntegerEnv("PADDLE_OCR_PROBE_TIMEOUT_MS", 60 * 1000, 15 * 1000);
const paddleOcrRetryCount = readBoundedIntegerEnv("PADDLE_OCR_RETRY_COUNT", 1, 0, 3);
const paddleOcrProbeEnabled = /^(1|true|yes)$/i.test(process.env.PADDLE_OCR_ENABLE_PROBES || "true"); // Enabled by default
const ocrEngine = (process.env.OCR_ENGINE || "easyocr").trim().toLowerCase();
const ocrServiceUrl = (process.env.OCR_SERVICE_URL || "http://127.0.0.1:8001").trim().replace(/\/+$/, "");
const ocrServiceTimeoutMs = readBoundedIntegerEnv("OCR_SERVICE_TIMEOUT_MS", 180 * 1000, 5 * 1000);
const ocrServiceStartupProbeTimeoutMs = readBoundedIntegerEnv(
  "OCR_SERVICE_STARTUP_PROBE_TIMEOUT_MS",
  120 * 1000,
  5 * 1000
);
const ocrServiceProbeTimeoutMs = readBoundedIntegerEnv("OCR_SERVICE_PROBE_TIMEOUT_MS", 5 * 1000, 500, 30 * 1000);
const ocrServiceAutoStart = /^(1|true|yes)$/i.test(process.env.OCR_SERVICE_AUTO_START || "true");
const ocrServiceDirectory = path.join(projectRoot, "ocr-service");
const defaultPaddleOcrWorkerPoolSize = Math.min(
  2,
  Math.max(1, typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length || 1)
);
const paddleOcrWorkerPoolSize = Math.max(
  1,
  readBoundedIntegerEnv("PADDLE_OCR_WORKER_POOL_SIZE", defaultPaddleOcrWorkerPoolSize, 1)
);
const localOcrParallelism = readBoundedIntegerEnv(
  "INTAKE_OCR_PARALLELISM",
  paddleOcrWorkerPoolSize,
  1,
  paddleOcrWorkerPoolSize
);
const intakeAiFallbackEnabled = /^(1|true|yes)$/i.test(process.env.INTAKE_AI_FALLBACK_ENABLED || "true"); // Enabled by default

function resolveRuntimeMode() {
  const lifecycleEvent = (process.env.npm_lifecycle_event || "").toLowerCase();
  const explicitMode = (process.env.APP_RUNTIME_MODE || process.env.NODE_ENV || "").toLowerCase();

  if (lifecycleEvent === "dev") {
    return "development";
  }

  if (explicitMode === "production") {
    return "production";
  }

  return "development";
}

const runtimeMode = resolveRuntimeMode();
const isProductionMode = runtimeMode === "production";

function normalizeRecord(record: Partial<CompareRecord> | undefined): CompareRecord {
  return {
    sn: record?.sn || "",
    district: record?.district || "",
    branch: record?.branch || "",
    components: record?.components || "",
    description: record?.description || "",
    hardwareId: record?.hardwareId || "",
    serial: record?.serial || "",
    remarks: record?.remarks || "",
  };
}

function normalizeExtractedRecord(record: Partial<ExtractedCompareRecord> | undefined): ExtractedCompareRecord {
  return {
    ...normalizeRecord(record),
    notes: typeof record?.notes === "string" ? record.notes : "",
  };
}

const PLACEHOLDER_INTAKE_VALUE_PATTERN = /^(?:BLANK(?:\s+\d+)?|DUPLICATE|DUPLICATED?|COPY|SAME|N\/A|NA|NONE|NULL|UNDEFINED)$/i;

function sanitizeIntakeTextValue(value: string): string {
  const trimmed = sanitizeOcrValue(value || "");
  if (!trimmed || PLACEHOLDER_INTAKE_VALUE_PATTERN.test(trimmed)) {
    return "";
  }

  return trimmed;
}

function sanitizeIntakeIdentifierValue(value: string, field: "hardwareId" | "serial", hardwareId = ""): string {
  const trimmed = sanitizeIntakeTextValue(value);
  if (!trimmed) {
    return "";
  }

  if (field === "hardwareId") {
    const normalizedAssetTag = normalizeAssetTagCandidate(trimmed);
    if (normalizedAssetTag) {
      return normalizedAssetTag;
    }

    if (!/\d{4}/.test(trimmed) || /^[A-Z ]+$/i.test(trimmed)) {
      return "";
    }

    return trimmed.toUpperCase();
  }

  if (!isLikelySerialCandidate(trimmed, hardwareId)) {
    return looksLikeQrOrBarcodeValue(trimmed, hardwareId) ? normalizeAlphaNumericCandidate(trimmed) : "";
  }

  return normalizeAlphaNumericCandidate(trimmed);
}

function normalizeIntakeRecord(record: Partial<IntakeRecord> | undefined): IntakeRecord {
  const hardwareId = sanitizeIntakeIdentifierValue(typeof record?.hardwareId === "string" ? record.hardwareId : "", "hardwareId");
  const serialSource = record as (Partial<IntakeRecord> & {
    serialNumber?: unknown;
    Serial?: unknown;
    "Serial Number"?: unknown;
  }) | undefined;
  const serialValue =
    typeof serialSource?.serial === "string" ? serialSource.serial :
    typeof serialSource?.serialNumber === "string" ? serialSource.serialNumber :
    typeof serialSource?.Serial === "string" ? serialSource.Serial :
    typeof serialSource?.["Serial Number"] === "string" ? serialSource["Serial Number"] :
    "";
  return {
    sourceName: typeof record?.sourceName === "string" ? record.sourceName : "",
    components: sanitizeIntakeTextValue(typeof record?.components === "string" ? record.components : ""),
    description: sanitizeIntakeTextValue(typeof record?.description === "string" ? record.description : ""),
    hardwareId,
    serial: sanitizeIntakeIdentifierValue(serialValue, "serial", hardwareId),
    remarks: sanitizeIntakeTextValue(typeof record?.remarks === "string" ? record.remarks : "") || "New Accountability",
    notes: typeof record?.notes === "string" ? sanitizeOcrValue(record.notes) : "",
  };
}

function normalizeBarcodeLookupValue(value: string | null | undefined): string {
  return normalizeAlphaNumericCandidate(String(value || ""))
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function barcodeLookupCandidates(record: Partial<IntakeRecord>): string[] {
  return dedupePreserveOrder([
    normalizeBarcodeLookupValue(record.hardwareId),
    normalizeBarcodeLookupValue(record.serial),
    normalizeBarcodeLookupValue(record.sourceName),
    normalizeBarcodeLookupValue(record.remarks),
  ]).filter(Boolean);
}

function findRecordByBarcode(barcode: string | null | undefined, referenceRecords: ReferenceRecord[] = []): IntakeRecord | null {
  const normalizedBarcode = normalizeBarcodeLookupValue(barcode);
  if (!normalizedBarcode) {
    return null;
  }

  const candidates: IntakeRecord[] = [
    ...referenceRecords.map((record) => normalizeIntakeRecord(record)),
    ...Array.from(intakeExtractionCache.values()).map((record) => normalizeIntakeRecord(record)),
  ];

  const match = candidates.find((record) => barcodeLookupCandidates(record).includes(normalizedBarcode));
  return match
    ? {
        ...match,
        notes: combineExtractionNotes(match.notes, `Record found by barcode lookup: ${barcode}.`),
      }
    : null;
}

function buildBarcodeLookupRecord(fileName: string, barcode: string, matchedRecord: IntakeRecord | null): IntakeRecord {
  if (matchedRecord) {
    return {
      ...matchedRecord,
      sourceName: matchedRecord.sourceName || fileName,
      remarks: matchedRecord.remarks || "Existing Accountability",
      notes: combineExtractionNotes(matchedRecord.notes, "Barcode detected. Existing details were loaded without creating a duplicate record."),
    };
  }

  return {
    sourceName: fileName,
    components: "",
    description: "",
    hardwareId: "",
    serial: "",
    remarks: "Barcode Lookup",
    notes: `Barcode detected: ${barcode}. No record found for this barcode.`,
  };
}

function buildManualIntakeFallback(sourceName: string, note: string): IntakeRecord {
  return {
    sourceName,
    components: "",
    description: "",
    hardwareId: "",
    serial: "",
    remarks: "New Accountability",
    notes: note,
  };
}

function getIntakeCacheKey(file: CompareSourceFile): string {
  return crypto
    .createHash("sha256")
    .update(OCR_EXTRACTION_VERSION)
    .update("\n")
    .update(file.kind)
    .update("\n")
    .update(file.mimeType)
    .update("\n")
    .update(file.contentType)
    .update("\n")
    .update(file.content)
    .digest("hex");
}

const KNOWN_BRANDS = [
  "ACER",
  "ASUS",
  "DELL",
  "HP",
  "LENOVO",
  "RAPOO",
  "LOGITECH",
  "A4TECH",
  "VIEWSONIC",
  "BENQ",
  "PHILIPS",
  "LG",
  "SAMSUNG",
  "APC",
  "EPSON",
  "CANON",
  "BROTHER",
  "WD",
  "INTEL",
  "AMD",
  "MSI",
  "HIKVISION",
  "TOSHIBA",
  "DYNABOOK",
  "SEAGATE",
  "TP-LINK",
  "TPLINK",
  "CISCO",
  "ZEBRA",
  "PANTUM",
  "FUJITSU",
  "KYOCERA",
  "XEROX",
  "KINGSTON",
  "SANDISK",
  "RICOH",
  "SHARP",
  "BELKIN",
  "ANKER",
  "DAHUA",
  "REALTEK",
  "GIGABYTE",
  "COOLER MASTER",
  "CORSAIR",
  "CRUCIAL",
];

const KNOWN_COMPONENT_LABELS = [
  "SYSTEM UNIT",
  "MONITOR",
  "PRINTER",
  "UPS",
  "KEYBOARD",
  "MOUSE",
  "WEBCAM",
  "CPU ADAPTER",
  "LAPTOP",
  "ROUTER",
  "SWITCH",
  "SCANNER",
];

const KNOWN_ASSET_PREFIXES = new Set([
  "A",
  "C",
  "KBD",
  "K",
  "L",
  "M",
  "P",
  "U",
  "UPS",
  "MON",
  "MTR",
  "MSE",
  "PRN",
  "PRT",
  "PTR",
  "CPU",
  "SYS",
  "CAM",
  "LAP",
  "LTP",
  "ADP",
  "CAD",
  "LAD",
  "W",
  "SCN",
  "SWT",
  "RTR",
  "SW",
  "TEL",
  "TAB",
  "HDD",
  "SSD",
  "NIC",
]);

const ASSET_TAG_PATTERN = /\b([A-Z]{1,8})[\s/-]*((?:19|20)\d{2})[\s/-]*([A-Z0-9]{2,8})\b/i;
const ASSET_TAG_PATTERN_GLOBAL = /\b[A-Z]{1,8}[\s/-]*(?:19|20)\d{2}[\s/-]*[A-Z0-9]{2,8}\b/g;
const PROPERTY_STICKER_PATTERN = /\bPROPERTY\s+OF\s+LIFEBANK\s+FOUNDATION(?:,?\s*INC\.?)?\b/i;
const SERIAL_LABEL_PATTERN = /\b(?:SERIAL(?:\s*NO\.?|\s*NUMBER)?|S\/N|SN|SNID)\b/i;
const BARCODE_LABEL_PATTERN = /\b(?:QR(?:\s*CODE)?|BARCODE)\b/i;

const {
  submit: submitPaddleOcrRequest,
  prewarm: prewarmPaddleOcrWorker,
} = createOcrWorkerPool({
  projectRoot,
  workerScriptPath: paddleOcrWorkerScriptPath,
  serviceDirectory: ocrServiceDirectory,
  poolSize: paddleOcrWorkerPoolSize,
  startupTimeoutMs: paddleOcrStartupTimeoutMs,
  requestTimeoutMs: paddleOcrRequestTimeoutMs,
  retryCount: paddleOcrRetryCount,
  describeError: extractUpstreamErrorMessage,
});

function shouldUsePaddleOcrService() {
  // Both engines are served by the Python HTTP OCR service (ocr_api:app).
  // "easyocr" is the current engine; "paddle" is kept for backward compatibility.
  return shouldUseOcrService(ocrEngine);
}

const {
  isHealthy: isPaddleOcrServiceHealthy,
  ensureReady: ensurePaddleOcrServiceReady,
} = createOcrServiceLifecycle({
  serviceUrl: ocrServiceUrl,
  serviceDirectory: ocrServiceDirectory,
  autoStart: ocrServiceAutoStart,
  probeTimeoutMs: ocrServiceProbeTimeoutMs,
  startupProbeTimeoutMs: ocrServiceStartupProbeTimeoutMs,
  shouldUseService: shouldUsePaddleOcrService,
  appendRotatingLog,
  describeError: extractUpstreamErrorMessage,
});

const { scan: scanBarcodeWithLocalWorker } = createBarcodeWorker<IntakeRecord>({
  workerScriptPath: barcodeScanWorkerScriptPath,
  serviceDirectory: ocrServiceDirectory,
  timeoutMs: ocrServiceTimeoutMs,
  describeError: extractUpstreamErrorMessage,
});

const {
  requestOcr: postToPaddleOcrService,
  requestBarcode: postToPaddleBarcodeService,
} = createOcrHttpClient<IntakeRecord>({
  serviceUrl: ocrServiceUrl,
  timeoutMs: ocrServiceTimeoutMs,
  ensureReady: ensurePaddleOcrServiceReady,
  scanBarcodeLocally: scanBarcodeWithLocalWorker,
});

const {
  recognizeOcrSnapshot,
  recognizeOcrSnapshotBatch,
  recognizeOcrDetailed,
} = createOcrRecognizer({
  engine: ocrEngine,
  requestService: postToPaddleOcrService,
  requestWorker: submitPaddleOcrRequest,
  probeTimeoutMs: paddleOcrProbeRequestTimeoutMs,
});

function getMeaningfulOcrLines(text: string): string[] {
  return sanitizeOcrValue(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 1);
}

function dedupePreserveOrder(values: string[]): string[] {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function sanitizeDescriptionFragment(value: string): string {
  return sanitizeOcrValue(value)
    .toUpperCase()
    .replace(/\b(?:SERIAL(?:\s*NO\.?|\s*NUMBER)?|S\.?\/?\s*N\.?|SN|SNID|PROPERTY|LIFEBANK|FOUNDATION|INC|BARCODE|QR(?:\s*CODE)?|RATING|INPUT|OUTPUT|MADE IN|FCC|IC|CMIIT ID|UL|CE|ROHS|CLASS)\b/g, " ")
    .replace(/[^A-Z0-9./()\- ]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeModelCandidate(value: string): string {
  const cleaned = sanitizeDescriptionFragment(value)
    .replace(/^[#:/ -]+/, "")
    .replace(/[#:;.,]+$/g, "")
    .trim();

  if (!cleaned || cleaned.length < 2 || cleaned.length > 40) {
    return "";
  }

  if (/^(?:LIFEBANK|FOUNDATION|PROPERTY|SERIAL|SN|SNID|MODEL|BARCODE|QRCODE)$/i.test(cleaned)) {
    return "";
  }

  return cleaned;
}

function extractBrandAndModelCandidates(lines: string[]): string[] {
  const candidates: string[] = [];
  const normalizedLines = lines
    .map((line) => sanitizeDescriptionFragment(line))
    .filter(Boolean);

  for (let index = 0; index < normalizedLines.length; index += 1) {
    const line = normalizedLines[index];
    const nextLine = normalizedLines[index + 1] || "";
    const previousLine = normalizedLines[index - 1] || "";
    const neighborText = [previousLine, line, nextLine].filter(Boolean).join(" ");
    const brand = KNOWN_BRANDS.find((candidate) => neighborText.includes(candidate)) || "";

    const explicitModelMatch = line.match(/\b(?:MODEL(?:\s*NO\.?|\s*NUMBER)?|M\/N|P\/N|TYPE)[:#\s-]*([A-Z0-9][A-Z0-9./()-]{1,})\b/i);
    const modelFromLabel = normalizeModelCandidate(explicitModelMatch?.[1] || "");
    if (brand && modelFromLabel) {
      candidates.push(`${brand} ${modelFromLabel}`.trim());
    } else if (brand && line.includes(brand)) {
      const tokens = line.match(/\b[A-Z0-9][A-Z0-9./()-]{2,}\b/g) || [];
      const modelToken = tokens.find((token) => token !== brand && token.length >= 4 && /\d/.test(token));
      if (modelToken) {
        candidates.push(`${brand} ${normalizeModelCandidate(modelToken)}`.trim());
      } else {
        candidates.push(brand);
      }
    } else if (modelFromLabel) {
      candidates.push(modelFromLabel);
    }

    const standaloneTokens = line.match(/\b[A-Z0-9][A-Z0-9./()-]{3,}\b/g) || [];
    const modelLikeToken = standaloneTokens.find((token) => /\d/.test(token) && !normalizeAssetTagCandidate(token));
    if (brand && modelLikeToken) {
      candidates.push(`${brand} ${normalizeModelCandidate(modelLikeToken)}`.trim());
    }
  }

  return dedupePreserveOrder(
    candidates
      .map((candidate) => candidate.trim())
      .filter((candidate) => candidate.length >= 2)
  );
}

function hasPropertyStickerContext(value: string): boolean {
  const normalized = sanitizeOcrValue(value).toUpperCase();
  return Boolean(
    PROPERTY_STICKER_PATTERN.test(normalized) ||
    (normalized.includes("LIFEBANK") && normalized.includes("FOUNDATION")) ||
    (normalized.includes("PROPERTY") && normalized.includes("LIFEBANK"))
  );
}

function looksLikeQrOrBarcodeValue(value: string, hardwareId: string): boolean {
  const normalized = normalizeAlphaNumericCandidate(value);
  if (!normalized || normalized === hardwareId) {
    return false;
  }

  if (normalizeAssetTagCandidate(normalized)) {
    return false;
  }

  if (normalized.length < 8 || normalized.length > 32) {
    return false;
  }

  if (/^(?:PROPERTY|LIFEBANK|FOUNDATION|SERIAL|MODEL|QRCODE|BARCODE|SNID)$/i.test(normalized)) {
    return false;
  }

  return Boolean(
    (/^\d{8,}$/.test(normalized)) ||
    ((/[A-Z]/.test(normalized) && /\d/.test(normalized)) && /[-/]/.test(normalized)) ||
    ((/[A-Z]/.test(normalized) && /\d/.test(normalized)) && normalized.length >= 10)
  );
}

const {
  normalizeLiquidationAmount,
  extractBestLiquidationAmount,
  inferLiquidationRouteFromText,
  inferLiquidationRemarksFromText,
  inferLiquidationTransportMode,
} = createLiquidationTextParser({ getMeaningfulOcrLines });

function lineMatchesAny(line: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(line));
}

function findAnchorLines(lines: OcrLineEntry[], patterns: RegExp[]): OcrLineEntry[] {
  return lines.filter((line) => lineMatchesAny(line.text.toUpperCase(), patterns));
}

function unionBboxes(boxes: OcrBBox[]): OcrBBox | null {
  if (boxes.length === 0) {
    return null;
  }

  return boxes.reduce((acc, box) => ({
    x0: Math.min(acc.x0, box.x0),
    y0: Math.min(acc.y0, box.y0),
    x1: Math.max(acc.x1, box.x1),
    y1: Math.max(acc.y1, box.y1),
  }));
}

function expandRectangle(box: OcrBBox, paddingX: number, paddingYTop: number, paddingYBottom: number) {
  return {
    left: Math.max(0, Math.floor(box.x0 - paddingX)),
    top: Math.max(0, Math.floor(box.y0 - paddingYTop)),
    width: Math.max(1, Math.ceil((box.x1 - box.x0) + (paddingX * 2))),
    height: Math.max(1, Math.ceil((box.y1 - box.y0) + paddingYTop + paddingYBottom)),
  };
}

function clampRectangleToImage(rectangle: OcrRecognizeOptions["rectangle"], width: number, height: number): OcrRecognizeOptions["rectangle"] {
  if (width <= 0 || height <= 0) {
    return rectangle;
  }

  const left = Math.max(0, Math.min(width - 1, Math.floor(rectangle.left)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(rectangle.top)));
  const right = Math.max(left + 1, Math.min(width, Math.ceil(rectangle.left + rectangle.width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil(rectangle.top + rectangle.height)));

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function buildImageProbeRectangle(
  width: number,
  height: number,
  leftRatio: number,
  topRatio: number,
  widthRatio: number,
  heightRatio: number
): OcrRecognizeOptions["rectangle"] {
  return clampRectangleToImage({
    left: Math.round(width * leftRatio),
    top: Math.round(height * topRatio),
    width: Math.round(width * widthRatio),
    height: Math.round(height * heightRatio),
  }, width, height);
}

type IntakeProbeDefinition = {
  key: string;
  purpose: "property" | "label" | "serial";
  weight: number;
  rectangle: OcrRecognizeOptions["rectangle"];
};

type IntakeProbeSnapshot = IntakeProbeDefinition & {
  snapshot: OcrSnapshot;
};

function findNearbyLines(lines: OcrLineEntry[], anchor: OcrBBox, extraBelow: number, extraAbove = 10): OcrLineEntry[] {
  return lines.filter((line) =>
    line.bbox.y0 >= (anchor.y0 - extraAbove) &&
    line.bbox.y1 <= (anchor.y1 + extraBelow)
  );
}

function normalizeAlphaNumericCandidate(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9/-]/g, "")
    .replace(/\/+/g, "/")
    .trim();
}

async function extractRegionalOcrSnapshots(file: CompareSourceFile) {
  const full = await recognizeOcrSnapshot(file);
  const fullOnlyRecord = buildIntakeRecordFromOcr(file.name, { full, probes: [] });
  const fullTextLength = full.text.trim().length;

  if (
    hasStrongIntakeExtraction(fullOnlyRecord) ||
    (hasUsableIntakeExtraction(fullOnlyRecord) && (full.confidence >= 0.72 || full.lines.length >= 4 || fullTextLength >= 90)) ||
    fullTextLength > 200
  ) {
    return { full, probes: [] };
  }

  const propertyAnchor = unionBboxes(
    findAnchorLines(full.lines, [PROPERTY_STICKER_PATTERN, /\bPROPERTY\b/i, /\bLIFEBANK\b/i, /\bFOUNDATION\b/i]).map((line) => line.bbox)
  );
  const propertyRegion = propertyAnchor
    ? unionBboxes(findNearbyLines(full.lines, propertyAnchor, 160, 20).map((line) => line.bbox))
    : null;

  const labelAnchor = unionBboxes(
    findAnchorLines(full.lines, [
      /\bMODEL\b/i,
      /\bSERIAL\b/i,
      /\bS\/N\b/i,
      /\bSN\b/i,
      /\bSNID\b/i,
      /\bBARCODE\b/i,
      /\bQR(?:\s*CODE)?\b/i,
      /\bTYPE\b/i,
      ...KNOWN_BRANDS.map((brand) => new RegExp(`\\b${brand}\\b`, "i")),
    ]).map((line) => line.bbox)
  );
  const labelRegion = labelAnchor
    ? unionBboxes(findNearbyLines(full.lines, labelAnchor, 140, 30).map((line) => line.bbox))
    : null;

  const serialAnchor = unionBboxes(
    findAnchorLines(full.lines, [/\bSERIAL\b/i, /\bS\/N\b/i, /\bSN\b/i, /\bSNID\b/i, /\bBARCODE\b/i, /\bQR(?:\s*CODE)?\b/i]).map((line) => line.bbox)
  );
  const serialRegion = serialAnchor
    ? unionBboxes(findNearbyLines(full.lines, serialAnchor, 90, 20).map((line) => line.bbox))
    : null;

  const probeDefinitions: IntakeProbeDefinition[] = [];

  if (propertyRegion) {
    probeDefinitions.push({
      key: "property-anchor",
      purpose: "property",
      weight: 60,
      rectangle: clampRectangleToImage(expandRectangle(propertyRegion, 40, 20, 80), full.width, full.height),
    });
  }
  if (labelRegion) {
    probeDefinitions.push({
      key: "label-anchor",
      purpose: "label",
      weight: 40,
      rectangle: clampRectangleToImage(expandRectangle(labelRegion, 45, 25, 80), full.width, full.height),
    });
  }

  if (serialRegion) {
    probeDefinitions.push({
      key: "serial-anchor",
      purpose: "serial",
      weight: 44,
      rectangle: clampRectangleToImage(expandRectangle(serialRegion, 35, 20, 70), full.width, full.height),
    });
  }

  if (full.width > 0 && full.height > 0) {
    if (!propertyRegion) {
      probeDefinitions.push(
        {
          key: "property-top-right",
          purpose: "property",
          weight: 52,
          rectangle: buildImageProbeRectangle(full.width, full.height, 0.44, 0.02, 0.54, 0.34),
        },
        {
          key: "property-bottom-right",
          purpose: "property",
          weight: 50,
          rectangle: buildImageProbeRectangle(full.width, full.height, 0.44, 0.56, 0.54, 0.34),
        }
      );
    }

    if (!labelRegion) {
      probeDefinitions.push({
        key: "label-center",
        purpose: "label",
        weight: 34,
        rectangle: buildImageProbeRectangle(full.width, full.height, 0.12, 0.18, 0.76, 0.58),
      });
    }

    if (!serialRegion) {
      probeDefinitions.push(
        {
          key: "serial-bottom-band",
          purpose: "serial",
          weight: 36,
          rectangle: buildImageProbeRectangle(full.width, full.height, 0.0, 0.44, 1.0, 0.5),
        },
        {
          key: "serial-bottom-right",
          purpose: "serial",
          weight: 40,
          rectangle: buildImageProbeRectangle(full.width, full.height, 0.48, 0.38, 0.50, 0.52),
        },
        {
          key: "serial-bottom-left",
          purpose: "serial",
          weight: 32,
          rectangle: buildImageProbeRectangle(full.width, full.height, 0.02, 0.38, 0.46, 0.52),
        }
      );
    }
  }

  if (!paddleOcrProbeEnabled || probeDefinitions.length === 0) {
    return { full, probes: [] };
  }

  let batchSnapshots: Record<string, OcrSnapshot> = {};
  try {
    batchSnapshots = await recognizeOcrSnapshotBatch(
      file,
      probeDefinitions.map((probe) => ({ key: probe.key, rectangle: probe.rectangle }))
    );
  } catch (error) {
    console.warn(`PaddleOCR probe batch failed for ${file.name}. Falling back to full-image OCR only.`, error);
  }

  const probes = probeDefinitions
    .map((probe) => ({
      ...probe,
      snapshot: batchSnapshots[probe.key],
    }))
    .filter((probe) => probe.snapshot && probe.snapshot.text.trim().length > 0) as IntakeProbeSnapshot[];

  return { full, probes };
}

function inferComponentFromHardwareId(hardwareId: string): string {
  const prefix = hardwareId.split("-")[0]?.toUpperCase() || "";
  const prefixMap: Record<string, string> = {
    A: "CPU ADAPTER",
    C: "SYSTEM UNIT",
    K: "KEYBOARD",
    KBD: "KEYBOARD",
    L: "LAPTOP",
    LTP: "LAPTOP",
    LAP: "LAPTOP",
    M: "MONITOR",
    MTR: "MONITOR",
    MON: "MONITOR",
    P: "PRINTER",
    PRN: "PRINTER",
    PRT: "PRINTER",
    PTR: "PRINTER",
    U: "UPS",
    UPS: "UPS",
    MSE: "MOUSE",
    CPU: "SYSTEM UNIT",
    SYS: "SYSTEM UNIT",
    CAM: "WEBCAM",
    W: "WEBCAM",
    ADP: "CPU ADAPTER",
    CAD: "CPU ADAPTER",
    LAD: "LAPTOP ADAPTER",
    SCN: "SCANSNAP",
    SWT: "SWITCH",
    SW: "SWITCH",
    RTR: "ROUTER",
    TEL: "TELEPHONE",
    TAB: "TABLET",
    HDD: "STORAGE DRIVE",
    SSD: "STORAGE DRIVE",
    NIC: "NETWORK CARD",
  };

  return prefixMap[prefix] || "";
}

function inferComponentFromText(text: string, hardwareId: string): string {
  const normalized = text.toUpperCase();
  const componentMatchers: Array<{ label: string; patterns: RegExp[] }> = [
    { label: "KEYBOARD", patterns: [/\bKEYBOARD\b/i] },
    { label: "MOUSE", patterns: [/\bMOUSE\b/i] },
    { label: "UPS", patterns: [/\bUPS\b/i, /\bUNINTERRUPTIBLE POWER/i] },
    { label: "MONITOR", patterns: [/\bMONITOR\b/i, /\bDISPLAY\b/i, /\bLCD\b/i, /\bLED MONITOR\b/i] },
    { label: "PRINTER", patterns: [/\bPRINTER\b/i, /\bLASERJET\b/i, /\bINKJET\b/i, /\bMULTIFUNCTION\b/i] },
    { label: "WEBCAM", patterns: [/\bWEBCAM\b/i, /\bCAMERA\b/i] },
    { label: "SYSTEM UNIT", patterns: [/\bSYSTEM UNIT\b/i, /\bDESKTOP\b/i, /\bTHIN CLIENT\b/i, /\bMINI PC\b/i, /\bOPTIPLEX\b/i, /\bELITEDESK\b/i] },
    { label: "LAPTOP", patterns: [/\bLAPTOP\b/i, /\bNOTEBOOK\b/i, /\bTHINKPAD\b/i, /\bELITEBOOK\b/i, /\bPAVILION\b/i, /\bINSPIRON\b/i] },
    { label: "SCANSNAP", patterns: [/\bSCANSNAP\b/i] },
    { label: "SCANNER", patterns: [/\bSCANNER\b/i, /\bDOCUMENT SCANNER\b/i] },
    { label: "ROUTER", patterns: [/\bROUTER\b/i, /\bWIRELESS ACCESS POINT\b/i] },
    { label: "SWITCH", patterns: [/\bSWITCH\b/i, /\bNETWORK SWITCH\b/i] },
    // Match both spellings: ADAPTER and ADAPTOR
    { label: "LAPTOP ADAPTER", patterns: [/\bLAPTOP\s+ADAPT(?:ER|OR)\b/i, /\bNOTEBOOK\s+ADAPT(?:ER|OR)\b/i] },
    { label: "CPU ADAPTER", patterns: [/\bCPU\s+ADAPT(?:ER|OR)\b/i, /\bPOWER\s+ADAPT(?:ER|OR)\b/i, /\b(?<!LAPTOP\s)(?<!NOTEBOOK\s)ADAPT(?:ER|OR)\b/i] },
  ];

  for (const matcher of componentMatchers) {
    if (matcher.patterns.some((pattern) => pattern.test(normalized))) {
      return matcher.label;
    }
  }

  return inferComponentFromHardwareId(hardwareId);
}

function normalizeAssetTagCandidate(value: string): string {
  const match = value.toUpperCase().match(ASSET_TAG_PATTERN);
  if (!match) {
    return "";
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

function findAssetTagCandidates(value: string): string[] {
  return (value.toUpperCase().match(ASSET_TAG_PATTERN_GLOBAL) || [])
    .map((match) => normalizeAssetTagCandidate(match))
    .filter(Boolean);
}

type WeightedOcrText = {
  text: string;
  weight: number;
};

function pickBestAssetTag(sources: WeightedOcrText[]): string {
  const candidates = new Map<string, number>();

  for (const source of sources) {
    const sourceHasPropertySticker = hasPropertyStickerContext(source.text);
    const lines = sanitizeOcrValue(source.text)
      .split("\n")
      .map((line) => line.toUpperCase().trim())
      .filter(Boolean);

    for (const line of lines) {
      for (const normalized of findAssetTagCandidates(line)) {
        const prefix = normalized.split("-")[0];
        let score = source.weight + normalized.length;

        if (KNOWN_ASSET_PREFIXES.has(prefix)) {
          score += 12;
        }

        if (sourceHasPropertySticker) {
          score += 28;
        }

        if (hasPropertyStickerContext(line)) {
          score += 24;
        }

        if (/\b(ASSET|TAG|STICKER)\b/.test(line)) {
          score += 10;
        }

        if (/^[A-Z]{1,8}-\d{4}-[A-Z0-9]{2,8}$/.test(normalized)) {
          score += 8;
        }

        candidates.set(normalized, Math.max(candidates.get(normalized) || 0, score));
      }
    }
  }

  return [...candidates.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([value]) => value)[0] || "";
}

function isLikelySerialCandidate(value: string, hardwareId: string): boolean {
  const normalized = normalizeAlphaNumericCandidate(value);
  if (!normalized || normalized === hardwareId) {
    return false;
  }

  // Minimum length: 5 allows Dell 7-char service tags and similar short IDs
  if (normalized.length < 5) {
    return false;
  }

  if (normalizeAssetTagCandidate(normalized)) {
    return false;
  }

  if (/^(PROPERTY|LIFEBANK|FOUNDATION|MODEL|SERIAL|SYSTEM|ADMINISTRATOR|KEYBOARD|MONITOR|PRINTER|LAPTOP|SCANNER)$/i.test(normalized)) {
    return false;
  }

  // Reject pure-label words with no digits (e.g., "NO", "CODE", "LABEL")
  if (/^(?:[A-Z]{1,8}|NO|NUMBER|CODE|LABEL)-?\d{0,4}$/i.test(normalized)) {
    return false;
  }

  // Reject standalone 4-digit years
  if (/^\d{4}$/.test(normalized) || /^20\d{2}$/.test(normalized)) {
    return false;
  }

  // Must contain both alpha and digit, OR be a long pure-digit string (barcode)
  return (
    (/[A-Z]/.test(normalized) && /\d/.test(normalized)) ||
    /^\d{7,}$/.test(normalized)
  );
}

function pickBestSerial(sources: WeightedOcrText[], hardwareId: string): string {
  const candidates = new Map<string, number>();
  const labeledPatterns = [
    { pattern: /\bSERIAL(?:\s*NO\.?|\s*NUMBER?\.?)?[:#\s-]*([A-Z0-9/-]{5,})\b/i, bonus: 42 },
    { pattern: /\bSER\.?\s*NO\.?[:#\s-]*([A-Z0-9/-]{5,})\b/i, bonus: 40 },
    { pattern: /\bS\.?\s*\/?\s*N\.?[:#\s-]*([A-Z0-9/-]{5,})\b/i, bonus: 40 },
    { pattern: /\bSN[:#\s-]+([A-Z0-9/-]{5,})\b/i, bonus: 36 },
    // SNID: lower priority than explicit SN but valid fallback
    { pattern: /\bSNID[:#\s-]*([A-Z0-9/-]{5,})\b/i, bonus: 28 },
  ];

  for (const source of sources) {
    const lines = sanitizeOcrValue(source.text)
      .split("\n")
      .map((line) => line.toUpperCase().trim())
      .filter(Boolean);

    for (const line of lines) {
      const propertyStickerContext = hasPropertyStickerContext(line);
      const hasSerialLabel = SERIAL_LABEL_PATTERN.test(line);
      const hasBarcodeLabel = BARCODE_LABEL_PATTERN.test(line);
      const hasModelLabel = /\b(?:MODEL|MODEL NO\.?|MODEL NUMBER|M\/N|P\/N|TYPE)\b/i.test(line);

      for (const { pattern, bonus } of labeledPatterns) {
        const match = line.match(pattern);
        const candidate = normalizeAlphaNumericCandidate(match?.[1] || "");
        if (isLikelySerialCandidate(candidate, hardwareId)) {
          let score = source.weight + bonus;
          if (propertyStickerContext && !/\bSNID\b/i.test(line)) {
            score -= 10;
          }
          candidates.set(candidate, Math.max(candidates.get(candidate) || 0, score));
        }
      }

      const matches = line.match(/\b[A-Z0-9-]{6,24}\b/g) || [];
      for (const match of matches) {
        const candidate = normalizeAlphaNumericCandidate(match);
        if (!isLikelySerialCandidate(candidate, hardwareId)) {
          continue;
        }

        if (propertyStickerContext && !hasSerialLabel) {
          continue;
        }

        let score = source.weight + candidate.length;
        if (hasSerialLabel) {
          score += /\bSNID\b/i.test(line) ? 12 : 24;
        }
        if (hasBarcodeLabel && looksLikeQrOrBarcodeValue(candidate, hardwareId)) {
          score += 16;
        } else if (hasBarcodeLabel) {
          score -= 10;
        }
        if (hasModelLabel) {
          score -= 12;
        }
        if (propertyStickerContext) {
          score -= 18;
        }
        if (!hasSerialLabel && !hasBarcodeLabel && !looksLikeQrOrBarcodeValue(candidate, hardwareId)) {
          score -= 10;
        }
        candidates.set(candidate, Math.max(candidates.get(candidate) || 0, score));
      }
    }
  }

  return [...candidates.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([value]) => value)[0] || "";
}

function isUsefulDescriptionLine(line: string, component: string): boolean {
  const upper = line.toUpperCase();
  if (!upper || upper.length < 4 || upper.length > 42) {
    return false;
  }

  if (
    upper.includes("PROPERTY OF") ||
    upper.includes("LIFEBANK") ||
    upper.includes("FOUNDATION") ||
    upper.includes("SERIAL") ||
    upper.includes("S/N") ||
    upper.includes("SN ") ||
    upper.includes("FCC") ||
    upper.includes("CE") ||
    upper.includes("MADE IN") ||
    upper.includes("INPUT") ||
    upper.includes("OUTPUT") ||
    upper.includes("RATING")
  ) {
    return false;
  }

  if (/^[A-Z]{1,3}$/.test(upper)) {
    return false;
  }

  if (component && upper === component) {
    return false;
  }

  return true;
}

function pickBestDescription(lines: string[], component: string): string {
  const normalizedLines = lines
    .map((line) => sanitizeOcrValue(line).toUpperCase())
    .filter(Boolean);
  const brandAndModelCandidates = extractBrandAndModelCandidates(normalizedLines);
  const rankedBrandCandidates = brandAndModelCandidates
    .map((candidate) => {
      const normalizedCandidate = sanitizeDescriptionFragment(candidate);
      const includesBrand = KNOWN_BRANDS.some((brand) => normalizedCandidate.includes(brand));
      const includesModelDigits = /\d/.test(normalizedCandidate);
      return {
        value: normalizedCandidate,
        score: (includesBrand ? 30 : 0) + (includesModelDigits ? 18 : 0) + normalizedCandidate.length,
      };
    })
    .filter((candidate) => candidate.value && candidate.value !== component)
    .sort((left, right) => right.score - left.score);

  if (rankedBrandCandidates[0]?.value) {
    return rankedBrandCandidates[0].value;
  }

  const brandLine = normalizedLines.find((line) => KNOWN_BRANDS.some((brand) => line.includes(brand)));
  const modelLine = normalizedLines.find((line) => /\b(?:MODEL|MODEL NO\.?|MODEL NUMBER|M\/N|P\/N|TYPE)\b/i.test(line));

  if (brandLine && modelLine) {
    const modelMatch = modelLine.match(/\b(?:MODEL|MODEL NO\.?|MODEL NUMBER|M\/N|P\/N|TYPE)[:#\s-]*([A-Z0-9-]{3,})\b/i);
    const brand = KNOWN_BRANDS.find((candidate) => brandLine.includes(candidate)) || "";
    const model = normalizeAlphaNumericCandidate(modelMatch?.[1] || "");
    if (brand && model) {
      return `${brand} ${model}`.trim();
    }
  }

  for (const line of normalizedLines) {
    if (!isUsefulDescriptionLine(line, component)) {
      continue;
    }

    const brand = KNOWN_BRANDS.find((candidate) => line.includes(candidate)) || "";
    const modelMatch = line.match(/\b([A-Z]{1,6}[A-Z0-9-]{2,})\b/g) || [];

    if (brand && modelMatch.length > 0) {
      const modelCandidate = modelMatch.find((candidate) => candidate !== brand && candidate.length >= 4) || "";
      if (modelCandidate) {
        return `${brand} ${modelCandidate}`.trim();
      }
      return line;
    }
  }

  return rankedBrandCandidates.find((candidate) => candidate.value.length >= 3)?.value || "";
}

function scoreAssetProbeSnapshot(snapshot: OcrSnapshot): number {
  const text = sanitizeOcrValue(snapshot.text).toUpperCase();
  if (!text) {
    return 0;
  }

  return (
    (findAssetTagCandidates(text).length * 70) +
    ((text.match(/\b(PROPERTY|LIFEBANK|FOUNDATION|ASSET|TAG)\b/g) || []).length * 14) +
    (snapshot.confidence * 18) +
    text.length
  );
}

function scoreSerialProbeSnapshot(snapshot: OcrSnapshot): number {
  const text = sanitizeOcrValue(snapshot.text).toUpperCase();
  if (!text) {
    return 0;
  }

  const labeledSerial = pickBestSerial([{ text, weight: 24 }], "");
  const brandHits = KNOWN_BRANDS.filter((brand) => text.includes(brand)).length;
  const propertyStickerHits = hasPropertyStickerContext(text) ? 1 : 0;

  return (
    (labeledSerial ? 64 : 0) +
    ((text.match(/\b(SERIAL|S\/N|SN|SNID)\b/g) || []).length * 18) +
    ((text.match(/\b(BARCODE|QR(?:\s*CODE)?)\b/g) || []).length * 8) +
    (brandHits * 6) +
    (propertyStickerHits * -16) +
    (snapshot.confidence * 18) +
    text.length
  );
}

function scoreLabelProbeSnapshot(snapshot: OcrSnapshot): number {
  const lines = getMeaningfulOcrLines(snapshot.text);
  if (lines.length === 0) {
    return 0;
  }

  const joined = lines.join("\n").toUpperCase();
  const brandHits = KNOWN_BRANDS.filter((brand) => joined.includes(brand)).length;
  const modelHints = (joined.match(/\b(MODEL|MODEL NO|TYPE|P\/N|M\/N)\b/g) || []).length;

  return (
    (brandHits * 24) +
    (modelHints * 12) +
    (lines.length * 6) +
    (snapshot.confidence * 18)
  );
}

function pickBestPurposeProbe(
  probes: IntakeProbeSnapshot[],
  purpose: IntakeProbeSnapshot["purpose"],
  scoreSnapshot: (snapshot: OcrSnapshot) => number
): IntakeProbeSnapshot | null {
  const candidates = probes
    .filter((probe) => probe.purpose === purpose)
    .map((probe) => ({
      probe,
      score: probe.weight + scoreSnapshot(probe.snapshot),
    }))
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.probe || null;
}

function countPopulatedIntakeFields(record: Pick<IntakeRecord, "components" | "description" | "hardwareId" | "serial">): number {
  return [record.components, record.description, record.hardwareId, record.serial]
    .filter((value) => value.trim().length > 0)
    .length;
}

function hasStrongIntakeExtraction(record: IntakeRecord): boolean {
  const fieldCount = countPopulatedIntakeFields(record);
  return Boolean(record.hardwareId && (record.serial || record.description)) || fieldCount >= 3;
}

function hasUsableIntakeExtraction(record: IntakeRecord): boolean {
  const fieldCount = countPopulatedIntakeFields(record);
  const hasIdentity = Boolean(record.hardwareId || record.serial);
  const hasContext = Boolean(record.components || record.description);

  if (hasStrongIntakeExtraction(record)) {
    return true;
  }

  return Boolean(hasIdentity && hasContext) || fieldCount >= 2;
}

function chooseBestDescription(primary: string, fallback: string): string {
  if (!primary) {
    return fallback;
  }

  if (!fallback) {
    return primary;
  }

  const primaryHasBrand = KNOWN_BRANDS.some((brand) => primary.toUpperCase().includes(brand));
  const fallbackHasBrand = KNOWN_BRANDS.some((brand) => fallback.toUpperCase().includes(brand));

  if (primaryHasBrand && !fallbackHasBrand) {
    return primary;
  }

  if (fallbackHasBrand && !primaryHasBrand) {
    return fallback;
  }

  return fallback.length > primary.length ? fallback : primary;
}

function buildOcrNotes(fields: { hardwareId: string; serial: string; description: string; component: string; lowQuality?: boolean }): string {
  const count = [fields.hardwareId, fields.serial, fields.description, fields.component].filter((value) => value.trim().length > 0).length;

  if (count >= 3) {
    return fields.lowQuality
      ? "Extracted with regional PaddleOCR from a low-clarity image. Verify the values carefully before export."
      : "Extracted with regional PaddleOCR. Verify the values before export.";
  }

  if (count > 0) {
    return fields.lowQuality
      ? "Partially extracted from a blurry or low-quality image. Review and complete the missing values manually."
      : "Partially extracted with regional PaddleOCR. Review and complete the missing values manually.";
  }

  return fields.lowQuality
    ? "The image appears too blurry or low-quality for reliable OCR. Review and enter the values manually."
    : "Regional PaddleOCR could not isolate clear asset details. Review and enter the values manually.";
}

function buildIntakeRecordFromOcr(
  fileName: string,
  ocr: {
    full: OcrSnapshot;
    probes: IntakeProbeSnapshot[];
  }
): IntakeRecord {
  const bestPropertyProbe = pickBestPurposeProbe(ocr.probes, "property", scoreAssetProbeSnapshot);
  const bestLabelProbe = pickBestPurposeProbe(ocr.probes, "label", scoreLabelProbeSnapshot);
  const bestSerialProbe = pickBestPurposeProbe(ocr.probes, "serial", scoreSerialProbeSnapshot);
  const lowQualityImage = ocr.full.confidence < 0.52 || ocr.full.lines.length <= 1 || ocr.full.text.trim().length < 20;
  const weightedProbeTexts: WeightedOcrText[] = ocr.probes.map((probe) => ({
    text: probe.snapshot.text,
    weight: probe.weight,
  }));

  const assetSources: WeightedOcrText[] = [
    { text: bestPropertyProbe?.snapshot.text || "", weight: 60 },
    { text: bestLabelProbe?.snapshot.text || "", weight: 28 },
    { text: bestSerialProbe?.snapshot.text || "", weight: 24 },
    ...weightedProbeTexts,
    { text: ocr.full.text || "", weight: 12 },
  ].filter((source) => source.text.trim().length > 0);

  const hardwareId = pickBestAssetTag(assetSources);
  const descriptionLines = dedupePreserveOrder([
    ...getMeaningfulOcrLines(bestLabelProbe?.snapshot.text || ""),
    ...ocr.probes
      .filter((probe) => probe.purpose === "label")
      .flatMap((probe) => getMeaningfulOcrLines(probe.snapshot.text)),
    ...getMeaningfulOcrLines(bestPropertyProbe?.snapshot.text || ""),
    ...getMeaningfulOcrLines(bestSerialProbe?.snapshot.text || ""),
    ...ocr.probes.flatMap((probe) => getMeaningfulOcrLines(probe.snapshot.text)),
    ...getMeaningfulOcrLines(ocr.full.text || ""),
  ]);
  const combinedLabelText = [
    bestLabelProbe?.snapshot.text || "",
    ...ocr.probes
      .filter((probe) => probe.purpose === "label")
      .map((probe) => probe.snapshot.text),
    ocr.full.text || "",
  ].filter(Boolean).join("\n");
  const component = inferComponentFromText(combinedLabelText, hardwareId);
  const serial = pickBestSerial([
    { text: bestSerialProbe?.snapshot.text || "", weight: 46 },
    { text: bestLabelProbe?.snapshot.text || "", weight: 26 },
    ...ocr.probes
      .filter((probe) => probe.purpose !== "property")
      .map((probe) => ({
        text: probe.snapshot.text,
        weight: probe.weight,
      })),
    { text: ocr.full.text || "", weight: 12 },
  ].filter((source) => source.text.trim().length > 0), hardwareId);
  const description = chooseBestDescription(
    pickBestDescription(descriptionLines, component),
    pickBestDescription([
      ...getMeaningfulOcrLines(ocr.full.text || ""),
      ...descriptionLines,
    ], component)
  );

  return {
    sourceName: fileName,
    components: component,
    description,
    hardwareId,
    serial,
    remarks: "New Accountability",
    notes: buildOcrNotes({ hardwareId, serial, description, component, lowQuality: lowQualityImage }),
  };
}

function normalizeComparisonText(text: string): string {
  return sanitizeOcrValue(text)
    .replace(/\s+/g, " ")
    .trim();
}

function extractReferenceSerial(windowText: string, hardwareId: string): string {
  const serial = pickBestSerial([{ text: windowText, weight: 16 }], hardwareId);
  if (serial) {
    return serial;
  }

  const afterHardwareId = windowText.split(hardwareId)[1] || "";
  const fallback = afterHardwareId.match(/\b[A-Z0-9-]{6,}\b/);
  return normalizeAlphaNumericCandidate(fallback?.[0] || "");
}

function extractReferenceDescription(windowText: string, component: string, hardwareId: string): string {
  const normalized = normalizeComparisonText(windowText);
  const beforeHardwareId = normalized.split(hardwareId)[0] || normalized;
  const afterComponent = component ? beforeHardwareId.split(component).pop() || beforeHardwareId : beforeHardwareId;
  const candidateLines = [
    afterComponent,
    beforeHardwareId,
    normalized,
  ].flatMap((value) => value.split(/(?=[A-Z]{2,}\s[A-Z0-9-]{2,})/g));

  return pickBestDescription(candidateLines, component);
}

function extractReferenceRecordsFromText(text: string): ReferenceRecord[] {
  const lines = text
    .split(/\n+/)
    .map((line) => normalizeComparisonText(line))
    .filter((line) =>
      line &&
      !/^PAGE\s+\d+:?$/i.test(line) &&
      !/^EQUIPMENT ACCOUNTABILITY FORM$/i.test(line) &&
      !/^ACKNOWLEDGEMENT$/i.test(line)
    );

  const componentPattern = KNOWN_COMPONENT_LABELS
    .slice()
    .sort((left, right) => right.length - left.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const rowPattern = new RegExp(
    `\\b(${componentPattern})\\b\\s+(.+?)\\s+([A-Z]{1,8}-(?:19|20)\\d{2}-[A-Z0-9]{2,8})(?:\\s+(N\\/A|[A-Z0-9-]{4,}))?$`,
    "i"
  );

  const references = new Map<string, ReferenceRecord>();

  for (const line of lines) {
    const rowMatch = line.match(rowPattern);
    if (!rowMatch) {
      continue;
    }

    const component = rowMatch[1].toUpperCase();
    const description = normalizeComparisonText(rowMatch[2]);
    const hardwareId = normalizeAssetTagCandidate(rowMatch[3]);
    const serialCandidate = normalizeAlphaNumericCandidate(rowMatch[4] || "");
    const serial = serialCandidate && serialCandidate !== "N/A" ? serialCandidate : "";

    if (!hardwareId || references.has(hardwareId)) {
      continue;
    }

    references.set(hardwareId, {
      sourceName: "",
      components: component,
      description,
      hardwareId,
      serial,
      remarks: "New Accountability",
      notes: "Matched against the reference accountability source.",
    });
  }

  if (references.size > 0) {
    return [...references.values()];
  }

  const normalized = normalizeComparisonText(text);
  const hardwareRegex = /\b[A-Z]{1,8}-(?:19|20)\d{2}-[A-Z0-9]{2,8}\b/g;
  let match: RegExpExecArray | null;

  while ((match = hardwareRegex.exec(normalized)) !== null) {
    const hardwareId = normalizeAssetTagCandidate(match[0]);
    if (!hardwareId || references.has(hardwareId)) {
      continue;
    }

    const start = Math.max(0, match.index - 120);
    const end = Math.min(normalized.length, match.index + hardwareId.length + 180);
    const windowText = normalized.slice(start, end);

    const component = KNOWN_COMPONENT_LABELS
      .find((label) => windowText.toUpperCase().includes(label))
      || inferComponentFromHardwareId(hardwareId);
    const description = extractReferenceDescription(windowText, component, hardwareId);
    const serial = extractReferenceSerial(windowText, hardwareId);

    references.set(hardwareId, {
      sourceName: "",
      components: component,
      description,
      hardwareId,
      serial: serial === hardwareId ? "" : serial,
      remarks: "New Accountability",
      notes: "Matched against the reference accountability source.",
    });
  }

  return [...references.values()];
}

function extractReferenceRecords(referenceSource?: CompareSourceFile | null): ReferenceRecord[] {
  if (!referenceSource) {
    return [];
  }

  if (referenceSource.kind === "excel") {
    try {
      const parsed = JSON.parse(referenceSource.content);
      if (Array.isArray(parsed)) {
        return parsed
          .map((record) => ({
            sourceName: "",
            components: String(record?.Components || record?.components || "").trim(),
            description: String(record?.Description || record?.description || "").trim(),
            hardwareId: normalizeAssetTagCandidate(String(record?.["Hardware ID"] || record?.hardwareId || "").trim()),
            serial: String(record?.Serial || record?.serial || "").trim(),
            remarks: String(record?.Remarks || record?.remarks || "New Accountability").trim() || "New Accountability",
            notes: "Matched against the reference accountability source.",
          }))
          .filter((record) => record.components || record.description || record.hardwareId || record.serial);
      }
    } catch {
      return [];
    }
  }

  if (referenceSource.contentType === "text" && referenceSource.content) {
    return extractReferenceRecordsFromText(referenceSource.content);
  }

  return [];
}

function scoreReferenceMatch(record: IntakeRecord, reference: ReferenceRecord): number {
  let score = 0;
  const referenceHardwareId = sanitizeIntakeIdentifierValue(reference.hardwareId, "hardwareId");
  const referenceSerial = sanitizeIntakeIdentifierValue(reference.serial, "serial", referenceHardwareId);
  const referenceComponent = sanitizeIntakeTextValue(reference.components);
  const referenceDescription = sanitizeIntakeTextValue(reference.description);

  if (record.hardwareId && referenceHardwareId && record.hardwareId === referenceHardwareId) {
    score += 100;
  }

  if (record.serial && referenceSerial && record.serial === referenceSerial) {
    score += 85;
  }

  if (record.components && referenceComponent && record.components === referenceComponent) {
    score += 25;
  }

  if (record.description && referenceDescription) {
    const recordDescription = record.description.toUpperCase();
    const normalizedReferenceDescription = referenceDescription.toUpperCase();
    if (recordDescription === normalizedReferenceDescription) {
      score += 35;
    } else if (
      recordDescription.includes(normalizedReferenceDescription) ||
      normalizedReferenceDescription.includes(recordDescription)
    ) {
      score += 20;
    }
  }

  if (!record.hardwareId && record.components && referenceComponent === record.components) {
    const recordBrand = KNOWN_BRANDS.find((brand) => record.description.toUpperCase().includes(brand));
    const referenceBrand = KNOWN_BRANDS.find((brand) => referenceDescription.toUpperCase().includes(brand));
    if (recordBrand && referenceBrand && recordBrand === referenceBrand) {
      score += 18;
    }
  }

  return score;
}

function reconcileRecordWithReference(record: IntakeRecord, referenceRecords: ReferenceRecord[]): IntakeRecord {
  if (referenceRecords.length === 0) {
    return record;
  }

  const bestMatch = referenceRecords
    .map((reference) => ({ reference, score: scoreReferenceMatch(record, reference) }))
    .sort((left, right) => right.score - left.score)[0];

  if (!bestMatch || bestMatch.score < 35) {
    return record;
  }

  const reference = bestMatch.reference;
  const referenceComponent = sanitizeIntakeTextValue(reference.components);
  const referenceDescription = sanitizeIntakeTextValue(reference.description);
  const referenceHardwareId = sanitizeIntakeIdentifierValue(reference.hardwareId, "hardwareId");
  const mergedHardwareId = choosePreferredIdentifier(referenceHardwareId, record.hardwareId);
  const referenceSerial = sanitizeIntakeIdentifierValue(reference.serial, "serial", mergedHardwareId);

  return {
    ...record,
    components: choosePreferredComponent(referenceComponent, record.components),
    description: chooseBestDescription(record.description, referenceDescription),
    hardwareId: mergedHardwareId,
    serial: choosePreferredSerial(referenceSerial, record.serial, mergedHardwareId),
    notes: "Matched against the reference accountability source and aligned to the validated document details.",
  };
}

function alignRecordsToReferenceBatch(records: IntakeRecord[], referenceRecords: ReferenceRecord[]): IntakeRecord[] {
  if (referenceRecords.length === 0 || records.length === 0) {
    return records;
  }

  const pairings = records.flatMap((record, recordIndex) =>
    referenceRecords.map((reference, referenceIndex) => ({
      recordIndex,
      referenceIndex,
      score: scoreReferenceMatch(record, reference),
    }))
  )
    .filter((pairing) => pairing.score >= 35)
    .sort((left, right) => right.score - left.score);

  const usedRecords = new Set<number>();
  const usedReferences = new Set<number>();
  const aligned = records.map((record) => ({ ...record }));

  for (const pairing of pairings) {
    if (usedRecords.has(pairing.recordIndex) || usedReferences.has(pairing.referenceIndex)) {
      continue;
    }

    usedRecords.add(pairing.recordIndex);
    usedReferences.add(pairing.referenceIndex);
    aligned[pairing.recordIndex] = reconcileRecordWithReference(
      aligned[pairing.recordIndex],
      [referenceRecords[pairing.referenceIndex]]
    );
  }

  return aligned;
}

function sanitizeAccountabilityPayload(payload: Partial<AccountabilityFormPayload> | undefined): AccountabilityFormPayload {
  const normalizedItems = Array.isArray(payload?.items) ? payload.items.map(normalizeIntakeRecord) : [];
  const dedupedItems = dedupeIntakeRecords(normalizedItems);

  return {
    employeeName: typeof payload?.employeeName === "string" ? payload.employeeName : "",
    employeeId: typeof payload?.employeeId === "string" ? payload.employeeId : "",
    designation: typeof payload?.designation === "string" ? payload.designation : "",
    department: typeof payload?.department === "string" ? payload.department : "",
    effectiveDate: typeof payload?.effectiveDate === "string" ? payload.effectiveDate : "",
    signature: typeof payload?.signature === "string" ? payload.signature : "",
    signatureDataUrl: typeof payload?.signatureDataUrl === "string" ? payload.signatureDataUrl : "",
    processedBy: typeof payload?.processedBy === "string" ? payload.processedBy : "",
    processedDate: typeof payload?.processedDate === "string" ? payload.processedDate : "",
    checkedBy: typeof payload?.checkedBy === "string" ? payload.checkedBy : "",
    checkedDate: typeof payload?.checkedDate === "string" ? payload.checkedDate : "",
    verifiedBy: typeof payload?.verifiedBy === "string" ? payload.verifiedBy : "",
    verifiedTitle: typeof payload?.verifiedTitle === "string" ? payload.verifiedTitle : "",
    verifiedDate: typeof payload?.verifiedDate === "string" ? payload.verifiedDate : "",
    notedBy: typeof payload?.notedBy === "string" ? payload.notedBy : "",
    notedTitle: typeof payload?.notedTitle === "string" ? payload.notedTitle : "",
    notedDate: typeof payload?.notedDate === "string" ? payload.notedDate : "",
    items: dedupedItems,
  };
}

const terTravelEntriesPath = path.join(process.cwd(), "uploads", "ter-travel-entries.json");
let terTravelEntriesCache: PersistedTerTravelEntry[] | null = null;

function sanitizeTerId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const clean = raw.replace(/[^a-zA-Z0-9:_@./ -]+/g, "").slice(0, 160).trim();
  return clean || "ter:shared";
}

function sanitizeTerTravelEntry(terId: string, value: unknown): PersistedTerTravelEntry {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const normalized = normalizeLiquidationRecord(raw as Partial<LiquidationRecord>);
  const now = new Date().toISOString();
  const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
  const id = rawId.slice(0, 160) || crypto.randomUUID();
  const createdAt = typeof raw.createdAt === "string" && raw.createdAt.trim() ? raw.createdAt : now;
  return {
    ...normalized,
    id,
    terId,
    createdAt,
    updatedAt: now,
    ticketFileName: typeof raw.ticketFileName === "string" ? raw.ticketFileName.slice(0, 240) : undefined,
    ticketMimeType: typeof raw.ticketMimeType === "string" ? raw.ticketMimeType.slice(0, 120) : undefined,
    ticketImageData: (
      typeof raw.ticketImageData === "string" &&
      /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.ticketImageData)
    ) ? raw.ticketImageData : undefined,
  };
}

async function loadTerTravelEntries(): Promise<PersistedTerTravelEntry[]> {
  if (terTravelEntriesCache) return terTravelEntriesCache;

  try {
    const raw = await fs.promises.readFile(terTravelEntriesPath, "utf8");
    const parsed = JSON.parse(raw);
    terTravelEntriesCache = Array.isArray(parsed)
      ? parsed.map((entry: any) => sanitizeTerTravelEntry(sanitizeTerId(entry?.terId), entry))
      : [];
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.warn("Unable to read TER travel entries:", error?.message || error);
    }
    terTravelEntriesCache = [];
  }

  return terTravelEntriesCache;
}

async function writeTerTravelEntries(entries: PersistedTerTravelEntry[]) {
  terTravelEntriesCache = entries;
  await fs.promises.mkdir(path.dirname(terTravelEntriesPath), { recursive: true });
  const tempPath = `${terTravelEntriesPath}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(entries, null, 2), "utf8");
  await fs.promises.rename(tempPath, terTravelEntriesPath);
}

async function upsertTerTravelEntry(entry: PersistedTerTravelEntry): Promise<PersistedTerTravelEntry> {
  const entries = await loadTerTravelEntries();
  const index = entries.findIndex((candidate) => candidate.terId === entry.terId && candidate.id === entry.id);

  if (index >= 0) {
    const merged = {
      ...entries[index],
      ...entry,
      createdAt: entries[index].createdAt || entry.createdAt,
      updatedAt: new Date().toISOString(),
    };
    const next = entries.slice();
    next[index] = merged;
    await writeTerTravelEntries(next);
    return merged;
  }

  const next = entries.concat([entry]);
  await writeTerTravelEntries(next);
  return entry;
}

async function getTerTravelEntries(terId: string): Promise<PersistedTerTravelEntry[]> {
  const entries = await loadTerTravelEntries();
  return entries
    .filter((entry) => entry.terId === terId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function runPowerShellScript(scriptPath: string, args: string[]) {
  if (process.platform !== "win32") {
    throw new Error(`PowerShell Excel export is only available on Windows; current platform is ${process.platform}.`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error((stderr || stdout || `PowerShell exited with code ${code}`).trim()));
    });
  });
}

async function generateAccountabilityWorkbook(payload: AccountabilityFormPayload) {
  const templatePath = path.join(process.cwd(), "public", "forms", "accountability-form-template.xlsx");
  const exportScriptPath = path.join(process.cwd(), "tools", "export-accountability-form.ps1");
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "acct-export-"));
  const payloadPath = path.join(tempDirectory, "payload.json");
  const outputPath = path.join(tempDirectory, "accountability-form.xlsx");

  try {
    await fs.promises.writeFile(payloadPath, JSON.stringify(payload, null, 2), "utf8");
    await runPowerShellScript(exportScriptPath, [
      "-TemplatePath", templatePath,
      "-PayloadPath", payloadPath,
      "-OutputPath", outputPath,
    ]);

    return await fs.promises.readFile(outputPath);
  } finally {
    await fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function buildSmartCaptureExportRows(payload: AccountabilityFormPayload): string[][] {
  const formRows = [
    ["Name", payload.employeeName, "ID No.", payload.employeeId],
    ["Designation", payload.designation, "Department", payload.department],
    ["Effective Date", payload.effectiveDate, "Processed By", payload.processedBy],
    ["Processed Date", payload.processedDate, "Checked By", payload.checkedBy],
    ["Checked Date", payload.checkedDate, "Verified By", payload.verifiedBy],
    ["Verified Title", payload.verifiedTitle, "Verified Date", payload.verifiedDate],
    ["Noted By", payload.notedBy, "Noted Title", payload.notedTitle],
    ["Noted Date", payload.notedDate, "", ""],
  ];

  return [
    ["Smart Capture Workflow"],
    [],
    ["Equipment Details"],
    ["Components", "Description", "Hardware ID", "Serial", "Remarks"],
    ...payload.items.map((item) => [
      item.components,
      item.description,
      item.hardwareId,
      item.serial,
      item.remarks,
    ]),
    [],
    ["Form Details"],
    ...formRows,
    [],
    ["Processed Signature", payload.signatureDataUrl ? "Attached" : payload.signature || ""],
  ];
}

function generateSmartCaptureExcelExport(payload: AccountabilityFormPayload): Buffer {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(buildSmartCaptureExportRows(payload));

  worksheet["!cols"] = [
    { wch: 24 },
    { wch: 30 },
    { wch: 22 },
    { wch: 24 },
    { wch: 30 },
  ];

  XLSX.utils.book_append_sheet(workbook, worksheet, "Smart Capture");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

function wrapPdfText(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function drawPdfText(page: any, text: string, x: number, y: number, options: {
  font: any;
  size: number;
  maxWidth?: number;
  color?: any;
  lineHeight?: number;
}) {
  const lines = options.maxWidth
    ? wrapPdfText(text, options.font, options.size, options.maxWidth)
    : [String(text || "")];
  const lineHeight = options.lineHeight || options.size + 3;

  lines.forEach((line, index) => {
    page.drawText(line, {
      x,
      y: y - index * lineHeight,
      size: options.size,
      font: options.font,
      color: options.color || rgb(0.12, 0.16, 0.23),
    });
  });

  return y - Math.max(0, lines.length - 1) * lineHeight;
}

async function generateSmartCapturePdfExport(payload: AccountabilityFormPayload): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const sourcePageWidth = 842;
  const sourcePageHeight = 595;
  const portraitPageWidth = 595;
  const portraitPageHeight = 842;
  const page = pdf.addPage([portraitPageWidth, portraitPageHeight]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const dark = rgb(0.10, 0.14, 0.20);
  const muted = rgb(0.38, 0.45, 0.55);
  const border = rgb(0.68, 0.73, 0.80);
  const light = rgb(0.97, 0.98, 0.99);

  page.drawText("Smart Capture Workflow", { x: 32, y: 560, size: 13, font: bold, color: dark });

  const leftX = 32;
  const leftY = 526;
  const leftW = 456;
  const tableTop = leftY - 42;
  const rightX = 510;
  const rightY = 526;
  const rightW = 300;

  page.drawRectangle({ x: leftX, y: tableTop - 230, width: leftW, height: 272, borderColor: border, borderWidth: 1, color: rgb(1, 1, 1) });
  page.drawText("Equipment Details", { x: leftX + 12, y: leftY - 20, size: 10, font: bold, color: dark });

  const columns = [
    { label: "Components", key: "components", width: 88 },
    { label: "Description", key: "description", width: 112 },
    { label: "Hardware ID", key: "hardwareId", width: 86 },
    { label: "Serial", key: "serial", width: 82 },
    { label: "Remarks", key: "remarks", width: 88 },
  ];
  let x = leftX;
  page.drawRectangle({ x: leftX, y: tableTop, width: leftW, height: 18, color: light, borderColor: border, borderWidth: 1 });
  columns.forEach((column) => {
    page.drawRectangle({ x, y: tableTop, width: column.width, height: 18, borderColor: border, borderWidth: 0.7 });
    page.drawText(column.label, { x: x + 4, y: tableTop + 5, size: 7, font: bold, color: dark });
    x += column.width;
  });

  let rowY = tableTop - 20;
  payload.items.slice(0, 12).forEach((item) => {
    x = leftX;
    columns.forEach((column) => {
      page.drawRectangle({ x, y: rowY, width: column.width, height: 20, borderColor: border, borderWidth: 0.7 });
      drawPdfText(page, String((item as any)[column.key] || ""), x + 4, rowY + 12, {
        font: regular,
        size: 6.5,
        maxWidth: column.width - 8,
        lineHeight: 7,
      });
      x += column.width;
    });
    rowY -= 20;
  });

  page.drawRectangle({ x: rightX, y: rightY - 380, width: rightW, height: 390, borderColor: border, borderWidth: 1, color: rgb(1, 1, 1) });
  page.drawText("Form Details", { x: rightX + 12, y: rightY - 14, size: 10, font: bold, color: dark });
  page.drawText("Confirm the hierarchy and exported form information.", { x: rightX + 12, y: rightY - 28, size: 6.5, font: regular, color: muted });

  const detailRows = [
    ["Name", payload.employeeName, "ID No.", payload.employeeId],
    ["Designation", payload.designation, "Department", payload.department],
    ["Effective Date", payload.effectiveDate, "Processed By", payload.processedBy],
    ["Processed Date", payload.processedDate, "Checked By", payload.checkedBy],
    ["Checked Date", payload.checkedDate, "Verified By", payload.verifiedBy],
    ["Verified Title", payload.verifiedTitle, "Verified Date", payload.verifiedDate],
    ["Noted By", payload.notedBy, "Noted Title", payload.notedTitle],
    ["Noted Date", payload.notedDate, "", ""],
  ];

  let detailY = rightY - 56;
  detailRows.forEach(([labelA, valueA, labelB, valueB]) => {
    page.drawText(labelA, { x: rightX + 12, y: detailY + 14, size: 5.5, font: bold, color: muted });
    page.drawRectangle({ x: rightX + 12, y: detailY - 4, width: 132, height: 15, borderColor: border, borderWidth: 0.5, color: light });
    drawPdfText(page, valueA, rightX + 16, detailY + 1, { font: regular, size: 6.5, maxWidth: 124 });
    if (labelB) {
      page.drawText(labelB, { x: rightX + 156, y: detailY + 14, size: 5.5, font: bold, color: muted });
      page.drawRectangle({ x: rightX + 156, y: detailY - 4, width: 132, height: 15, borderColor: border, borderWidth: 0.5, color: light });
      drawPdfText(page, valueB, rightX + 160, detailY + 1, { font: regular, size: 6.5, maxWidth: 124 });
    }
    detailY -= 36;
  });

  page.drawText("Processed Signature", { x: rightX + 12, y: detailY + 18, size: 5.5, font: bold, color: muted });
  page.drawRectangle({ x: rightX + 12, y: detailY - 24, width: rightW - 24, height: 36, borderColor: border, borderWidth: 0.5, color: light });

  const signatureDataUrl = payload.signatureDataUrl || "";
  const signatureMatch = signatureDataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
  if (signatureMatch) {
    try {
      const signatureBytes = Buffer.from(signatureMatch[2], "base64");
      const signatureImage = signatureMatch[1].toLowerCase() === "png"
        ? await pdf.embedPng(signatureBytes)
        : await pdf.embedJpg(signatureBytes);
      const scale = Math.min(130 / signatureImage.width, 28 / signatureImage.height);
      page.drawImage(signatureImage, {
        x: rightX + 88,
        y: detailY - 20,
        width: signatureImage.width * scale,
        height: signatureImage.height * scale,
      });
    } catch {
      page.drawText(payload.signature || payload.processedBy || "", { x: rightX + 18, y: detailY - 6, size: 7, font: regular, color: dark });
    }
  } else {
    page.drawText(payload.signature || payload.processedBy || "", { x: rightX + 18, y: detailY - 6, size: 7, font: regular, color: dark });
  }

  const portraitScale = Math.min(
    portraitPageWidth / sourcePageWidth,
    portraitPageHeight / sourcePageHeight
  );
  page.scaleContent(portraitScale, portraitScale);
  page.translateContent(
    (portraitPageWidth - sourcePageWidth * portraitScale) / 2,
    (portraitPageHeight - sourcePageHeight * portraitScale) / 2
  );

  return Buffer.from(await pdf.save());
}

async function generateOfficialSmartCapturePdfExport(payload: AccountabilityFormPayload): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const pageWidth = 612;
  const pageHeight = 792;
  const page = pdf.addPage([pageWidth, pageHeight]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const orange = rgb(0.95, 0.36, 0.10);
  const red = rgb(0.90, 0.08, 0.08);
  const blue = rgb(0.12, 0.31, 0.74);

  const line = (x1: number, y1: number, x2: number, y2: number, width = 0.55) => {
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: width, color: black });
  };
  const centerText = (text: string, y: number, size: number, font: any, color = black) => {
    page.drawText(text, { x: (pageWidth - font.widthOfTextAtSize(text, size)) / 2, y, size, font, color });
  };
  const centerSmall = (text: string, x: number, y: number, width: number) => {
    page.drawText(text, { x: x + (width - regular.widthOfTextAtSize(text, 4.8)) / 2, y, size: 4.8, font: regular, color: black });
  };
  const safeDate = (value: string) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime())
      ? raw
      : parsed.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  };
  const field = (label: string, value: string, x: number, y: number, lineEnd: number, labelWidth = 45) => {
    page.drawText(label, { x, y: y + 3, size: 5.7, font: bold, color: black });
    page.drawText(":", { x: x + labelWidth, y: y + 3, size: 5.7, font: bold, color: black });
    line(x + labelWidth + 7, y + 2, lineEnd, y + 2, 0.55);
    drawPdfText(page, value || "", x + labelWidth + 10, y + 4, {
      font: regular,
      size: 6,
      maxWidth: Math.max(20, lineEnd - (x + labelWidth + 12)),
      lineHeight: 6.5,
    });
  };
  const loadHeaderImage = async () => {
    try {
      const templatePath = path.join(process.cwd(), "public", "forms", "accountability-form-template.xlsx");
      const templateBytes = await fs.promises.readFile(templatePath);
      const embeddedLogoBytes = extractZipEntryBuffer(templateBytes, "xl/media/image1.png");
      if (embeddedLogoBytes?.length) {
        return await pdf.embedPng(embeddedLogoBytes);
      }

      const workbook = XLSX.read(templateBytes, { type: "buffer", bookFiles: true } as any) as any;
      const files = workbook.files || {};
      const logoFile = files["xl/media/image1.png"] || Object.entries(files).find(([name]) => name.endsWith("/media/image1.png"))?.[1] as any;
      const content = logoFile?.content;
      let logoBytes: Buffer | null = null;
      if (Buffer.isBuffer(content)) {
        logoBytes = content;
      } else if (content instanceof Uint8Array) {
        logoBytes = Buffer.from(content);
      } else if (content instanceof ArrayBuffer) {
        logoBytes = Buffer.from(new Uint8Array(content));
      } else if (content?.buffer instanceof ArrayBuffer) {
        logoBytes = Buffer.from(content.buffer, content.byteOffset || 0, content.byteLength || content.buffer.byteLength);
      } else if (Array.isArray(content)) {
        logoBytes = Buffer.from(content);
      } else if (typeof content === "string") {
        logoBytes = Buffer.from(content, "binary");
      }
      return logoBytes?.length ? await pdf.embedPng(logoBytes) : null;
    } catch {
      return null;
    }
  };
  const loadSignature = async (maxWidth: number, maxHeight: number) => {
    const signatureMatch = (payload.signatureDataUrl || "").match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
    if (!signatureMatch) return null;
    try {
      const bytes = Buffer.from(signatureMatch[2], "base64");
      const image = signatureMatch[1].toLowerCase() === "png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
      return { image, width: image.width * scale, height: image.height * scale };
    } catch {
      return null;
    }
  };

  const headerImage = await loadHeaderImage();
  const signature = await loadSignature(78, 18);

  if (headerImage) {
    const headerWidth = 238;
    const headerHeight = headerWidth * (headerImage.height / headerImage.width);
    page.drawImage(headerImage, {
      x: (pageWidth - headerWidth) / 2,
      y: 708,
      width: headerWidth,
      height: headerHeight,
    });
  } else {
    page.drawRectangle({ x: 263, y: 719, width: 7, height: 21, color: orange });
    page.drawCircle({ x: 278, y: 730, size: 5.8, color: rgb(0.97, 0.62, 0.18) });
    page.drawRectangle({ x: 272, y: 711, width: 11, height: 18, color: blue });
    page.drawText("LifeBank", { x: 291, y: 727, size: 11.5, font: bold, color: red });
    page.drawText("FOUNDATION", { x: 292, y: 720, size: 5.3, font: bold, color: red });
    centerText("INFRASTRUCTURE AND INFORMATION AND COMMUNICATIONS TECHNOLOGY", 704, 5.2, bold, orange);
  }
  centerText("EQUIPMENT ACCOUNTABILITY FORM", 674, 8, bold);
  line(229, 672, 383, 672, 0.5);

  field("Name", payload.employeeName, 46, 642, 210, 38);
  field("ID No.", payload.employeeId, 229, 642, 392, 50);
  field("Signature", "", 413, 642, 566, 54);
  field("Designation", payload.designation, 46, 625, 210, 38);
  field("Department", payload.department, 229, 625, 392, 50);
  field("Effective Date", safeDate(payload.effectiveDate), 413, 625, 566, 54);

  const tableX = 46;
  const tableTop = 613;
  const rowHeight = 13.8;
  const columns = [
    { label: "Components", key: "components", width: 92 },
    { label: "Description", key: "description", width: 126 },
    { label: "Hardware ID", key: "hardwareId", width: 111 },
    { label: "Serial", key: "serial", width: 99 },
    { label: "Remarks", key: "remarks", width: 92 },
  ];
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  const tableRows = 24;
  const rowHeights = Array.from({ length: tableRows }, (_, row) => {
    const item = payload.items[row] as any;
    const remarksColumn = columns.find((column) => column.key === "remarks");
    if (!item || !remarksColumn) return rowHeight;
    const remarksLines = wrapPdfText(String(item.remarks || ""), regular, 5.2, remarksColumn.width - 7).length;
    return rowHeight + Math.max(0, remarksLines - 1) * 5.7;
  });
  let x = tableX;

  columns.forEach((column) => {
    page.drawRectangle({ x, y: tableTop - rowHeight, width: column.width, height: rowHeight, borderColor: black, borderWidth: 0.65 });
    const textWidth = bold.widthOfTextAtSize(column.label, 5.2);
    page.drawText(column.label, { x: x + (column.width - textWidth) / 2, y: tableTop - 9.2, size: 5.2, font: bold, color: black });
    x += column.width;
  });

  let rowBottom = tableTop - rowHeight;
  for (let row = 0; row < tableRows; row += 1) {
    const currentRowHeight = rowHeights[row];
    const y = rowBottom - currentRowHeight;
    x = tableX;
    columns.forEach((column) => {
      page.drawRectangle({ x, y, width: column.width, height: currentRowHeight, borderColor: black, borderWidth: 0.65 });
      const item = payload.items[row] as any;
      if (item) {
        drawPdfText(page, String(item[column.key] || ""), x + 3.5, y + currentRowHeight - 8.5, {
          font: regular,
          size: 5.2,
          maxWidth: column.width - 7,
          lineHeight: 5.7,
        });
      }
      x += column.width;
    });
    rowBottom = y;
  }

  const ackY = rowBottom - 2;
  page.drawText("ACKNOWLEDGEMENT", { x: tableX, y: ackY, size: 5, font: bold, color: black });
  const acknowledgement = "This is to acknowledge that I am accountable for the listed above. I understand that I will pay or replace the same unit in case of loss or damage due to my fault or negligence. In case of resignation or separation, I will turnover these items before issuance of my clearance. In case of transfer, I will turnover these items to the newly assigned staff with attached accountability form. For any additional software protected with license installed that do not appear on the list above, or do not have any supporting document/s coming from the IICTD Office, it is my responsibility to face any charges or liability coming from any software authority or organization. Also, I will follow the rules and regulations imposed by the Lifebank Foundation Inc. and I will be liable for any consequences that may arise for not complying with the set of rules and regulations.";
  drawPdfText(page, acknowledgement, tableX, ackY - 7, { font: regular, size: 4.25, maxWidth: tableWidth, lineHeight: 4.8 });

  const signatureBlock = (label: string, name: string, title: string, date: string, x0: number, y0: number, useSignature = false) => {
    const lineWidth = 102;
    const lineX = x0 + 77;
    const centerX = lineX + lineWidth / 2;
    const nameLineY = y0 - 6;
    const labelY = nameLineY - 10;
    const dateLineY = nameLineY - 25;
    const centerFit = (text: string, y: number, font: any, size: number, maxWidth: number) => {
      const value = String(text || "").trim();
      if (!value) return;
      let drawSize = size;
      while (drawSize > 3.9 && font.widthOfTextAtSize(value, drawSize) > maxWidth) {
        drawSize -= 0.2;
      }
      page.drawText(value, {
        x: centerX - font.widthOfTextAtSize(value, drawSize) / 2,
        y,
        size: drawSize,
        font,
        color: black,
      });
    };

    page.drawText(label, { x: x0, y: y0, size: 5.2, font: bold, color: black });
    if (useSignature && signature) {
      page.drawImage(signature.image, {
        x: centerX - signature.width / 2,
        y: nameLineY + 6,
        width: signature.width,
        height: signature.height,
      });
    }
    centerFit(name, nameLineY + 2, bold, 5, lineWidth - 4);
    line(lineX, nameLineY, lineX + lineWidth, nameLineY);
    centerFit(title || "Signature over Printed Name", labelY, regular, 4.8, lineWidth - 4);
    line(lineX, dateLineY, lineX + lineWidth, dateLineY);
    const dateText = safeDate(date);
    centerFit(dateText, dateLineY + 2, regular, 4.8, lineWidth - 4);
    centerSmall("Date", lineX, dateLineY - 11, lineWidth);
  };

  signatureBlock("Processed by:", payload.processedBy, "", payload.processedDate, 46, 178, true);
  signatureBlock("Checked by:", payload.checkedBy, "", payload.checkedDate, 225, 178);
  signatureBlock("Verified by:", payload.verifiedBy, payload.verifiedTitle, payload.verifiedDate, 410, 178);
  signatureBlock("Noted by:", payload.notedBy, payload.notedTitle, payload.notedDate, 410, 112);

  return Buffer.from(await pdf.save());
}

async function generateSmartCaptureFallbackExport(
  payload: AccountabilityFormPayload,
  format: AccountabilityExportFormat
): Promise<{ buffer: Buffer; contentType: string; extension: AccountabilityExportFormat }> {
  if (format === "pdf") {
    return {
      buffer: await generateOfficialSmartCapturePdfExport(payload),
      contentType: "application/pdf",
      extension: "pdf",
    };
  }

  return {
    buffer: generateSmartCaptureExcelExport(payload),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  };
}

function getAccountabilityExportFormat(value: unknown): AccountabilityExportFormat {
  return value === "pdf" ? "pdf" : "xlsx";
}

function getLiquidationExportFormat(value: unknown): LiquidationExportFormat {
  return value === "pdf" ? "pdf" : "xlsx";
}

async function writeSignatureImageFromDataUrl(dataUrl: string, directory: string): Promise<string | null> {
  const trimmed = (dataUrl || "").trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new Error("The signature attachment must be a valid image data URL.");
  }

  const mimeType = match[1].toLowerCase();
  const extension = mimeType.includes("jpeg")
    ? "jpg"
    : mimeType.includes("svg")
      ? "svg"
      : mimeType.includes("gif")
        ? "gif"
        : "png";
  const filePath = path.join(directory, `signature.${extension}`);

  await fs.promises.writeFile(filePath, Buffer.from(match[2], "base64"));
  return filePath;
}

async function generateAccountabilityExport(
  payload: AccountabilityFormPayload,
  format: AccountabilityExportFormat
): Promise<{ buffer: Buffer; contentType: string; extension: AccountabilityExportFormat }> {
  if (process.platform !== "win32") {
    return generateSmartCaptureFallbackExport(payload, format);
  }

  const templatePath = path.join(process.cwd(), "public", "forms", "accountability-form-template.xlsx");
  const exportScriptPath = path.join(process.cwd(), "tools", "export-accountability-form.ps1");
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "acct-export-"));
  const payloadPath = path.join(tempDirectory, "payload.json");
  const signatureImagePath = await writeSignatureImageFromDataUrl(payload.signatureDataUrl || "", tempDirectory);
  const outputPath = path.join(tempDirectory, `accountability-form.${format}`);

  try {
    await fs.promises.writeFile(payloadPath, JSON.stringify(payload, null, 2), "utf8");
    await runPowerShellScript(exportScriptPath, [
      "-TemplatePath", templatePath,
      "-PayloadPath", payloadPath,
      "-OutputPath", outputPath,
      "-Format", format,
      ...(signatureImagePath ? ["-SignatureImagePath", signatureImagePath] : []),
    ]);

    return {
      buffer: await fs.promises.readFile(outputPath),
      contentType: format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: format,
    };
  } finally {
    await fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function setWorksheetStringCell(worksheet: XLSX.WorkSheet, cellReference: string, value: string) {
  const cell = worksheet[cellReference] || {};
  worksheet[cellReference] = {
    ...cell,
    t: "s",
    v: String(value || ""),
  };
}

function setWorksheetNumberCell(worksheet: XLSX.WorkSheet, cellReference: string, value: number) {
  const cell = worksheet[cellReference] || {};
  worksheet[cellReference] = {
    ...cell,
    t: "n",
    v: Number.isFinite(value) ? value : 0,
  };
}

function setWorksheetFormulaCell(
  worksheet: XLSX.WorkSheet,
  cellReference: string,
  formula: string,
  calculatedValue: number | string
): void {
  const existing = worksheet[cellReference] || {};
  worksheet[cellReference] = {
    ...existing,
    t: typeof calculatedValue === "number" ? "n" : "s",
    v: calculatedValue,
    f: formula,
  };
}

function getWrappedLineCount(value: string, capacity: number): number {
  const text = String(value || "").trim();
  if (!text) return 1;
  const words = text.split(/\s+/);
  let lines = 1;
  let current = 0;
  for (const word of words) {
    if (word.length > capacity) {
      lines += Math.max(0, Math.ceil(word.length / capacity) - (current ? 0 : 1));
      current = word.length % capacity;
      continue;
    }
    const next = current ? current + 1 + word.length : word.length;
    if (next > capacity) {
      lines += 1;
      current = word.length;
    } else {
      current = next;
    }
  }
  return Math.max(1, lines);
}

function getLiquidationRowHeight(item: LiquidationRecord): number {
  const lineCount = Math.max(
    1,
    getWrappedLineCount(normalizeLiquidationTableTime(item.time), 17),
    getWrappedLineCount(item.from, 15),
    getWrappedLineCount(item.to, 15),
    getWrappedLineCount(item.modeOfTransportation, 10),
    getWrappedLineCount(item.remarks, 22)
  );
  return Math.min(34, Math.max(13, 13 + (lineCount - 1) * 7.2));
}

async function generateLiquidationPdfExport(payload: LiquidationFormPayload): Promise<Buffer> {
  // Portrait A4
  const PAGE_W = 595;
  const PAGE_H = 842;
  const ML  = 28;                  // left/right margin
  const MR  = PAGE_W - ML;        // right edge of content (567)
  const TABLE_W = MR - ML;        // 539

  // Column definitions — widths must sum to TABLE_W (539)
  // "Others" (Excel col K) is excluded from the PDF; the official printed form shows 10 columns.
  // Its 37 px are redistributed: Mode +10, Amount +4, PerDiem +2, Remarks +21.
  const COLS = [
    { label: "DATE",                    key: "transactionDate",      width: 38,  meals: false },
    { label: "TIME",                    key: "time",                 width: 42,  meals: false },
    { label: "FROM",                    key: "from",                 width: 52,  meals: false },
    { label: "TO",                      key: "to",                   width: 52,  meals: false },
    { label: "MODE OF\nTRANSPORTATION", key: "modeOfTransportation", width: 88,  meals: false },
    { label: "AMOUNT",                  key: "amount",               width: 50,  meals: false },
    { label: "PER DIEM",                key: "perDiem",              width: 44,  meals: false },
    { label: "B",                       key: "breakfast",            width: 22,  meals: true  },
    { label: "L",                       key: "lunch",                width: 22,  meals: true  },
    { label: "D",                       key: "dinner",               width: 22,  meals: true  },
    { label: "REMARKS",                 key: "remarks",              width: 107, meals: false },
  ] as const;

  const HDR1_H  = 14;  // table header row 1 height
  const HDR2_H  = 11;  // table header row 2 (B / L / D sub-labels)
  const ROW_H   = 14;  // data / empty row height
  const MIN_ROWS = 30; // minimum visible rows (form must stay full-page)

  // Bottom reserve: totals row + PHP-amounts table + signatures + footer
  const BOTTOM_RESERVE = 158;

  const pdf    = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold    = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic  = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const black   = rgb(0, 0, 0);
  const border  = rgb(0.15, 0.15, 0.15);  // near-black inner gridlines
  const hdrBg   = rgb(0.90, 0.90, 0.90);  // light grey header fill (no blue tint)
  const muted   = rgb(0.30, 0.36, 0.46);
  const grey    = rgb(0.65, 0.65, 0.65);

  // ── helpers ──────────────────────────────────────────────────────────────
  const ctrText = (pg: any, text: string, y: number, size: number, font: any, color = black) =>
    pg.drawText(text, { x: (PAGE_W - font.widthOfTextAtSize(text, size)) / 2, y, size, font, color });

  const hline = (pg: any, x1: number, y: number, x2: number, thick = 0.5, color = border) =>
    pg.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: thick, color });

  const rect = (pg: any, x: number, y: number, w: number, h: number, options: any = {}) =>
    pg.drawRectangle({ x, y, width: w, height: h, borderWidth: 0.5, borderColor: border, ...options });

  // Label and value on the same baseline.
  // Header fields stay one-line only to avoid overlap/cut-off.
  const drawField = (pg: any, label: string, value: string, x: number, y: number, endX: number) => {
    const labelText = `${label}:`;
    const baseFontSize = 6;
    const minFontSize = 4.6;
    const textY = y;

    const safeValue = String(value || "")
      .replace(/\s+/g, " ")
      .trim();

    pg.drawText(labelText, {
      x,
      y: textY,
      size: baseFontSize,
      font: bold,
      color: black,
    });

    const labelWidth = bold.widthOfTextAtSize(`${labelText} `, baseFontSize);
    const valueX = x + labelWidth;
    const maxValueWidth = Math.max(1, endX - valueX - 2);

    if (!safeValue) {
      return;
    }

    let drawValue = safeValue;
    let valueFontSize = baseFontSize;

    while (
      valueFontSize > minFontSize &&
      regular.widthOfTextAtSize(drawValue, valueFontSize) > maxValueWidth
    ) {
      valueFontSize = Math.max(minFontSize, valueFontSize - 0.2);
    }

    if (regular.widthOfTextAtSize(drawValue, valueFontSize) > maxValueWidth) {
      const ellipsis = "...";

      while (
        drawValue.length > 0 &&
        regular.widthOfTextAtSize(`${drawValue}${ellipsis}`, valueFontSize) > maxValueWidth
      ) {
        drawValue = drawValue.slice(0, -1);
      }

      drawValue = drawValue ? `${drawValue}${ellipsis}` : "";
    }

    if (!drawValue) {
      return;
    }

    const underlineWidth = Math.min(
      regular.widthOfTextAtSize(drawValue, valueFontSize),
      maxValueWidth
    );

    // Draw underline lower and thinner so it will not cross the text.
    hline(
      pg,
      valueX,
      textY - 3.5,
      valueX + underlineWidth,
      0.15,
      black
    );

    pg.drawText(drawValue, {
      x: valueX,
      y: textY,
      size: valueFontSize,
      font: regular,
      color: black,
    });
  };

  const wrapPdfCellText = (text: string, font: any, size: number, maxWidth: number): string[] => {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (!current || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  const drawPdfCellText = (
    pg: any,
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
    options: {
      font?: any;
      size?: number;
      minSize?: number;
      bold?: boolean;
      align?: "left" | "center" | "right";
      maxLines?: number;
      color?: any;
    } = {}
  ) => {
    const font = options.font || (options.bold ? bold : regular);
    const align = options.align || "center";
    const paddingX = 2;
    const paddingY = 0.6;
    const maxWidth = Math.max(1, width - paddingX * 2);
    const maxLines = options.maxLines || 1;
    let size = options.size || 5.2;
    const minSize = options.minSize || 3.8;

    const safeText = String(text || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!safeText) {
      return;
    }

    let lines = wrapPdfCellText(safeText, font, size, maxWidth);

    while (
      size > minSize &&
      (lines.length > maxLines || lines.some((line) => font.widthOfTextAtSize(line, size) > maxWidth))
    ) {
      size = Math.max(minSize, size - 0.2);
      lines = wrapPdfCellText(safeText, font, size, maxWidth);
    }

    const lineWasDropped = lines.length > maxLines;
    let visibleLines = lines.slice(0, maxLines);

    if (visibleLines.length > maxLines) {
      visibleLines = visibleLines.slice(0, maxLines);
    }

    if (
      visibleLines.length === 1 &&
      (lineWasDropped || font.widthOfTextAtSize(visibleLines[0], size) > maxWidth)
    ) {
      let trimmed = visibleLines[0];
      const ellipsis = "...";

      while (
        trimmed.length > 0 &&
        font.widthOfTextAtSize(`${trimmed}${ellipsis}`, size) > maxWidth
      ) {
        trimmed = trimmed.slice(0, -1);
      }

      visibleLines = [trimmed ? `${trimmed}${ellipsis}` : ""];
    }

    const lineHeight = Math.min(
      size + 0.8,
      Math.max(size, (height - paddingY * 2) / Math.max(1, visibleLines.length))
    );
    const textHeight = visibleLines.length * lineHeight;
    const firstBaseline = y + Math.max(paddingY, (height - textHeight) / 2) + textHeight - size;

    visibleLines.forEach((line, index) => {
      const textWidth = font.widthOfTextAtSize(line, size);
      const drawX = align === "right"
        ? x + width - textWidth - paddingX
        : align === "left"
          ? x + paddingX
          : x + Math.max(0, (width - textWidth) / 2);
      pg.drawText(line, {
        x: drawX,
        y: firstBaseline - index * lineHeight,
        size,
        font,
        color: options.color || black,
      });
    });
  };

  // ── logo from template XLSX ───────────────────────────────────────────────
  let logo: any = null;
  try {
    const tplBytes = await fs.promises.readFile(
      getLiquidationReferenceExcelPath()
    );
    const logoBytes = extractZipEntryBuffer(tplBytes, "xl/media/image1.jpg");
    if (logoBytes?.length) logo = await pdf.embedJpg(logoBytes);
  } catch { /* logo is optional */ }

  // ── totals computation ────────────────────────────────────────────────────
  const colTotals = calculateLiquidationTotals(payload.items, payload.cashAdvance);
  const totalExpenses = colTotals.totalExpenses;
  const cashAdvance   = colTotals.cashAdvance;
  const settlement    = colTotals.settlement;

  const phpFmt = (n: number) =>
    n === 0 ? "-" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── page-1 header ─────────────────────────────────────────────────────────
  const drawFirstPageHeader = (pg: any): number => {
    const topY = PAGE_H - 18;

    // Logo + company name — center the combined unit on the page
    const companyName = "LIFEBANK FOUNDATION, INC.";
    const tagline     = '"we excel, we care, we share"';
    if (logo) {
      const lh    = 44;
      const lw    = lh * (logo.width / logo.height);
      const nameW = bold.widthOfTextAtSize(companyName, 10);
      const gap   = 8;
      const logoX = Math.max(ML, (PAGE_W - lw - gap - nameW) / 2);
      pg.drawImage(logo, { x: logoX, y: topY - lh + 4, width: lw, height: lh });
      const tx = logoX + lw + gap;
      pg.drawText(companyName, { x: tx, y: topY - 14, size: 10, font: bold,   color: black });
      pg.drawText(tagline,     { x: tx, y: topY - 27, size:  7, font: italic, color: muted });
    } else {
      ctrText(pg, companyName, topY - 14, 10, bold);
      ctrText(pg, tagline,     topY - 27,  7, italic, muted);
    }

    hline(pg, ML, topY - 36, MR, 0.8, black);

    // Form title
    const titleY = topY - 51;
    ctrText(pg, "TRAVEL EXPENSE REPORT", titleY, 12, bold);
    const tw  = bold.widthOfTextAtSize("TRAVEL EXPENSE REPORT", 12);
    const tx0 = (PAGE_W - tw) / 2;
    hline(pg, tx0, titleY - 2, tx0 + tw, 0.8, black);

    // Header fields: label and value on the same line.
    // Stronger spacing fix: moves the whole header lower and adds more row gap.
    const mid = ML + (MR - ML) * 0.52;

    const f1y = titleY - 34;

    drawField(pg, "Name", payload.employeeName, ML, f1y, mid - 10);
    drawField(pg, "Date", payload.reportDate, mid + 3, f1y, MR);

    const f2y = f1y - 22;

    drawField(pg, "Designation", payload.designation, ML, f2y, mid - 10);
    drawField(pg, "Base", payload.base, mid + 3, f2y, MR);

    const f3y = f2y - 22;

    drawField(pg, "Purpose", payload.purpose, ML, f3y, MR);

    return f3y - 22; // y of top of table header
  };

  // ── table header (two rows) ───────────────────────────────────────────────
  const drawTableHeader = (pg: any, topEdge: number): number => {
    const row2Top = topEdge - HDR1_H;
    const dataTop = row2Top - HDR2_H;

    const mealsStartX = ML + COLS.slice(0, 7).reduce((s, c) => s + c.width, 0);
    const mealsW      = COLS.filter(c => c.meals).reduce((s, c) => s + c.width, 0);

    let cx = ML;
    COLS.forEach((col) => {
      if (col.meals) {
        rect(pg, cx, dataTop, col.width, HDR2_H, { color: hdrBg });
        drawPdfCellText(pg, col.label, cx, dataTop, col.width, HDR2_H, { font: bold, size: 5.5, maxLines: 1 });
      } else {
        rect(pg, cx, dataTop, col.width, HDR1_H + HDR2_H, { color: hdrBg });
        drawPdfCellText(pg, col.label, cx, dataTop, col.width, HDR1_H + HDR2_H, { font: bold, size: 4.8, minSize: 3.6, maxLines: 2 });
      }
      cx += col.width;
    });

    // "MEALS" spanning row 1 over B / L / D
    rect(pg, mealsStartX, row2Top, mealsW, HDR1_H, { color: hdrBg });
    const mlw = bold.widthOfTextAtSize("MEALS", 5.5);
    pg.drawText("MEALS", { x: mealsStartX + (mealsW - mlw) / 2, y: row2Top + 4.5, size: 5.5, font: bold, color: black });

    return dataTop;
  };

  // ── data row ─────────────────────────────────────────────────────────────
  const numericKeys = new Set(["amount", "perDiem", "breakfast", "lunch", "dinner", "others"]);

  const drawRow = (pg: any, topY: number, item: LiquidationRecord | null): number => {
    let cx = ML;
    COLS.forEach((col) => {
      rect(pg, cx, topY - ROW_H, col.width, ROW_H, { borderWidth: 0.4 });
      if (item) {
        const raw = (item as any)[col.key];
        if (raw !== undefined && raw !== null && raw !== "") {
          const val = String(raw);
          if (numericKeys.has(col.key)) {
            const n = parseCurrencyNumber(raw);
            const txt = n === 0 ? "" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            if (txt) drawPdfCellText(pg, txt, cx, topY - ROW_H, col.width, ROW_H, { align: "center", maxLines: 1, size: 5.2, minSize: 3.8 });
          } else if (col.key === "remarks") {
            drawPdfCellText(pg, val, cx, topY - ROW_H, col.width, ROW_H, { align: "center", maxLines: 1, size: 5.0, minSize: 3.5 });
          } else {
            drawPdfCellText(pg, val, cx, topY - ROW_H, col.width, ROW_H, { align: "center", maxLines: 1, size: 5.2, minSize: 3.8 });
          }
        }
      }
      cx += col.width;
    });
    return topY - ROW_H;
  };

  // ── totals row (row-57 equivalent, shaded) — always shows 0.00 for numeric cols ─
  const drawTotalsRow = (pg: any, topY: number): number => {
    let cx = ML;
    COLS.forEach((col) => {
      rect(pg, cx, topY - ROW_H, col.width, ROW_H, { color: hdrBg, borderWidth: 0.5 });
      if (numericKeys.has(col.key)) {
        const v   = (colTotals as any)[col.key] as number;
        const txt = v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        drawPdfCellText(pg, txt, cx, topY - ROW_H, col.width, ROW_H, { font: bold, size: 5.3, minSize: 3.4, maxLines: 1 });
      }
      cx += col.width;
    });
    return topY - ROW_H;
  };

  // ── bottom section: PHP-amounts table + signatures + footer ──────────────
  const drawBottomSection = (pg: any, afterY: number) => {
    // ── PHP amounts table (right-aligned, columns J–L equivalent) ──
    const tblW   = 200;
    const tblX   = MR - tblW;
    const lblW   = 115;
    const phpW   = 30;
    const amtW   = tblW - lblW - phpW; // 55

    const phpRows: [string, string][] = [
      ["Total Expenses",                                           phpFmt(totalExpenses)],
      ["Total CA",                                                 phpFmt(cashAdvance)],
      [settlement >= 0 ? "Return to CO" : "Reimbursement",        phpFmt(Math.abs(settlement))],
    ];

    phpRows.forEach(([lbl, amt], i) => {
      const ry = afterY - 4 - i * ROW_H;
      rect(pg, tblX,          ry - ROW_H, lblW, ROW_H, { color: hdrBg });
      rect(pg, tblX + lblW,   ry - ROW_H, phpW, ROW_H, { color: hdrBg });
      rect(pg, tblX + lblW + phpW, ry - ROW_H, amtW, ROW_H);
      drawPdfCellText(pg, lbl, tblX, ry - ROW_H, lblW, ROW_H, { font: bold, size: 5.5, minSize: 3.6, align: "right", maxLines: 1 });
      drawPdfCellText(pg, "PHP", tblX + lblW, ry - ROW_H, phpW, ROW_H, { font: bold, size: 5.5, minSize: 3.6, maxLines: 1 });
      drawPdfCellText(pg, amt, tblX + lblW + phpW, ry - ROW_H, amtW, ROW_H, { font: bold, size: 5.5, minSize: 3.6, align: "right", maxLines: 1 });
    });
    pg.drawRectangle({
      x: tblX,
      y: afterY - 4 - 3 * ROW_H,
      width: tblW,
      height: 3 * ROW_H,
      borderColor: black,
      borderWidth: 1.2,
    });

    // ── signature blocks ──────────────────────────────────────────────────
    const sigW  = TABLE_W / 5;
    const sigsBlocks: [string, string, string][] = [
      ["Prepared By:",  payload.preparedByName,  payload.preparedByTitle],
      ["Checked By:",   payload.checkedByName,   payload.checkedByTitle],
      ["Checked By:",   payload.reviewedByName,  payload.reviewedByTitle],
      ["Noted By:",     payload.notedByName,     payload.notedByTitle],
      ["Approved By:",  payload.approvedByName,  payload.approvedByTitle],
    ];

    // Signature section starts below the PHP table
    const sigsTop = afterY - 4 - 3 * ROW_H - 10; // 10 px gap after PHP table

    sigsBlocks.forEach(([lbl, name, title], i) => {
      const sx = ML + i * sigW;
      // Label
      pg.drawText(lbl, { x: sx, y: sigsTop, size: 5.5, font: bold, color: black });
      // Signature underline (space for wet signature)
      hline(pg, sx, sigsTop - 16, sx + sigW - 6, 0.6, black);
      // Name below the line
      drawPdfText(pg, name,  sx, sigsTop - 25, { font: bold,    size: 5.5, maxWidth: sigW - 4, lineHeight: 6.2 });
      // Title below name
      drawPdfText(pg, title, sx, sigsTop - 35, { font: regular, size: 4.8, maxWidth: sigW - 4, lineHeight: 5.4 });
    });

    // ── footer ────────────────────────────────────────────────────────────
    hline(pg, ML, 30, MR, 0.4, muted);
    const footerTxt = "(033) 333 3951 to 53  •  Fax (033) 336 1527  •  Gov. Fermin, Caram St., Brgy. Ma. Clara, Iloilo City, 5000 Philippines  •  support@lbfinc.org";
    const ftw = regular.widthOfTextAtSize(footerTxt, 4.8);
    pg.drawText(footerTxt, { x: (PAGE_W - ftw) / 2, y: 20, size: 4.8, font: regular, color: muted });
  };

  // ── pagination ────────────────────────────────────────────────────────────
  const totalRowsNeeded = Math.max(payload.items.length, MIN_ROWS);

  let pg             = pdf.addPage([PAGE_W, PAGE_H]);
  let pageTableTopY  = drawFirstPageHeader(pg);
  let rowTop         = drawTableHeader(pg, pageTableTopY);

  const rowsPerPage1 = Math.floor((rowTop - BOTTOM_RESERVE) / ROW_H);
  const contTableTop = PAGE_H - 28;
  const rowsPerPageN = Math.floor((contTableTop - HDR1_H - HDR2_H - BOTTOM_RESERVE) / ROW_H);

  let rendered        = 0;
  let capacityThisPage = rowsPerPage1;

  while (rendered < totalRowsNeeded) {
    const item = rendered < payload.items.length ? payload.items[rendered] : null;
    rowTop = drawRow(pg, rowTop, item);
    rendered += 1;

    if (rendered < totalRowsNeeded && rendered >= capacityThisPage) {
      // Thick outer border for this page's table section before moving on
      pg.drawRectangle({ x: ML, y: rowTop, width: TABLE_W,
                         height: pageTableTopY - rowTop, borderColor: black, borderWidth: 1.5 });

      pg = pdf.addPage([PAGE_W, PAGE_H]);
      pg.drawText("TRAVEL EXPENSE REPORT (continued)", {
        x: ML, y: PAGE_H - 20, size: 7, font: bold, color: muted,
      });
      pageTableTopY = contTableTop;
      rowTop        = drawTableHeader(pg, pageTableTopY);
      capacityThisPage += rowsPerPageN;
    }
  }

  // Totals row (row 57 equivalent) drawn after all data/empty rows
  rowTop = drawTotalsRow(pg, rowTop);

  // Thick outer border frames the entire table (header + data + totals row)
  pg.drawRectangle({ x: ML, y: rowTop, width: TABLE_W,
                     height: pageTableTopY - rowTop, borderColor: black, borderWidth: 1.5 });

  drawBottomSection(pg, rowTop);

  return Buffer.from(await pdf.save());
}

async function generateLiquidationExport(
  payload: LiquidationFormPayload,
  format: LiquidationExportFormat
): Promise<{ buffer: Buffer; contentType: string; extension: LiquidationExportFormat }> {
  if (format === "xlsx") {
    return {
      buffer: generateLiquidationExcelExport(payload),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: "xlsx",
    };
  }

  if (process.platform !== "win32") {
    return {
      buffer: await generateLiquidationReferencePdfExport(payload),
      contentType: "application/pdf",
      extension: "pdf",
    };
  }

  console.info("[liquidation-export] Using Windows Excel PDF exporter");

  const exportScriptPath = path.join(process.cwd(), "tools", "export-excel-to-pdf.ps1");
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "liq-export-"));
  const excelPath = path.join(tempDirectory, "liquidation-form.xlsx");
  const outputPath = path.join(tempDirectory, "liquidation-form.pdf");

  try {
    await fs.promises.writeFile(excelPath, generateLiquidationExcelExport(payload));
    console.info("[liquidation-export] Excel source generated");

    await runPowerShellScript(exportScriptPath, [
      "-InputPath", excelPath,
      "-OutputPath", outputPath,
      "-WorksheetName", "Liquidation TAR ",
      "-PrintArea", "$A$1:$L$74",
    ]);

    console.info("[liquidation-export] PDF export completed");

    return {
      buffer: await fs.promises.readFile(outputPath),
      contentType: "application/pdf",
      extension: "pdf",
    };
  } finally {
    await fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function extractSourceRecords(ai: GoogleGenAI, source: CompareSourceFile): Promise<ExtractedCompareRecord[]> {
  const prompt = `
You extract equipment accountability records from a digital accountability form (PDF or Excel).

CRITICAL RULES:
1. Scan the ENTIRE document carefully. Return ONE JSON object per row/equipment item — include every row, even if some fields are empty.
2. Copy field values EXACTLY as printed — do NOT modify, correct, abbreviate, or reformat.
3. hardwareId = the internal company asset/property tag (format: PREFIX-YEAR-CODE, e.g., CPU-2025-AB1, MTR-2024-XY, MON-2025-001). This is NOT the manufacturer serial number.
4. serial = the manufacturer's serial number. Usually labeled "Serial No.", "S/N", or "SN" in the document. This is NOT the asset tag.
5. NEVER put the same value in both hardwareId and serial unless the document explicitly shows that value in BOTH columns.
6. If a cell is blank, return an empty string — do not guess or fill in values.
7. sn = the row number as shown in the left-most column of the table (1, 2, 3…).
8. components = the equipment type in ALL CAPS exactly as written (e.g., SYSTEM UNIT, MONITOR, KEYBOARD, PRINTER, MOUSE, LAPTOP, UPS, SCANNER, WEBCAM, CPU ADAPTER, LAPTOP ADAPTER).
9. Return ONLY valid JSON — no explanations, no markdown, no extra text.

Field definitions:
- sn: row/sequence number from the document table
- district: geographic or organizational district if listed, else empty
- branch: branch or office name if listed, else empty
- components: equipment type EXACTLY as written in the document (UPPERCASE)
- description: brand and model exactly as written (e.g., DELL OPTIPLEX 7090, HP LaserJet Pro M404N)
- hardwareId: internal company property/asset tag code
- serial: manufacturer serial number from the document
- remarks: condition, status, or notes column value
`.trim();

  const parsed = await callGeminiForStructuredOutput<any[]>(
    ai,
    [{ text: prompt }, ...buildSourceParts("Source 1", [source])],
    {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sn: { type: Type.STRING },
          district: { type: Type.STRING },
          branch: { type: Type.STRING },
          components: { type: Type.STRING },
          description: { type: Type.STRING },
          hardwareId: { type: Type.STRING },
          serial: { type: Type.STRING },
          remarks: { type: Type.STRING },
          notes: { type: Type.STRING },
        },
        required: ["sn", "district", "branch", "components", "description", "hardwareId", "serial", "remarks"],
      },
    }
  );

  return Array.isArray(parsed) ? parsed.map(normalizeExtractedRecord) : [];
}

async function extractObservedRecords(
  ai: GoogleGenAI,
  expectedRecords: ExtractedCompareRecord[],
  evidenceFiles: CompareSourceFile[]
): Promise<ExtractedCompareRecord[]> {
  const referenceRecords = expectedRecords.map(toReferenceRecordFromComparison);
  const imageEvidenceFiles = evidenceFiles.filter((file) => file.kind === "image");
  let locallyObservedRecords = expectedRecords.map(() => normalizeExtractedRecord(undefined));

  if (imageEvidenceFiles.length > 0) {
    try {
      const localExtraction = await extractIntakeRecordsResilient(imageEvidenceFiles, referenceRecords);
      locallyObservedRecords = mapObservedIntakeRecordsToExpected(expectedRecords, localExtraction.records);
    } catch (error) {
      console.warn("Local OCR comparison fallback failed:", error);
    }
  }

  const expectedSummary = expectedRecords
    .map((record, index) => {
      return [
        `Record ${index + 1}: ${record.components}`,
        `  Expected Description: ${record.description || '(not specified)'}`,
        `  Expected Hardware ID (Asset Tag): ${record.hardwareId || '(not specified)'}`,
        `  Expected Serial: ${record.serial || '(not specified)'}`,
        `  Expected SN: ${record.sn || '(not specified)'}`,
      ].join("\n");
    })
    .join("\n\n");

  const prompt = `
You are a document verification specialist. Inspect the provided evidence photos and extract the ACTUAL physical values visible for each expected equipment record below.

CRITICAL RULES:
1. Return EXACTLY one object per expected record, in the SAME ORDER as the list below.
2. For each expected record, search ALL provided images to find the matching equipment.
3. Copy ONLY values that are PHYSICALLY READABLE in the photos — never guess or infer.
4. If a field is not visible or unreadable in any image, return an EMPTY STRING for that field.

HOW TO READ EACH FIELD:
- components: Identify the equipment type from the device's shape, brand markings, or visible labels. Use UPPERCASE (SYSTEM UNIT, MONITOR, KEYBOARD, PRINTER, MOUSE, LAPTOP, UPS, SCANNER, WEBCAM, CPU ADAPTER, LAPTOP ADAPTER).
- description: Read the brand name and model number from the manufacturer's label (e.g., DELL OPTIPLEX 7090, ASUS NUC PRO, HP PROBOOK 450).
- hardwareId: Look for a company property sticker — usually a printed label with a code like CPU-2025-AB1, MTR-2024-XY, or similar PREFIX-YEAR-CODE format. This sticker is separate from the manufacturer label.
- serial: Read the manufacturer serial number from the factory/manufacturer label. It is labeled "S/N", "Serial No.", "Serial Number", or "SN". Read each character carefully.

SERIAL NUMBER ACCURACY — read character by character. Common OCR confusion pairs:
  0 vs O, 1 vs I vs L, 5 vs S, 8 vs B, 2 vs Z, 6 vs G, 7 vs T

IMPORTANT:
- NEVER put the hardware ID value into the serial field, or vice versa — they are always different.
- If you can see the device but cannot read a specific label, leave that field empty and explain in "notes".
- In "notes": describe what you actually see — device type found, label visibility, any differences from expected, or if no matching equipment was found.
- If the evidence shows a DIFFERENT device than expected, record what you actually see and note the discrepancy.

Expected records:
${expectedSummary}
`.trim();

  const parsed = await callGeminiForStructuredOutput<any[]>(
    ai,
    [{ text: prompt }, ...buildSourceParts("Evidence", evidenceFiles)],
    {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sn: { type: Type.STRING },
          district: { type: Type.STRING },
          branch: { type: Type.STRING },
          components: { type: Type.STRING },
          description: { type: Type.STRING },
          hardwareId: { type: Type.STRING },
          serial: { type: Type.STRING },
          remarks: { type: Type.STRING },
          notes: { type: Type.STRING },
        },
        required: ["sn", "district", "branch", "components", "description", "hardwareId", "serial", "remarks"],
      },
    }
  );

  const extracted = Array.isArray(parsed) ? parsed.map(normalizeExtractedRecord) : [];

  return expectedRecords.map((expected, index) => {
    const observed = mergeObservedComparisonRecord(locallyObservedRecords[index], extracted[index]);
    if (!observed) {
      return {
        ...normalizeRecord({ components: expected.components, description: expected.description }),
        notes: "No matching evidence was extracted for this record. The item may not be present in the evidence or was not clearly visible for extraction.",
      };
    }

    return {
      ...observed,
      components: observed.components || expected.components,
      description: observed.description || expected.description,
    };
  });
}

function normalizeGeneral(value: string): string {
  return value
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/[.,/#!$%^&*;:{}=_`~()]/g, "")
    .trim();
}

function normalizeIdentifier(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeOcrIdentifier(value: string): string {
  return normalizeIdentifier(value)
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8")
    .replace(/Z/g, "2")  // Z ↔ 2 is a common OCR confusion
    .replace(/G/g, "6")  // G ↔ 6 on worn or small labels
    .replace(/T/g, "7"); // T ↔ 7 in compressed fonts
}

function getComparisonFieldLabel(field: ComparisonField): string {
  const labels: Record<ComparisonField, string> = {
    components: "Component",
    description: "Description",
    hardwareId: "Hardware ID",
    serial: "Serial",
  };

  return labels[field];
}

function normalizeComponentForComparison(value: string): string {
  const condensed = normalizeGeneral(value)
    .replace(/\bADAPTOR\b/g, "ADAPTER")       // normalise British/local spelling
    .replace(/\bDESKTOP COMPUTER\b/g, "SYSTEM UNIT")
    .replace(/\bCPU\b/g, "SYSTEM UNIT")
    .replace(/\s+/g, "");

  const aliases: Record<string, string> = {
    // System unit variants
    SYSTEMUNIT: "SYSTEMUNIT",
    DESKTOP: "SYSTEMUNIT",
    THINCLIENT: "SYSTEMUNIT",
    MINIPC: "SYSTEMUNIT",
    OPTIPLEX: "SYSTEMUNIT",
    ELITEDESK: "SYSTEMUNIT",
    // Monitor variants
    MONITOR: "MONITOR",
    DISPLAY: "MONITOR",
    LCD: "MONITOR",
    LEDMONITOR: "MONITOR",
    // Printer variants
    PRINTER: "PRINTER",
    LASERJET: "PRINTER",
    INKJET: "PRINTER",
    MULTIFUNCTION: "PRINTER",
    MFP: "PRINTER",
    // Laptop variants
    LAPTOP: "LAPTOP",
    NOTEBOOK: "LAPTOP",
    THINKPAD: "LAPTOP",
    ELITEBOOK: "LAPTOP",
    PAVILION: "LAPTOP",
    INSPIRON: "LAPTOP",
    // Input devices
    KEYBOARD: "KEYBOARD",
    MOUSE: "MOUSE",
    // Power
    UPS: "UPS",
    // Adapter variants — both CPU and Laptop normalize to CPUADAPTER for
    // comparison purposes (they are separate fields on forms but compare alike)
    CPUADAPTER: "CPUADAPTER",
    CPUADAPTOR: "CPUADAPTER",
    CPADAPTER: "CPUADAPTER",
    POWERADAPTER: "CPUADAPTER",
    ADAPTER: "CPUADAPTER",
    LAPTOPADADAPTER: "LAPTOPADAPTER",
    LAPTOPADAPTER: "LAPTOPADAPTER",
    LAPTOPADAPTOR: "LAPTOPADAPTER",
    // Webcam
    WEBCAM: "WEBCAM",
    CAMERA: "WEBCAM",
    // Scanner
    SCANNER: "SCANNER",
    SCANSNAP: "SCANNER",
    DOCUMENTSCANNER: "SCANNER",
    // Network
    ROUTER: "ROUTER",
    SWITCH: "SWITCH",
    NETWORKSWITCH: "SWITCH",
  };

  return aliases[condensed] || condensed;
}

function getDescriptionComparisonTokens(value: string): string[] {
  const stopWords = new Set([
    "MONITOR",
    "DISPLAY",
    "PRINTER",
    "KEYBOARD",
    "MOUSE",
    "SYSTEM",
    "UNIT",
    "UPS",
    "ADAPTER",
    "WEBCAM",
    "SCANNER",
    "ROUTER",
    "SWITCH",
    "DEVICE",
    "MODEL",
    "SERIES",
  ]);

  return dedupePreserveOrder(
    normalizeGeneral(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !stopWords.has(token))
  );
}

function descriptionsSubstantivelyMatch(expectedValue: string, observedValue: string): boolean {
  const expectedTokens = getDescriptionComparisonTokens(expectedValue);
  const observedTokens = getDescriptionComparisonTokens(observedValue);

  if (expectedTokens.length === 0 || observedTokens.length === 0) {
    return false;
  }

  const expectedSet = new Set(expectedTokens);
  const observedSet = new Set(observedTokens);
  const overlap = expectedTokens.filter((token) => observedSet.has(token));
  const smallerCount = Math.min(expectedSet.size, observedSet.size);

  if (smallerCount === 0) {
    return false;
  }

  const smallerHasModelLikeToken = [...expectedSet, ...observedSet].some((token) => /\d/.test(token));

  return overlap.length === smallerCount && (smallerCount >= 2 || smallerHasModelLikeToken);
}

function getMismatchReason(field: ComparisonField): string {
  switch (field) {
    case "serial":
      return "Verify the S/N label on the physical device matches the accountability form.";
    case "hardwareId":
      return "Check the property sticker on the equipment matches the asset tag in the form.";
    case "components":
      return "The equipment type recorded in the document differs from what is visible in the evidence photo. Verify the correct item was photographed.";
    case "description":
      return "The brand/model in the document differs from what is readable in the evidence photo.";
  }
}

function compareField(field: ComparisonField, expectedValue: string, observedValue: string): { matches: boolean; note?: string } {
  const expected = expectedValue || "";
  const observed = observedValue || "";
  const label = getComparisonFieldLabel(field);

  // Both empty = match
  if (!expected && !observed) {
    return { matches: true };
  }

  // One is empty, one has value = mismatch
  if (!expected || !observed) {
    if (!expected && observed) {
      return {
        matches: false,
        note: `${label} "${observed}" was found in the evidence but is NOT recorded in the document. This item may be unregistered or was added after the form was filed.`,
      };
    }
    if (expected && !observed) {
      return {
        matches: false,
        note: `${label} "${expected}" is in the document but was NOT found in the evidence. The item may be missing from the photos, the label is not visible, or the equipment is absent.`,
      };
    }
  }

  // Both have values - compare them
  const isIdentifierField = field === "hardwareId" || field === "serial";
  const normalizedExpected = isIdentifierField
    ? normalizeIdentifier(expected)
    : field === "components"
      ? normalizeComponentForComparison(expected)
      : normalizeGeneral(expected);
  const normalizedObserved = isIdentifierField
    ? normalizeIdentifier(observed)
    : field === "components"
      ? normalizeComponentForComparison(observed)
      : normalizeGeneral(observed);

  if (normalizedExpected === normalizedObserved) {
    return { matches: true };
  }

  if (field === "description" && descriptionsSubstantivelyMatch(expected, observed)) {
    return { matches: true };
  }

  // Check for common OCR errors in identifiers
  if (isIdentifierField && normalizeOcrIdentifier(expected) === normalizeOcrIdentifier(observed)) {
    return {
      matches: false,
      note: `${label} likely has an OCR scan error — document: "${expected}", evidence: "${observed}". Characters that are commonly confused: 0/O, 1/I/L, 5/S, 8/B. Please verify the physical label manually.`,
    };
  }

  // Check for partial match or similar values
  if (normalizedExpected && normalizedObserved) {
    const similarity = calculateSimilarity(normalizedExpected, normalizedObserved);
    if (similarity > 0.8) {
      return {
        matches: false,
        note: `${label} is close but does not match exactly — document: "${expected}", evidence: "${observed}". ${getMismatchReason(field)}`,
      };
    }
  }

  // Complete mismatch
  return {
    matches: false,
    note: `${label} does not match — document: "${expected}", evidence: "${observed}". ${getMismatchReason(field)}`,
  };
}

function calculateSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(s1: string, s2: string): number {
  const costs: number[] = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

function toReferenceRecordFromComparison(record: ExtractedCompareRecord): ReferenceRecord {
  return {
    sourceName: "",
    components: record.components || "",
    description: record.description || "",
    hardwareId: record.hardwareId || "",
    serial: record.serial || "",
    remarks: record.remarks || "",
    notes: record.notes || "",
  };
}

function toExtractedCompareRecordFromIntake(record: IntakeRecord): ExtractedCompareRecord {
  return {
    sn: "",
    district: "",
    branch: "",
    components: record.components || "",
    description: record.description || "",
    hardwareId: record.hardwareId || "",
    serial: record.serial || "",
    remarks: record.remarks || "",
    notes: record.notes || "",
  };
}

function mergeObservedComparisonRecord(
  primary: ExtractedCompareRecord | undefined,
  fallback: ExtractedCompareRecord | undefined
): ExtractedCompareRecord {
  const base = normalizeExtractedRecord(primary);
  const backup = normalizeExtractedRecord(fallback);

  return {
    sn: base.sn || backup.sn,
    district: base.district || backup.district,
    branch: base.branch || backup.branch,
    components: base.components || backup.components,
    description: chooseBestDescription(base.description, backup.description),
    hardwareId: base.hardwareId || backup.hardwareId,
    serial: base.serial || backup.serial,
    remarks: base.remarks || backup.remarks,
    notes: combineExtractionNotes(base.notes, backup.notes),
  };
}

function mapObservedIntakeRecordsToExpected(
  expectedRecords: ExtractedCompareRecord[],
  observedRecords: IntakeRecord[]
): ExtractedCompareRecord[] {
  const expectedReferences = expectedRecords.map(toReferenceRecordFromComparison);
  const pairings = observedRecords.flatMap((record, observedIndex) =>
    expectedReferences.map((reference, expectedIndex) => ({
      observedIndex,
      expectedIndex,
      score: scoreReferenceMatch(record, reference),
    }))
  )
    .filter((pairing) => pairing.score >= 25)
    .sort((left, right) => right.score - left.score);

  const usedObserved = new Set<number>();
  const usedExpected = new Set<number>();
  const mapped = expectedRecords.map(() => normalizeExtractedRecord(undefined));

  for (const pairing of pairings) {
    if (usedObserved.has(pairing.observedIndex) || usedExpected.has(pairing.expectedIndex)) {
      continue;
    }

    usedObserved.add(pairing.observedIndex);
    usedExpected.add(pairing.expectedIndex);
    mapped[pairing.expectedIndex] = toExtractedCompareRecordFromIntake(observedRecords[pairing.observedIndex]);
  }

  return mapped;
}

function compareExtractedRecords(
  expectedRecords: ExtractedCompareRecord[],
  observedRecords: ExtractedCompareRecord[]
): CompareResult[] {
  const criticalFields: ComparisonField[] = ["components", "description", "hardwareId", "serial"];

  return expectedRecords.map((expected, index) => {
    const observed = normalizeExtractedRecord(observedRecords[index]);
    const mismatchedFields: string[] = [];
    const fieldNotes: Partial<Record<ComparisonField, string>> = {};

    const visibleObservedCritical = criticalFields.filter((field) => Boolean((observed[field] || "").trim()));
    const statusBase = visibleObservedCritical.length === 0 ? "missing" : "match";

    for (const field of criticalFields) {
      const comparison = compareField(field, expected[field], observed[field]);
      if (!comparison.matches) {
        mismatchedFields.push(field);
        if (comparison.note) {
          fieldNotes[field] = comparison.note;
        }
      }
    }

    const expectedHardwareId = normalizeIdentifier(expected.hardwareId || "");
    const expectedSerial = normalizeIdentifier(expected.serial || "");
    const observedHardwareId = normalizeIdentifier(observed.hardwareId || "");
    const observedSerial = normalizeIdentifier(observed.serial || "");

    if (
      expectedHardwareId
      && expectedHardwareId === observedSerial
      && expectedHardwareId !== observedHardwareId
      && !fieldNotes.hardwareId
    ) {
      fieldNotes.hardwareId = "Hardware ID appears to have been read into the evidence Serial field instead of the Hardware ID field.";
      if (!mismatchedFields.includes("hardwareId")) {
        mismatchedFields.push("hardwareId");
      }
    }

    if (
      expectedSerial
      && expectedSerial === observedHardwareId
      && expectedSerial !== observedSerial
      && !fieldNotes.serial
    ) {
      fieldNotes.serial = "Serial appears to have been read into the evidence Hardware ID field instead of the Serial field.";
      if (!mismatchedFields.includes("serial")) {
        mismatchedFields.push("serial");
      }
    }

    const finalStatus = statusBase === "missing" ? "missing" : mismatchedFields.length > 0 ? "mismatch" : "match";

    // Build per-field notes, always with a fallback reason for each mismatch field
    const fieldNoteLines = mismatchedFields.map((field) => {
      const existing = fieldNotes[field as ComparisonField];
      if (existing) return existing;
      const label = getComparisonFieldLabel(field as ComparisonField);
      return `${label} value could not be confirmed from the evidence — manual verification required.`;
    });

    const finalNotes = [
      ...fieldNoteLines,
      finalStatus === "missing"
        ? (observed.notes || "No evidence values were extracted for this record. The equipment may not have been photographed or the image is unclear.")
        : (finalStatus === "mismatch" && observed.notes ? `Evidence note: ${observed.notes}` : ""),
    ]
      .filter(Boolean)
      .join(" | ");

    return {
      doc: normalizeRecord(expected),
      img: normalizeRecord(observed),
      status: finalStatus,
      mismatchedFields,
      fieldNotes,
      notes: finalStatus === "match" ? undefined : (finalNotes || undefined),
    };
  });
}

async function runGeminiComparison(source1: CompareSourceFile, source2: CompareSourceFile[]): Promise<CompareResult[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const extractedReferenceRecords = extractReferenceRecords(source1).map((record) => ({
    sn: "",
    district: "",
    branch: "",
    components: record.components,
    description: record.description,
    hardwareId: record.hardwareId,
    serial: record.serial,
    remarks: record.remarks,
    notes: record.notes,
  }));
  const expectedRecords = extractedReferenceRecords.length > 0
    ? extractedReferenceRecords.map(normalizeExtractedRecord)
    : await extractSourceRecords(ai, source1);

  if (expectedRecords.length === 0) {
    throw new Error("No structured records were extracted from the source PDF/document.");
  }

  const observedRecords = await extractObservedRecords(ai, expectedRecords, source2);
  return compareExtractedRecords(expectedRecords, observedRecords);
}

async function extractIntakeRecordsWithGemini(evidenceFiles: CompareSourceFile[]): Promise<IntakeRecord[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
You extract equipment accountability details from field-capture photos of physical devices.

Rules:
1. Return exactly one object per image, in the same order as the uploaded images.
2. sourceName must exactly match the uploaded filename for that image.
3. components: identify the equipment type from the device shape, brand label, or visible text. Use UPPERCASE. Choose from: SYSTEM UNIT, MONITOR, PRINTER, KEYBOARD, MOUSE, UPS, CPU ADAPTER, LAPTOP ADAPTER, LAPTOP, SCANNER, WEBCAM, ROUTER, SWITCH.
4. description: read the brand name and model number from the MANUFACTURER label on the device (e.g., DELL OPTIPLEX 3080, LENOVO THINKPAD E14, HP LASERJET PRO M404N, ASUS NUC PRO). Use the brand alone if model is unclear.
5. hardwareId: read the INTERNAL COMPANY PROPERTY TAG — a printed sticker with code format PREFIX-YEAR-CODE (e.g., CPU-2024-AB1, MTR-2025-XY1). Prefixes: CPU, MTR, MON, KBD, MSE, SCN, PTR, UPS, CAD, LAD, LTP, PRN. This tag is SEPARATE from the manufacturer label. NEVER use the manufacturer serial number as hardwareId.
6. serial: read the MANUFACTURER SERIAL NUMBER from the factory label. It is labeled "Serial Number", "Serial No.", "S/N", "SN", or "SNID". Read each character carefully:
   - Common confusions: 0 vs O, 1 vs I vs L, 5 vs S, 8 vs B, 2 vs Z — pick the correct character based on context.
   - NEVER copy the hardwareId into serial. They are always different values.
   - If "S/N" label is not visible, leave serial empty rather than guessing.
7. remarks: use "New Accountability" unless the image shows a different status.
8. notes: briefly describe any values that were unclear, unreadable, or missing. If no issues, leave empty.
9. Return JSON only. Never invent values — leave fields empty when genuinely unreadable.
`.trim();

  const parsed = await callGeminiForStructuredOutput<any[]>(
    ai,
    [{ text: prompt }, ...buildSourceParts("Evidence", evidenceFiles)],
    {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sourceName: { type: Type.STRING },
          components: { type: Type.STRING },
          description: { type: Type.STRING },
          hardwareId: { type: Type.STRING },
          serial: { type: Type.STRING },
          remarks: { type: Type.STRING },
          notes: { type: Type.STRING },
        },
        required: ["sourceName", "components", "description", "hardwareId", "serial", "remarks"],
      },
    }
  );

  const normalized = Array.isArray(parsed) ? parsed.map(normalizeIntakeRecord) : [];

  return evidenceFiles.map((file, index) => {
    const extracted = normalized[index];

    if (!extracted) {
      return {
        sourceName: file.name,
        components: "",
        description: "",
        hardwareId: "",
        serial: "",
        remarks: "New Accountability",
        notes: "No structured details were extracted from this image.",
      };
    }

    return {
      ...extracted,
      sourceName: extracted.sourceName || file.name,
      remarks: extracted.remarks || "New Accountability",
    };
  });
}

function combineExtractionNotes(...notes: Array<string | undefined>): string {
  return notes
    .map((note) => (note || "").trim())
    .filter(Boolean)
    .filter((note, index, allNotes) => allNotes.indexOf(note) === index)
    .join(" | ");
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}

async function extractLiquidationRecordWithGemini(evidenceFile: CompareSourceFile): Promise<LiquidationRecord> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const prompt = `
You extract one liquidation row from a photographed ticket or receipt.

Rules:
1. Return one JSON object only.
2. sourceName must match the uploaded filename.
3. amount must be the best single payable amount shown on the receipt or ticket.
4. Prefer values labeled TOTAL, AMOUNT, AMOUNT DUE, TOTAL DUE, FARE, or PAID.
5. If origin and destination are visible on the ticket, fill from and to. Otherwise return empty strings.
6. If transport mode is visible, fill modeOfTransportation. Otherwise return an empty string.
7. time should only be filled when a clear transaction or departure time is visible.
8. remarks should be a short label such as Receipt, Ticket, Van Fare, Bus Fare, Terminal Fee, or empty when uncertain.
9. notes should briefly explain uncertainty when amount is missing.
10. Return JSON only.
`.trim();

  const parsed = await callGeminiForStructuredOutput<Partial<LiquidationRecord>>(
    ai,
    [{ text: prompt }, ...buildSourceParts("Receipt", [evidenceFile])],
    {
      type: Type.OBJECT,
      properties: {
        sourceName: { type: Type.STRING },
        time: { type: Type.STRING },
        from: { type: Type.STRING },
        to: { type: Type.STRING },
        modeOfTransportation: { type: Type.STRING },
        amount: { type: Type.STRING },
        remarks: { type: Type.STRING },
        notes: { type: Type.STRING },
      },
      required: ["sourceName", "amount", "remarks"],
    }
  );

  const normalized = normalizeLiquidationRecord(parsed);
  return {
    ...buildManualLiquidationFallback(evidenceFile.name, ""),
    ...normalized,
    sourceName: normalized.sourceName || evidenceFile.name,
    amount: normalizeLiquidationAmount(normalized.amount),
    remarks: normalized.remarks || "Receipt/Ticket",
  };
}

async function extractLiquidationRecord(file: CompareSourceFile): Promise<LiquidationRecord> {
  let ocrNote = "";
  let ocrAmount = "";
  let ocrText = "";
  let ocrFrom = "";
  let ocrTo = "";
  let ocrRemarks = "Receipt/Ticket";
  let ocrMode = "";

  try {
    const snapshot = await recognizeOcrSnapshot(file, { mode: "full" });
    ocrText = snapshot.text;
    ocrAmount = extractBestLiquidationAmount(snapshot.text);
    const route = inferLiquidationRouteFromText(snapshot.text);
    ocrFrom = route.from;
    ocrTo = route.to;
    ocrRemarks = inferLiquidationRemarksFromText(snapshot.text);
    ocrMode = inferLiquidationTransportMode(snapshot.text);
    if (ocrAmount) {
      ocrNote = "Amount extracted from OCR.";
    } else if (snapshot.text.trim()) {
      ocrNote = "OCR could not confirm the payable amount. Gemini review was used.";
    } else {
      ocrNote = "No readable OCR text was found in this receipt image.";
    }
  } catch (error) {
    ocrNote = `OCR failed for this receipt: ${extractUpstreamErrorMessage(error)}`;
  }

  const baseRecord: LiquidationRecord = {
    ...buildManualLiquidationFallback(file.name, ocrNote),
    from: ocrFrom,
    to: ocrTo,
    modeOfTransportation: ocrMode,
    amount: ocrAmount,
    remarks: ocrRemarks,
  };

  if (ocrAmount && (ocrFrom || ocrTo || ocrMode || ocrRemarks !== "Receipt/Ticket")) {
    return baseRecord;
  }

  try {
    const geminiRecord = await extractLiquidationRecordWithGemini(file);
    return {
      ...baseRecord,
      ...geminiRecord,
      sourceName: geminiRecord.sourceName || file.name,
      from: geminiRecord.from || baseRecord.from,
      to: geminiRecord.to || baseRecord.to,
      modeOfTransportation: geminiRecord.modeOfTransportation || baseRecord.modeOfTransportation,
      amount: normalizeLiquidationAmount(geminiRecord.amount) || baseRecord.amount,
      remarks: geminiRecord.remarks || baseRecord.remarks,
      notes: combineExtractionNotes(
        baseRecord.notes,
        geminiRecord.notes || (ocrText ? "Receipt details refined with Gemini." : "Amount extracted with Gemini.")
      ),
    };
  } catch (error) {
    return {
      ...baseRecord,
      notes: combineExtractionNotes(
        baseRecord.notes,
        `Gemini fallback failed: ${extractUpstreamErrorMessage(error)}`
      ) || "The amount could not be extracted automatically from this receipt.",
    };
  }
}

async function extractLiquidationRecordsFromEvidence(
  evidenceFiles: CompareSourceFile[]
): Promise<LiquidationExtractionResponse> {
  const records = await mapWithConcurrency(evidenceFiles, localOcrParallelism, extractLiquidationRecord);
  const extracted = records.filter((record) => record.amount.trim().length > 0).length;
  const manual = records.length - extracted;

  return {
    records,
    summary: {
      requested: evidenceFiles.length,
      extracted,
      manual,
      usedFallback: records.some((record) => /Gemini/i.test(record.notes || "")),
      message: manual > 0
        ? `${manual} receipt${manual === 1 ? "" : "s"} still need a manual amount check.`
        : "All captured receipts were scanned and the amount field was filled automatically.",
    },
  };
}

function choosePreferredComponent(primary: string, fallback: string): string {
  if (!primary) {
    return fallback;
  }

  if (!fallback) {
    return primary;
  }

  const normalizedPrimary = normalizeGeneral(primary);
  const normalizedFallback = normalizeGeneral(fallback);
  if (normalizedPrimary === normalizedFallback) {
    return primary.length >= fallback.length ? primary : fallback;
  }

  return primary.length >= fallback.length ? primary : fallback;
}

function choosePreferredIdentifier(primary: string, fallback: string): string {
  if (!primary) {
    return fallback;
  }

  if (!fallback) {
    return primary;
  }

  const normalizedPrimary = normalizeIdentifier(primary);
  const normalizedFallback = normalizeIdentifier(fallback);
  if (normalizedPrimary === normalizedFallback) {
    return primary.length >= fallback.length ? primary : fallback;
  }

  return normalizedPrimary.length >= normalizedFallback.length ? primary : fallback;
}

function choosePreferredSerial(primary: string, fallback: string, hardwareId: string): string {
  const primaryLooksValid = isLikelySerialCandidate(primary, hardwareId);
  const fallbackLooksValid = isLikelySerialCandidate(fallback, hardwareId);

  if (primaryLooksValid && !fallbackLooksValid) {
    return primary;
  }

  if (fallbackLooksValid && !primaryLooksValid) {
    return fallback;
  }

  return choosePreferredIdentifier(primary, fallback);
}

function descriptionsRoughlyMatch(primary: string, candidate: string): boolean {
  const normalizedPrimary = normalizeGeneral(primary);
  const normalizedCandidate = normalizeGeneral(candidate);

  if (!normalizedPrimary || !normalizedCandidate) {
    return false;
  }

  if (normalizedPrimary === normalizedCandidate) {
    return true;
  }

  return normalizedPrimary.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedPrimary);
}

function canConsolidateIntakeRecords(primary: IntakeRecord, candidate: IntakeRecord): boolean {
  const primaryComponent = normalizeGeneral(primary.components);
  const candidateComponent = normalizeGeneral(candidate.components);
  const primaryHardware = normalizeIdentifier(primary.hardwareId);
  const candidateHardware = normalizeIdentifier(candidate.hardwareId);
  const primarySerial = normalizeIdentifier(primary.serial);
  const candidateSerial = normalizeIdentifier(candidate.serial);

  const sameComponent = Boolean(primaryComponent && candidateComponent && primaryComponent === candidateComponent);
  const compatibleComponents = sameComponent || !primaryComponent || !candidateComponent;
  const sameHardware = Boolean(primaryHardware && candidateHardware && primaryHardware === candidateHardware);
  const sameSerial = Boolean(primarySerial && candidateSerial && primarySerial === candidateSerial);

  if (sameComponent && (sameHardware || sameSerial)) {
    return true;
  }

  if (compatibleComponents && sameHardware && sameSerial) {
    return true;
  }

  if (
    sameComponent
    && descriptionsRoughlyMatch(primary.description, candidate.description)
    && (
      !primaryHardware
      || !candidateHardware
      || !primarySerial
      || !candidateSerial
    )
  ) {
    return true;
  }

  return false;
}

function mergeConsolidatedIntakeRecords(primary: IntakeRecord, candidate: IntakeRecord): IntakeRecord {
  const mergedHardwareId = choosePreferredIdentifier(primary.hardwareId, candidate.hardwareId);
  return {
    sourceName: primary.sourceName || candidate.sourceName,
    components: choosePreferredComponent(primary.components, candidate.components),
    description: chooseBestDescription(primary.description, candidate.description),
    hardwareId: mergedHardwareId,
    serial: choosePreferredSerial(primary.serial, candidate.serial, mergedHardwareId),
    remarks: primary.remarks || candidate.remarks || "New Accountability",
    notes: combineExtractionNotes(primary.notes, candidate.notes),
  };
}

function dedupeIntakeRecords(records: IntakeRecord[]): IntakeRecord[] {
  const consolidated: IntakeRecord[] = [];

  for (const rawRecord of records) {
    const record = normalizeIntakeRecord(rawRecord);
    const existingIndex = consolidated.findIndex((candidate) => canConsolidateIntakeRecords(candidate, record));

    if (existingIndex >= 0) {
      consolidated[existingIndex] = mergeConsolidatedIntakeRecords(consolidated[existingIndex], record);
      continue;
    }

    const duplicateIndex = consolidated.findIndex((candidate) => {
      return normalizeGeneral(candidate.components) === normalizeGeneral(record.components)
        && normalizeIdentifier(candidate.hardwareId) === normalizeIdentifier(record.hardwareId)
        && normalizeIdentifier(candidate.serial) === normalizeIdentifier(record.serial)
        && Boolean((record.components || record.hardwareId || record.serial).trim());
    });

    if (duplicateIndex >= 0) {
      consolidated[duplicateIndex] = mergeConsolidatedIntakeRecords(consolidated[duplicateIndex], record);
      continue;
    }

    consolidated.push(record);
  }

  return consolidated;
}

function mergeLocalAndAiIntakeRecord(fileName: string, localRecord: IntakeRecord, aiRecord: IntakeRecord): IntakeRecord {
  const mergedHardwareId = normalizeAssetTagCandidate(localRecord.hardwareId)
    || normalizeAssetTagCandidate(aiRecord.hardwareId)
    || localRecord.hardwareId
    || aiRecord.hardwareId;

  const mergedComponent = localRecord.components || aiRecord.components;
  const mergedDescription = chooseBestDescription(localRecord.description, aiRecord.description);
  const mergedSerial = isLikelySerialCandidate(localRecord.serial, mergedHardwareId)
    ? localRecord.serial
    : isLikelySerialCandidate(aiRecord.serial, mergedHardwareId)
      ? aiRecord.serial
      : localRecord.serial || aiRecord.serial;

  const mergedRecord: IntakeRecord = {
    sourceName: fileName,
    components: mergedComponent,
    description: mergedDescription,
    hardwareId: mergedHardwareId,
    serial: mergedSerial,
    remarks: localRecord.remarks || aiRecord.remarks || "New Accountability",
    notes: combineExtractionNotes(
      localRecord.notes,
      aiRecord.notes,
      countPopulatedIntakeFields({
        components: mergedComponent,
        description: mergedDescription,
        hardwareId: mergedHardwareId,
        serial: mergedSerial,
      }) > countPopulatedIntakeFields(localRecord)
        ? "Combined local PaddleOCR with AI-assisted field recovery."
        : ""
    ),
  };

  if (!mergedRecord.notes) {
    mergedRecord.notes = buildOcrNotes({
      hardwareId: mergedRecord.hardwareId,
      serial: mergedRecord.serial,
      description: mergedRecord.description,
      component: mergedRecord.components,
    });
  }

  return mergedRecord;
}

async function extractIntakeRecordsByBarcode(
  evidenceFiles: CompareSourceFile[],
  referenceRecords: ReferenceRecord[] = []
): Promise<IntakeExtractionResponse | null> {
  const barcodeRecords: IntakeRecord[] = [];
  let detected = 0;
  let matched = 0;
  let notFound = 0;

  for (const file of evidenceFiles) {
    if (file.kind !== "image" || file.contentType !== "inlineData") {
      continue;
    }

    let scan: BarcodeScanResult;
    try {
      scan = await postToPaddleBarcodeService(file);
    } catch (error) {
      console.warn(`[Barcode] scan failed for "${file.name}". Continuing with OCR fallback.`, error);
      continue;
    }

    if (!scan.barcode) {
      continue;
    }

    detected += 1;
    const matchedRecord = findRecordByBarcode(scan.barcode, referenceRecords);
    if (matchedRecord) {
      matched += 1;
    } else {
      notFound += 1;
    }

    barcodeRecords.push(buildBarcodeLookupRecord(file.name, scan.barcode, matchedRecord));
  }

  if (detected === 0) {
    return null;
  }

  return {
    records: barcodeRecords,
    summary: {
      requested: evidenceFiles.length,
      extracted: matched,
      cached: 0,
      manual: notFound,
      usedFallback: notFound > 0,
      message: matched > 0
        ? `Barcode lookup found ${matched} existing record${matched === 1 ? "" : "s"}${notFound > 0 ? `; ${notFound} barcode${notFound === 1 ? "" : "s"} had no matching record.` : "."}`
        : "No record found for this barcode.",
    },
  };
}

async function extractIntakeRecordsResilient(
  evidenceFiles: CompareSourceFile[],
  referenceRecords: ReferenceRecord[] = []
): Promise<IntakeExtractionResponse> {
  let cached = 0;
  let extracted = 0;
  let manual = 0;
  let localOcr = 0;
  let aiExtracted = 0;

  // Phase 1: Check cache and partition files by strategy
  const filesToProcess: CompareSourceFile[] = [];
  const processingStrategy: Map<string, "cached" | "ocr" | "ai" | "manual"> = new Map();
  const cacheKeyMap: Map<string, string> = new Map();
  const cachedResults: Map<string, IntakeRecord> = new Map();

  for (const file of evidenceFiles) {
    const cacheKey = getIntakeCacheKey(file);
    cacheKeyMap.set(file.name, cacheKey);
    const cachedRecord = intakeExtractionCache.get(cacheKey);

    if (cachedRecord) {
      cached += 1;
      cachedResults.set(file.name, { ...cachedRecord, sourceName: file.name });
      processingStrategy.set(file.name, "cached");
    } else {
      filesToProcess.push(file);
    }
  }

  // Phase 2: Parallel OCR extraction for all uncached files
  const ocrResults: Map<string, { full: OcrSnapshot; probes: IntakeProbeSnapshot[] }> = new Map();
  const ocrErrors: Map<string, Error> = new Map();

  await mapWithConcurrency(filesToProcess, localOcrParallelism, async (file) => {
    try {
      const snapshots = await extractRegionalOcrSnapshots(file);
      ocrResults.set(file.name, snapshots);
    } catch (error) {
      ocrErrors.set(file.name, error instanceof Error ? error : new Error(String(error)));
    }
  });

  // Phase 3: Build local records from OCR and partition for AI fallback
  const localRecords: Map<string, IntakeRecord> = new Map();
  const filesNeedingAi: CompareSourceFile[] = [];
  const filesWithPartialOcr: Map<string, IntakeRecord> = new Map();

  for (const file of filesToProcess) {
    const snapshots = ocrResults.get(file.name) || { full: buildPlainTextSnapshot(""), probes: [] };
    const ocrError = ocrErrors.get(file.name);
    const localRecord = buildIntakeRecordFromOcr(file.name, snapshots);
    const localFieldCount = countPopulatedIntakeFields(localRecord);
    const localRecordIsUsable = localFieldCount > 0 && hasUsableIntakeExtraction(localRecord);

    if (localFieldCount > 0 && hasStrongIntakeExtraction(localRecord)) {
      localRecords.set(file.name, localRecord);
      processingStrategy.set(file.name, "ocr");
    } else if (localRecordIsUsable) {
      localRecords.set(file.name, {
        ...localRecord,
        notes: combineExtractionNotes(
          localRecord.notes,
          "Posted immediately from stable local OCR so the asset rows can be reviewed without waiting for slower fallback recovery."
        ),
      });
      processingStrategy.set(file.name, "ocr");
    } else if (!intakeAiFallbackEnabled && localFieldCount === 0 && ocrError) {
      processingStrategy.set(file.name, "manual");
    } else if (ocrError || localFieldCount === 0) {
      filesNeedingAi.push(file);
      filesWithPartialOcr.set(file.name, localRecord);
    } else if (localFieldCount > 0) {
      filesWithPartialOcr.set(file.name, localRecord);
      filesNeedingAi.push(file);
    }
  }

  // Phase 4: Batch Gemini extraction for files needing AI (up to 10 per batch)
  const BATCH_SIZE = 10;
  const aiRecords: Map<string, IntakeRecord> = new Map();
  const aiErrors: Map<string, Error> = new Map();

  for (let i = 0; i < filesNeedingAi.length; i += BATCH_SIZE) {
    const batch = filesNeedingAi.slice(i, i + BATCH_SIZE);

    try {
      const records = await extractIntakeRecordsWithGemini(batch);

      batch.forEach((file, index) => {
        const aiRecord = records[index];
        const normalizedRecord = normalizeIntakeRecord(aiRecord);
        const partialLocal = filesWithPartialOcr.get(file.name);
        const localFieldCount = partialLocal ? countPopulatedIntakeFields(partialLocal) : 0;

        const mergedRecord = localFieldCount > 0 && partialLocal
          ? mergeLocalAndAiIntakeRecord(file.name, partialLocal, normalizedRecord)
          : {
              ...normalizedRecord,
              sourceName: normalizedRecord.sourceName || file.name,
            };

        aiRecords.set(file.name, mergedRecord);
        processingStrategy.set(file.name, "ai");
      });
    } catch (error: any) {
      const err = error instanceof Error ? error : new Error(String(error));

      batch.forEach((file) => {
        aiErrors.set(file.name, err);
      });
    }
  }

  // Phase 5: Build final result set
  const rawRecords: IntakeRecord[] = [];

  for (const file of evidenceFiles) {
    const strategy = processingStrategy.get(file.name);
    const cacheKey = cacheKeyMap.get(file.name)!;

    if (strategy === "cached") {
      rawRecords.push(cachedResults.get(file.name)!);
    } else if (strategy === "ocr") {
      extracted += 1;
      localOcr += 1;
      const record = localRecords.get(file.name)!;
      intakeExtractionCache.set(cacheKey, record);
      rawRecords.push(record);
    } else if (strategy === "ai") {
      extracted += 1;
      aiExtracted += 1;
      const record = aiRecords.get(file.name)!;
      intakeExtractionCache.set(cacheKey, record);
      rawRecords.push(record);
    } else {
      manual += 1;

      const aiError = aiErrors.get(file.name);
      const partialLocal = filesWithPartialOcr.get(file.name);
      const localFieldCount = partialLocal ? countPopulatedIntakeFields(partialLocal) : 0;

      if (localFieldCount > 0 && partialLocal && aiError) {
        const record = {
          ...partialLocal,
          notes: combineExtractionNotes(
            partialLocal.notes,
            "Partial local PaddleOCR extraction was kept because AI-assisted recovery was unavailable."
          ),
        };
        intakeExtractionCache.set(cacheKey, record);
        rawRecords.push(record);
      } else {
        const fallbackReason = aiError
          ? isGeminiRateLimit(aiError)
            ? "AI quota was unavailable. Enter the asset details manually."
            : isGeminiUnavailable(aiError)
              ? "AI extraction is temporarily unavailable. Enter the asset details manually."
              : aiError?.message?.includes("GEMINI_API_KEY")
              ? "AI extraction is not configured. Enter the asset details manually."
              : "Automatic extraction could not complete. Enter the asset details manually."
          : "Local OCR could not read this image. Enter the asset details manually.";

        rawRecords.push(buildManualIntakeFallback(file.name, fallbackReason));
      }
    }
  }

  const usedFallback = manual > 0;
  const hasReferenceAlignment = referenceRecords.length > 0;
  const alignedRecords = alignRecordsToReferenceBatch(rawRecords, referenceRecords);
  const records = dedupeIntakeRecords(alignedRecords);

  return {
    records,
    summary: {
      requested: evidenceFiles.length,
      extracted,
      cached,
      manual,
      usedFallback,
      message: usedFallback
        ? `Scanned${hasReferenceAlignment ? " and aligned to the reference document" : ""} with local OCR. ${manual} image${manual === 1 ? "" : "s"} still need manual review.`
        : `Scanned ${localOcr} image${localOcr === 1 ? "" : "s"} with local PaddleOCR${aiExtracted > 0 ? ` and ${aiExtracted} with AI fallback` : ""}${hasReferenceAlignment ? ". The rows were aligned to the reference accountability document." : "."}`,
    },
  };
}

function getPortProbeHosts(host: string): string[] {
  const probeHosts = new Set<string>([host]);

  if (host === "0.0.0.0") {
    probeHosts.add("::");
  } else if (host === "::") {
    probeHosts.add("0.0.0.0");
  }

  return Array.from(probeHosts);
}

async function canListenOnPort(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }

      if (error.code === "EAFNOSUPPORT") {
        resolve(true);
        return;
      }

      reject(error);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, host);
  });
}

async function findAvailablePort(startPort: number, host: string): Promise<number> {
  let port = startPort;
  const probeHosts = getPortProbeHosts(host);

  while (true) {
    let isAvailable = true;

    for (const probeHost of probeHosts) {
      const isHostAvailable = await canListenOnPort(port, probeHost);
      if (!isHostAvailable) {
        isAvailable = false;
        break;
      }
    }

    if (isAvailable) {
      return port;
    }

    port += 1;
  }
}

function isBindableHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "localhost" || net.isIP(host) !== 0;
}

function formatHttpUrl(host: string, port: number): string {
  return port === 80 ? `http://${host}` : `http://${host}:${port}`;
}

const DEFAULT_PUBLIC_HOST = "localhost";
const PREFERRED_PUBLIC_HOST = "iictdasset.lbfinc.org";
const LEGACY_PUBLIC_HOST = "iictdautomation.lbfinc.org";

type HostLookupResult = {
  hostname: string;
  ipv4Addresses: string[];
  lookupError: string | null;
  matchesLocalAddress: boolean;
};

type ResolvedHostConfig = {
  bindHost: string;
  publicHost: string;
  publicHostSource: "env_public_host" | "env_host" | "preferred_hostname" | "localhost_fallback";
  localIpv4Addresses: string[];
  preferredPublicHost: string;
  preferredHostLookup: HostLookupResult | null;
};

async function lookupHostnameIpv4(hostname: string, localIpv4Addresses: string[]): Promise<HostLookupResult> {
  try {
    const resolved = await dns.lookup(hostname, { all: true });
    const ipv4Addresses = Array.from(new Set(
      resolved
        .filter((entry) => entry.family === 4)
        .map((entry) => entry.address)
    ));

    return {
      hostname,
      ipv4Addresses,
      lookupError: null,
      matchesLocalAddress: ipv4Addresses.some((address) => localIpv4Addresses.includes(address)),
    };
  } catch (error: any) {
    return {
      hostname,
      ipv4Addresses: [],
      lookupError: error?.code || error?.message || "lookup failed",
      matchesLocalAddress: false,
    };
  }
}

async function resolveHostConfig(): Promise<ResolvedHostConfig> {
  const rawHost = (process.env.HOST || "").trim();
  const explicitPublicHost = (process.env.PUBLIC_HOST || "").trim();
  const localIpv4Addresses = getLocalIpv4Addresses();
  const bindHost = (
    process.env.BIND_HOST ||
    (isBindableHost(rawHost) ? rawHost : "") ||
    "0.0.0.0"
  ).trim();
  const preferredHostLookup = await lookupHostnameIpv4(PREFERRED_PUBLIC_HOST, localIpv4Addresses);
  const legacyHostLookup = await lookupHostnameIpv4(LEGACY_PUBLIC_HOST, localIpv4Addresses);

  let publicHost = DEFAULT_PUBLIC_HOST;
  let publicHostSource: ResolvedHostConfig["publicHostSource"] = "localhost_fallback";

  if (explicitPublicHost) {
    publicHost = explicitPublicHost;
    publicHostSource = "env_public_host";
  } else if (rawHost && !isBindableHost(rawHost)) {
    publicHost = rawHost;
    publicHostSource = "env_host";
  } else if (preferredHostLookup.matchesLocalAddress) {
    publicHost = PREFERRED_PUBLIC_HOST;
    publicHostSource = "preferred_hostname";
  } else if (legacyHostLookup.matchesLocalAddress) {
    publicHost = LEGACY_PUBLIC_HOST;
    publicHostSource = "preferred_hostname";
  }

  return {
    bindHost,
    publicHost,
    publicHostSource,
    localIpv4Addresses,
    preferredPublicHost: PREFERRED_PUBLIC_HOST,
    preferredHostLookup,
  };
}

function getAllowedViteHosts(publicHost: string): true | string[] {
  return true;
}

function getLocalIpv4Addresses(): string[] {
  const addresses = new Set<string>();
  let interfaces: ReturnType<typeof os.networkInterfaces>;
  try {
    interfaces = os.networkInterfaces();
  } catch (error: any) {
    console.warn(`Unable to inspect local network interfaces: ${error?.message || error}`);
    return [];
  }

  for (const networkInterface of Object.values(interfaces)) {
    for (const address of networkInterface || []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }

      addresses.add(address.address);
    }
  }

  return Array.from(addresses);
}

function logHostnameDiagnostics(hostConfig: ResolvedHostConfig, port: number) {
  const {
    publicHost,
    publicHostSource,
    localIpv4Addresses,
    preferredPublicHost,
    preferredHostLookup,
  } = hostConfig;
  const fallbackAddress = localIpv4Addresses[0] || "localhost";

  if (publicHostSource === "localhost_fallback") {
    if (preferredHostLookup?.lookupError) {
      console.warn(`Preferred hostname ${preferredPublicHost} does not resolve on this machine (${preferredHostLookup.lookupError}).`);
    } else if ((preferredHostLookup?.ipv4Addresses.length || 0) === 0) {
      console.warn(`Preferred hostname ${preferredPublicHost} resolved without an IPv4 address.`);
    } else {
      console.warn(`Preferred hostname ${preferredPublicHost} resolves to ${preferredHostLookup?.ipv4Addresses.join(", ")}, but this machine is using ${localIpv4Addresses.join(", ") || "no detected IPv4 address"}.`);
    }

    console.warn(`Using ${formatHttpUrl("localhost", port)} for safe local access.`);
    console.warn(`To use ${formatHttpUrl(preferredPublicHost, port)} on this PC, run 'npm run setup:ipas' or use 'npm run open:ipas'.`);
    return;
  }

  if (!publicHost || publicHost === "localhost" || net.isIP(publicHost) !== 0) {
    return;
  }

  const lookup = publicHost === preferredPublicHost
    ? preferredHostLookup
    : null;

  if (!lookup) {
    return;
  }

  if (lookup.lookupError) {
    console.warn(`Hostname ${publicHost} does not resolve on this machine (${lookup.lookupError}).`);
    console.warn(`Run 'npm run setup:domain' as Administrator to map ${publicHost} to ${fallbackAddress}, or browse to ${formatHttpUrl(fallbackAddress, port)}.`);
    return;
  }

  if (lookup.ipv4Addresses.length === 0) {
    console.warn(`Hostname ${publicHost} resolved without an IPv4 address. Local access may fail on some devices.`);
    return;
  }

  if (!lookup.matchesLocalAddress) {
    console.warn(`Hostname ${publicHost} resolves to ${lookup.ipv4Addresses.join(", ")}, but this machine is using ${localIpv4Addresses.join(", ") || "no detected IPv4 address"}.`);
    console.warn(`A normal browser on this PC may time out at ${formatHttpUrl(publicHost, port)}. Run 'npm run setup:domain', use 'npm run open:domain', or browse to ${formatHttpUrl(fallbackAddress, port)}.`);
  }
}

async function startServer() {
  const app = express();
  const hostConfig = await resolveHostConfig();
  const { bindHost: BIND_HOST, publicHost: PUBLIC_HOST } = hostConfig;
  const ALLOWED_VITE_HOSTS = getAllowedViteHosts(PUBLIC_HOST);
  const requestedPort = Number.parseInt(process.env.PORT || "3000", 10);
  const requestedHmrPort = Number.parseInt(process.env.HMR_PORT || "24678", 10);
  const PORT = Number.isNaN(requestedPort) ? 3000 : requestedPort;
  const HMR_PORT = Number.isNaN(requestedHmrPort) ? 24678 : requestedHmrPort;
  const strictPort = /^(1|true|yes)$/i.test(process.env.STRICT_PORT || "");
  const useSecureCookies =
    isProductionMode &&
    /^(1|true|yes)$/i.test(process.env.SECURE_COOKIES || "");
  const configuredSessionSecret = (process.env.SESSION_SECRET || "").trim();
  if (isProductionMode && (!configuredSessionSecret || configuredSessionSecret === "a-very-secret-key")) {
    throw new Error("SESSION_SECRET must be set to a strong private value before starting IPAS in production.");
  }
  const sessionSecret = configuredSessionSecret || "development-only-session-secret";

  // Trust proxy for secure cookies and domain access
  app.set('trust proxy', 1);
  
  // Add headers to allow access from mobile and domain
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Cross-Origin-Opener-Policy-Report-Only', 'same-origin');
    res.setHeader('X-App-Mode', runtimeMode);
    next();
  });

  // Body parsers FIRST
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  // Request logger and cache control for API - MOVE TO TOP
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - Request: ${req.method} ${req.url}`);
    if (req.url.startsWith('/api/')) {
      console.log(`API Request detected: ${req.method} ${req.url}`);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Ensure we don't serve HTML for API routes
      if (req.method === 'GET' || req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
    }
    next();
  });

  // Session configuration
  app.use(cookieSession({
    name: 'session',
    keys: [sessionSecret],
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: useSecureCookies,
    sameSite: useSecureCookies ? 'none' : 'lax',
    httpOnly: true,
    proxy: true,
  }));

  // Configure Multer for temporary file storage
  const upload = multer({ dest: "uploads/" });
  try {
    if (!fs.existsSync("uploads")) {
      fs.mkdirSync("uploads", { recursive: true });
    }
  } catch (err) {
    console.error("Failed to create uploads directory", err);
  }

  // In-memory history store
  const apiHistory: any[] = [];

  const isSuperAdminUser = (user: any) => {
    const role = String(user?.role || "").toUpperCase();
    const designation = String(user?.designation || "");
    return role === "SUPER_ADMIN" || designation === "Administrator" || designation === "System Admin";
  };

  const requireSuperAdmin = (req: Request, res: any) => {
    const sessionUser = (req as any).session?.user;
    if (!sessionUser) {
      res.status(401).json({ error: "Not authenticated" });
      return null;
    }
    if (!isSuperAdminUser(sessionUser)) {
      res.status(403).json({ error: "Only Super Admin users can delete forms." });
      return null;
    }
    return sessionUser;
  };

  // Accountability controller and routes
  const terLiquidationController = createTerLiquidationController({
    prepareUploadedFileForComparison,
    extractLiquidationRecordsFromEvidence,
    isInvalidStructuredResponse,
    isGeminiUnavailable,
    extractUpstreamErrorMessage,
    sanitizeLiquidationPayload,
    getLiquidationExportFormat,
    generateLiquidationExport,
  });

  const accountabilityController = createAccountabilityController({
    upload,
    apiHistory,
    requireSuperAdmin,
    normalizeIntakeRecord,
    normalizeBarcodeLookupValue,
    findRecordByBarcode,
    prepareUploadedFileForComparison,
    extractReferenceRecords,
    postToPaddleBarcodeService,
    extractUpstreamErrorMessage,
    buildPlainTextSnapshot,
    recognizeOcrDetailed,
    extractIntakeRecordsResilient,
    extractIntakeRecordsByBarcode,
    combineExtractionNotes,
    mergeConsolidatedIntakeRecords,
    isInvalidStructuredResponse,
    isGeminiUnavailable,
    runGeminiComparison,
    sanitizeAccountabilityPayload,
    getAccountabilityExportFormat,
    generateAccountabilityExport,
  });
  const accountabilityRoutes = createAccountabilityRoutes(accountabilityController);

  // In-memory inventory store

  const managementController = createManagementController();
  const managementRoutes = createManagementRoutes(managementController);
  const authController = createAuthController();
  const cameraSyncController = createCameraSyncController();
  const cameraSyncRoutes = createCameraSyncRoutes(cameraSyncController);
  const authRoutes = createAuthRoutes(authController);

  // API routes
  app.get("/api/health", async (req, res) => {
    console.log("GET /api/health hit");
    const ocr = shouldUsePaddleOcrService()
      ? (await isPaddleOcrServiceHealthy(ocrServiceProbeTimeoutMs) ? "connected" : "unavailable")
      : "legacy-worker";
    res.json({
      status: "ok",
      service: "iictd-process-automation-system",
      app: "IICTD Process Automation System (IPAS)",
      environment: process.env.NODE_ENV || runtimeMode,
      mode: runtimeMode,
      ocr,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get("/api/download/app", (req, res) => {
    const releaseDir = path.resolve(process.cwd(), "release-apk");
    const candidates = [
      path.join(releaseDir, "ipas.apk"),
      path.join(releaseDir, "ipas-native.apk"),
      path.join(releaseDir, "iictd-asset-docs.apk"),
      path.join(releaseDir, "iictd-asset-docs-native.apk"),
      path.join(releaseDir, "app-debug.apk"),
    ];
    const apkPath = candidates.find((p) => fs.existsSync(p));
    if (!apkPath) {
      return res.status(404).json({ error: "APK not found. Run .\\build-apk.ps1 to generate it." });
    }
    const stat = fs.statSync(apkPath);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", 'attachment; filename="ipas.apk"');
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(apkPath).pipe(res);
  });

  app.get("/api/runtime-info", (req, res) => {
    res.json({
      mode: runtimeMode,
      lifecycleEvent: process.env.npm_lifecycle_event || "",
      nodeEnv: process.env.NODE_ENV || "",
      publicHost: PUBLIC_HOST,
      bindHost: BIND_HOST,
      publicHostSource: hostConfig.publicHostSource,
      preferredPublicHost: hostConfig.preferredPublicHost,
      exports: {
        pdf: {
          available: true,
          reason: "",
        },
      },
    });
  });

  app.get("/api/storage-status", (req, res) => {
    try {
      const { url, username } = resolveNextcloudConfig();
      res.json({
        configured: true,
        url,
        username,
      });
    } catch {
      res.json({
        configured: false,
        url: process.env.NEXTCLOUD_URL || "https://nextcloud.lbfinc.org",
        username: "",
      });
    }
  });

  app.post("/api/test-nextcloud", async (req, res) => {
    const { nextcloudUrl, nextcloudUsername, nextcloudPassword } = req.body || {};

    try {
      const { url, username, password } = resolveNextcloudConfig({
        url: nextcloudUrl,
        username: nextcloudUsername,
        password: nextcloudPassword,
      });

      const client = getWebDAVClient({ url, username, password });
      await client.getDirectoryContents("/");

      res.json({
        configured: true,
        url,
        username,
      });
    } catch (error: any) {
      const status = error?.status === 401 ? 401 : 400;
      res.status(status).json({
        error: status === 401
          ? "Nextcloud login failed. Use your actual Nextcloud username and app password."
          : (error?.message || "Nextcloud connection test failed."),
      });
    }
  });

  app.post(
    "/api/liquidation/extract",
    (req, res, next) => {
      upload.array("evidence")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
          return res.status(400).json({
            error: `Upload error: ${err.message}`,
          });
        }
        if (err) {
          return res.status(500).json({
            error:
              err.message ||
              "Failed to process liquidation receipt upload.",
          });
        }
        next();
      });
    },
    terLiquidationController.extractLiquidation,
  );

  // TER travel-entry persistence is handled by PostgreSQL.
  app.use("/api/ter", terRoutes);

  app.post([
    "/api/export-accountability-form",
    "/api/intake/export-accountability-form",
    "/api/accountability-form/export",
  ], accountabilityController.exportAccountability);

  app.post([
    "/api/export-liquidation-form",
    "/api/liquidation/export",
    "/api/liquidation-form/export",
  ], terLiquidationController.exportLiquidation);

  // Accountability File Manager / History Endpoints
  app.use("/api", accountabilityRoutes);

  // Auth Endpoints
  app.use("/api/auth", authRoutes);

  // Inventory API Endpoints
  app.use("/api/inventory", assetRoutes);

  // User Registry Endpoints
  app.use("/api", managementRoutes);

  const documentRepositoryController = createDocumentRepositoryController({
    normalizeNextcloudPath,
    sanitizeNextcloudSegment,
    getWebDAVClient,
    resolveNextcloudConfig,
    verifyWebDAVConnection,
    createWebDAVClient: createClient,
    readFile: fs.promises.readFile,
    unlinkFile: fs.promises.unlink,
    getSafeFileName: path.posix.basename,
    getFileName: path.basename,
    getRepoMimeType,
  });

  // Document Repository: Nextcloud files and PostgreSQL metadata.
  registerDocumentRepositoryRoutes(app, { documentRepositoryController, upload });

  // Real-time mobile → desktop camera sync (SSE)
  app.use("/api/cam", cameraSyncRoutes);

  // Handle errors from every registered API module before the SPA fallback.
  app.use((err: any, req: Request, res: any, next: any) => {
    if (res.headersSent) {
      return next(err);
    }
    console.error("Global Error Handler:", err);
    res.status(err.status || 500).json({
      error: err.message || "Internal Server Error",
      path: req.url,
    });
  });

  // 404 for API routes - MUST be before SPA fallback
  app.all("/api/*", (req, res) => {
    console.warn(`API 404: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ 
      error: "API route not found", 
      method: req.method,
      path: req.originalUrl 
    });
  });

  // Vite middleware for development
  if (!isProductionMode) {
    const { createServer: createViteServer } = await import("vite");
    const availableHmrPort = await findAvailablePort(HMR_PORT, BIND_HOST);

    if (availableHmrPort !== HMR_PORT) {
      console.warn(`HMR port ${HMR_PORT} is already in use. Starting on ${availableHmrPort} instead.`);
    }

    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: ALLOWED_VITE_HOSTS,
        hmr: process.env.DISABLE_HMR === "true" ? false : {
          port: availableHmrPort,
          clientPort: availableHmrPort,
        },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath, { index: false }));
    app.get('*', async (req, res, next) => {
      try {
        const runtimeBootstrap = JSON.stringify({
          exports: {
            pdf: {
              available: true,
              reason: "",
            },
          },
        }).replace(/</g, "\\u003c");
        const indexPath = path.join(distPath, 'index.html');
        const indexHtml = await fs.promises.readFile(indexPath, "utf8");
        res.type("html").send(indexHtml.replace(
          "<head>",
          `<head>\n    <script>window.__IPAS_RUNTIME__=${runtimeBootstrap};</script>`
        ));
      } catch (error) {
        next(error);
      }
    });
  }

  const availablePort = await findAvailablePort(PORT, BIND_HOST);

  if (availablePort !== PORT) {
    if (strictPort) {
      throw new Error(`Port ${PORT} is required for this mode, but it is already in use. Stop the process using port ${PORT}, or use a non-root script such as 'npm run dev:domain'.`);
    }

    console.warn(`Port ${PORT} is already in use. Starting on ${availablePort} instead.`);
  }

  app.listen(availablePort, BIND_HOST, () => {
    const localIpv4Addresses = getLocalIpv4Addresses();
    const localUrl = formatHttpUrl("localhost", availablePort);
    const publicUrl = formatHttpUrl(PUBLIC_HOST, availablePort);
    console.log(`App mode: ${runtimeMode}`);
    console.log(`Server running on ${publicUrl}`);
    if (PUBLIC_HOST !== "localhost") {
      console.log(`Local access is also available at ${localUrl}`);
    }
    if (localIpv4Addresses.length > 0) {
      console.log(`LAN access is available at ${formatHttpUrl(localIpv4Addresses[0], availablePort)}`);
    }
    if (PUBLIC_HOST === "localhost") {
      console.log("To use iictdasset.lbfinc.org on this PC, run 'npm run setup:ipas' or use 'npm run open:ipas'.");
    }
    logHostnameDiagnostics(hostConfig, availablePort);
    
    // Log OCR configuration for debugging
    console.log(`\n📊 OCR Configuration:`);
    console.log(`   Engine: ${shouldUsePaddleOcrService() ? `Python OCR service (${ocrEngine})` : 'Legacy worker'}`);
    console.log(`   Service URL: ${ocrServiceUrl}`);
    console.log(`   Service Auto Start: ${ocrServiceAutoStart ? 'Enabled' : 'Disabled'}`);
    console.log(`   Service Timeout: ${ocrServiceTimeoutMs / 1000}s`);
    console.log(`   Service Startup Probe Timeout: ${ocrServiceStartupProbeTimeoutMs / 1000}s`);
    console.log(`   Startup Timeout: ${paddleOcrStartupTimeoutMs / 1000}s`);
    console.log(`   Request Timeout: ${paddleOcrRequestTimeoutMs / 1000}s per image`);
    console.log(`   Probe Timeout: ${paddleOcrProbeRequestTimeoutMs / 1000}s`);
    console.log(`   Max Retries: ${paddleOcrRetryCount}`);
    console.log(`   OCR Parallelism: ${localOcrParallelism}/${paddleOcrWorkerPoolSize} worker(s)`);
    console.log(`   Probes: ${paddleOcrProbeEnabled ? 'Enabled' : 'Disabled'}`);
    console.log(`   AI Fallback: ${intakeAiFallbackEnabled ? 'Enabled' : 'Disabled'}\n`);
    
    if (shouldUsePaddleOcrService()) {
      ensurePaddleOcrServiceReady().catch((error) => {
        console.warn(`[OCR] Python EasyOCR service startup check failed: ${extractUpstreamErrorMessage(error)}`);
        console.warn("[OCR] Existing legacy worker fallback remains available for OCR requests.");
      });
    } else {
      prewarmPaddleOcrWorker();
    }
  });
}

startServer();
