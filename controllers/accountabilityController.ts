import type { Request, Response } from "express";
import type { Multer } from "multer";
import { writeAuditLog } from "./auditHelper.js";
import {
  createAccountabilityForm,
  deleteAccountabilityForm,
  getAccountabilityFormById,
  getAccountabilityForms,
  updateAccountabilityForm,
} from "../database/repositories/accountabilityRepository.js";

type CompareSourceFile = {
  name: string;
  kind: "excel" | "pdf" | "image";
  contentType: "text" | "inlineData";
  content: string;
  mimeType: string;
};

type IntakeRecord = {
  sourceName: string;
  components: string;
  description: string;
  hardwareId: string;
  serial: string;
  remarks: string;
  notes?: string;
};

type BarcodeScanResult = {
  success: boolean;
  barcode: string | null;
  type?: string | null;
  matched: boolean;
  record: IntakeRecord | null;
  message: string;
  barcodes?: Array<{
    value: string;
    type?: string | null;
    points?: unknown;
  }>;
  durationMs?: number;
};


type OcrBoundingBox = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

type OcrLine = {
  text: string;
  confidence: number;
  bbox: OcrBoundingBox;
};

type OcrWord = {
  text: string;
  confidence: number;
  bbox: OcrBoundingBox;
};

type OcrSnapshot = {
  text: string;
  confidence: number;
  lines: OcrLine[];
  words: OcrWord[];
  width: number;
  height: number;
};

type IntakeExtractionResponse = {
  records: IntakeRecord[];
  summary: {
    requested: number;
    extracted: number;
    cached: number;
    manual: number;
    usedFallback: boolean;
    message?: string;
  };
};

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

export interface AccountabilityControllerDependencies {
  upload: Multer;
  apiHistory: any[];
  requireSuperAdmin: (req: Request, res: Response) => any;
  normalizeIntakeRecord: (record: Partial<IntakeRecord> | undefined) => IntakeRecord;
  normalizeBarcodeLookupValue: (value: string | null | undefined) => string;
  findRecordByBarcode: (
    barcode: string | null | undefined,
    referenceRecords?: IntakeRecord[],
  ) => IntakeRecord | null;
  prepareUploadedFileForComparison: (
    file: Express.Multer.File,
  ) => Promise<CompareSourceFile>;
  extractReferenceRecords: (
    referenceSource?: CompareSourceFile | null,
  ) => IntakeRecord[];
  postToPaddleBarcodeService: (
    file: CompareSourceFile,
  ) => Promise<BarcodeScanResult>;
  extractUpstreamErrorMessage: (error: unknown) => string;
  buildPlainTextSnapshot: (text: string) => OcrSnapshot;
  postToPaddleOcrService: (
    file: CompareSourceFile,
    options?: { mode?: string },
  ) => Promise<{ snapshot?: OcrSnapshot }>;
  recognizeOcrSnapshotWithLegacyWorker: (
    file: CompareSourceFile,
    options?: { mode?: string },
  ) => Promise<OcrSnapshot>;
  extractIntakeRecordsResilient: (
    evidenceFiles: CompareSourceFile[],
    referenceRecords?: IntakeRecord[],
  ) => Promise<IntakeExtractionResponse>;
  extractIntakeRecordsByBarcode: (
    evidenceFiles: CompareSourceFile[],
    referenceRecords?: IntakeRecord[],
  ) => Promise<IntakeExtractionResponse | null>;
  combineExtractionNotes: (
    ...notes: Array<string | undefined>
  ) => string;
  mergeConsolidatedIntakeRecords: (
    primary: IntakeRecord,
    candidate: IntakeRecord,
  ) => IntakeRecord;
  isInvalidStructuredResponse: (error: unknown) => boolean;
  isGeminiUnavailable: (error: any) => boolean;
  runGeminiComparison: (
    source1: CompareSourceFile,
    source2: CompareSourceFile[],
  ) => Promise<unknown>;
  sanitizeAccountabilityPayload: (
    payload: Partial<AccountabilityFormPayload> | undefined,
  ) => AccountabilityFormPayload;
  getAccountabilityExportFormat: (
    value: unknown,
  ) => AccountabilityExportFormat;
  generateAccountabilityExport: (
    payload: AccountabilityFormPayload,
    format: AccountabilityExportFormat,
  ) => Promise<{
    buffer: Buffer;
    contentType: string;
    extension: AccountabilityExportFormat;
  }>;
}

export function createAccountabilityController(
  dependencies: AccountabilityControllerDependencies,
) {
  const {
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
    postToPaddleOcrService,
    recognizeOcrSnapshotWithLegacyWorker,
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
  } = dependencies;

  const getAccountabilityFormList = async (
    _req: Request,
    res: Response,
  ) => {
    try {
      const forms = await getAccountabilityForms();
      return res.status(200).json(forms);
    } catch (error: any) {
      console.error("Get accountability forms error:", error);
      return res.status(500).json({
        error: "Failed to load accountability forms.",
      });
    }
  };

  const getAccountabilityForm = async (
    req: Request,
    res: Response,
  ) => {
    try {
      const id = String(req.params.id ?? "").trim();

      if (!id) {
        return res.status(400).json({
          error: "Accountability form id is required.",
        });
      }

      const form = await getAccountabilityFormById(id);

      if (!form) {
        return res.status(404).json({
          error: "Accountability form not found.",
        });
      }

      return res.status(200).json(form);
    } catch (error: any) {
      console.error("Get accountability form error:", error);

      if (error?.code === "22P02") {
        return res.status(400).json({
          error: "Invalid accountability form id.",
        });
      }

      return res.status(500).json({
        error: "Failed to load accountability form.",
      });
    }
  };

  const createAccountabilityFormRecord = async (
    req: Request,
    res: Response,
  ) => {
    try {
      const sessionUser = (req as any).session?.user;

      if (!sessionUser?.id) {
        return res.status(401).json({
          error: "Authentication required.",
        });
      }

      const employeeName = String(
        req.body?.employeeName ?? "",
      ).trim();

      if (!employeeName) {
        return res.status(400).json({
          error: "Employee name is required.",
        });
      }

      const created = await createAccountabilityForm({
        ...req.body,
        employeeName,
        createdBy: sessionUser.id,
      });

      await writeAuditLog(req, {
        action: "ACCOUNTABILITY_CREATED",
        entityType: "accountability_form",
        entityId: created.id,
        details: {},
      });

      return res.status(201).json(created);
    } catch (error: any) {
      console.error("Create accountability form error:", error);

      if (error?.code === "22P02") {
        return res.status(400).json({
          error: "Invalid UUID value.",
        });
      }

      if (error?.code === "23503") {
        return res.status(400).json({
          error: "Referenced user or asset does not exist.",
        });
      }

      return res.status(500).json({
        error:
          error?.message ||
          "Failed to create accountability form.",
      });
    }
  };

  const updateAccountabilityFormRecord = async (
    req: Request,
    res: Response,
  ) => {
    try {
      const sessionUser = (req as any).session?.user;

      if (!sessionUser?.id) {
        return res.status(401).json({
          error: "Authentication required.",
        });
      }

      const id = String(req.params.id ?? "").trim();

      if (!id) {
        return res.status(400).json({
          error: "Accountability form id is required.",
        });
      }

      const employeeName = String(
        req.body?.employeeName ?? "",
      ).trim();

      if (!employeeName) {
        return res.status(400).json({
          error: "Employee name is required.",
        });
      }

      const updated = await updateAccountabilityForm(id, {
        ...req.body,
        employeeName,
      });

      if (!updated) {
        return res.status(404).json({
          error: "Accountability form not found.",
        });
      }

      await writeAuditLog(req, {
        action: "ACCOUNTABILITY_UPDATED",
        entityType: "accountability_form",
        entityId: updated.id,
        details: {},
      });

      return res.status(200).json(updated);
    } catch (error: any) {
      console.error("Update accountability form error:", error);

      if (error?.code === "22P02") {
        return res.status(400).json({
          error: "Invalid UUID value.",
        });
      }

      if (error?.code === "23503") {
        return res.status(400).json({
          error: "Referenced asset does not exist.",
        });
      }

      return res.status(500).json({
        error:
          error?.message ||
          "Failed to update accountability form.",
      });
    }
  };

  const deleteAccountabilityFormRecord = async (
    req: Request,
    res: Response,
  ) => {
    try {
      const sessionUser = (req as any).session?.user;

      if (!sessionUser?.id) {
        return res.status(401).json({
          error: "Authentication required.",
        });
      }

      const id = String(req.params.id ?? "").trim();

      if (!id) {
        return res.status(400).json({
          error: "Accountability form id is required.",
        });
      }

      const deleted = await deleteAccountabilityForm(id);

      if (!deleted) {
        return res.status(404).json({
          error: "Accountability form not found.",
        });
      }

      await writeAuditLog(req, {
        action: "ACCOUNTABILITY_DELETED",
        entityType: "accountability_form",
        entityId: deleted.id,
        details: {},
      });

      return res.status(200).json({
        success: true,
        message: "Accountability form deleted successfully.",
        id: deleted.id,
      });
    } catch (error: any) {
      console.error("Delete accountability form error:", error);

      if (error?.code === "22P02") {
        return res.status(400).json({
          error: "Invalid accountability form id.",
        });
      }

      return res.status(500).json({
        error: "Failed to delete accountability form.",
      });
    }
  };

  const getHistory = (_req: Request, res: Response) => {
    console.log(`GET /api/history - Found ${apiHistory.length} entries`);
    return res.status(200).json(apiHistory);
  };

  const createHistory = (req: Request, res: Response) => {
    console.log(
      "POST /api/history - Body:",
      JSON.stringify(req.body).substring(0, 100),
    );

    const entry = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      ...req.body,
    };

    apiHistory.unshift(entry);
    return res.json(entry);
  };

  const deleteHistory = (req: Request, res: Response) => {
    if (!requireSuperAdmin(req, res)) return;

    const id = String(req.params.id || "").trim();
    const entryIndex = apiHistory.findIndex(
      (entry) => String(entry?.id) === id,
    );

    if (entryIndex === -1) {
      return res.status(404).json({
        error: "Form history entry not found.",
      });
    }

    const [deleted] = apiHistory.splice(entryIndex, 1);

    return res.json({
      success: true,
      message: "Form deleted successfully.",
      id: deleted?.id,
    });
  };

  const lookupBarcode = (req: Request, res: Response) => {
    const barcode =
      typeof req.body?.barcode === "string" ? req.body.barcode : "";

    const records = Array.isArray(req.body?.records)
      ? req.body.records.map((record: Partial<IntakeRecord>) =>
          normalizeIntakeRecord(record),
        )
      : [];

    const matchedRecord = findRecordByBarcode(barcode, records);
    const normalizedBarcode = normalizeBarcodeLookupValue(barcode);

    if (matchedRecord) {
      return res.json({
        success: true,
        barcode,
        type: null,
        matched: true,
        record: matchedRecord,
        message: "Record found",
      });
    }

    return res.json({
      success: Boolean(normalizedBarcode),
      barcode: normalizedBarcode ? barcode : null,
      type: null,
      matched: false,
      record: null,
      message: normalizedBarcode
        ? "No record found for this barcode."
        : "No barcode detected. Please capture a clearer image.",
    });
  };

  const scanBarcode = async (req: Request, res: Response) => {
    const files = (((req as any).files || []) as Express.Multer.File[]).filter(
      Boolean,
    );
    const uploadedFile = files[0];

    const rawReferenceSource =
      typeof (req.body as any)?.referenceSource === "string"
        ? (req.body as any).referenceSource
        : "";

    const rawRecords =
      typeof (req.body as any)?.records === "string"
        ? (req.body as any).records
        : "";

    if (!uploadedFile) {
      return res.status(400).json({
        success: false,
        barcode: null,
        matched: false,
        record: null,
        message: "Upload one barcode image using the image or file field.",
      });
    }

    try {
      const preparedFile =
        await prepareUploadedFileForComparison(uploadedFile);

      if (preparedFile.kind !== "image") {
        return res.status(400).json({
          success: false,
          barcode: null,
          matched: false,
          record: null,
          message: "Barcode scan accepts image files only.",
        });
      }

      const referenceSource = rawReferenceSource
        ? (JSON.parse(rawReferenceSource) as CompareSourceFile)
        : null;

      const referenceRecords = extractReferenceRecords(referenceSource);

      const providedRecords = rawRecords
        ? JSON.parse(rawRecords).map((record: Partial<IntakeRecord>) =>
            normalizeIntakeRecord(record),
          )
        : [];

      const scan = await postToPaddleBarcodeService(preparedFile);

      if (!scan.barcode) {
        return res.json({
          ...scan,
          success: false,
          matched: false,
          record: null,
          message: "No barcode detected. Please capture a clearer image.",
        });
      }

      const matchedRecord = findRecordByBarcode(scan.barcode, [
        ...providedRecords,
        ...referenceRecords,
      ]);

      return res.json({
        ...scan,
        success: true,
        matched: Boolean(matchedRecord),
        record: matchedRecord,
        message: matchedRecord
          ? "Record found"
          : "No record found for this barcode.",
      });
    } catch (error: any) {
      console.error("Barcode scan error:", error);

      return res.status(500).json({
        success: false,
        barcode: null,
        type: null,
        matched: false,
        record: null,
        message:
          extractUpstreamErrorMessage(error) || "Failed to scan barcode.",
      });
    } finally {
      for (const file of files) {
        await import("node:fs").then(({ promises }) =>
          promises.unlink(file.path).catch(() => undefined),
        );
      }
    }
  };

  const ocrV2 = async (req: Request, res: Response) => {
    const files = (((req as any).files || []) as Express.Multer.File[]).filter(
      Boolean,
    );
    const uploadedFile = files[0];

    if (!uploadedFile) {
      return res.status(400).json({
        error: "Upload one image file using the image or file field.",
      });
    }

    try {
      const preparedFile =
        await prepareUploadedFileForComparison(uploadedFile);

      if (preparedFile.kind !== "image") {
        return res.status(400).json({
          error: "OCR v2 currently accepts image files only.",
        });
      }

      let snapshot: OcrSnapshot;
      let engine = "paddle-service";
      let fallback = false;
      let serviceError = "";
      const startedAt = Date.now();

      try {
        const result = await postToPaddleOcrService(preparedFile, {
          mode: "full",
        });
        snapshot = result.snapshot || buildPlainTextSnapshot("");
      } catch (error) {
        serviceError = extractUpstreamErrorMessage(error);
        fallback = true;
        engine = "legacy-worker";
        console.warn(
          `[OCR] /api/ocr-v2 fallback=true error=${serviceError}`,
        );
        snapshot = await recognizeOcrSnapshotWithLegacyWorker(preparedFile, {
          mode: "full",
        });
      }

      console.log(
        `[OCR] /api/ocr-v2 engine=${engine} elapsed=${Date.now() - startedAt}ms fallback=${fallback}`,
      );

      return res.json({
        text: snapshot.text,
        confidence: snapshot.confidence,
        lines: snapshot.lines,
        words: snapshot.words,
        boundingBoxes: snapshot.lines.map((line) => line.bbox),
        width: snapshot.width,
        height: snapshot.height,
        snapshot,
        raw: {
          engine,
          fallback,
        },
        error: serviceError || undefined,
      });
    } catch (error: any) {
      console.error("OCR v2 error:", error);

      const errorMessage =
        extractUpstreamErrorMessage(error) || "OCR failed.";

      const status = errorMessage.startsWith("Unsupported file type:")
        ? 400
        : 500;

      return res.status(status).json({
        text: "",
        confidence: 0,
        lines: [],
        words: [],
        boundingBoxes: [],
        width: 0,
        height: 0,
        snapshot: buildPlainTextSnapshot(""),
        error: errorMessage,
      });
    } finally {
      for (const file of files) {
        await import("node:fs").then(({ promises }) =>
          promises.unlink(file.path).catch(() => undefined),
        );
      }
    }
  };

  const extractIntake = async (req: Request, res: Response) => {
    const files = (((req as any).files || []) as Express.Multer.File[]).filter(
      Boolean,
    );

    const rawReferenceSource =
      typeof (req.body as any)?.referenceSource === "string"
        ? (req.body as any).referenceSource
        : "";

    if (files.length === 0) {
      return res.status(400).json({
        error: "At least one evidence image is required.",
      });
    }

    try {
      const preparedEvidence = await Promise.all(
        files.map(prepareUploadedFileForComparison),
      );

      const referenceSource = rawReferenceSource
        ? (JSON.parse(rawReferenceSource) as CompareSourceFile)
        : null;

      const referenceRecords = extractReferenceRecords(referenceSource);

      // Smart Capture always performs full OCR first.
      // Barcode/QR detection is enrichment only and must never bypass OCR.
      const extraction = await extractIntakeRecordsResilient(
        preparedEvidence,
        referenceRecords,
      );

      const barcodeExtraction = await extractIntakeRecordsByBarcode(
        preparedEvidence,
        referenceRecords,
      );

      if (barcodeExtraction?.records?.length) {
        const barcodeBySource = new Map(
          barcodeExtraction.records.map(
            (record) => [record.sourceName, record] as const,
          ),
        );

        extraction.records = extraction.records.map((ocrRecord) => {
          const barcodeRecord = barcodeBySource.get(ocrRecord.sourceName);

          if (!barcodeRecord) {
            return ocrRecord;
          }

          const hasUsefulBarcodeDetails = Boolean(
            barcodeRecord.components ||
              barcodeRecord.description ||
              barcodeRecord.hardwareId ||
              barcodeRecord.serial,
          );

          if (!hasUsefulBarcodeDetails) {
            return {
              ...ocrRecord,
              notes: combineExtractionNotes(
                ocrRecord.notes,
                barcodeRecord.notes,
              ),
            };
          }

          return mergeConsolidatedIntakeRecords(
            ocrRecord,
            barcodeRecord,
          );
        });
      }

      return res.json(extraction);
    } catch (error: any) {
      console.error("Intake extraction error:", error);

      if (isInvalidStructuredResponse(error)) {
        return res.status(502).json({
          error:
            "The extraction service returned incomplete structured data. Please scan the images again.",
        });
      }

      if (error?.message?.includes("GEMINI_API_KEY")) {
        return res.status(503).json({
          error:
            "GEMINI_API_KEY is not configured. Create .env.local and restart the server.",
        });
      }

      if (isGeminiUnavailable(error)) {
        return res.status(503).json({
          error:
            "Extraction service is temporarily busy. Please try again in a moment.",
        });
      }

      return res.status(500).json({
        error:
          extractUpstreamErrorMessage(error) ||
          "Failed to extract intake details.",
      });
    } finally {
      for (const file of files) {
        await import("node:fs").then(({ promises }) =>
          promises.unlink(file.path).catch(() => undefined),
        );
      }
    }
  };

  const compare = async (req: Request, res: Response) => {
    const { source1, source2 } = req.body as {
      source1?: CompareSourceFile;
      source2?: CompareSourceFile[];
    };

    if (!source1 || !Array.isArray(source2) || source2.length === 0) {
      return res.status(400).json({
        error: "Comparison request is missing source files.",
      });
    }

    try {
      const results = await runGeminiComparison(source1, source2);
      return res.json(results);
    } catch (error: any) {
      console.error("Comparison error:", error);

      if (isInvalidStructuredResponse(error)) {
        console.error(
          "Malformed Gemini JSON snippet:",
          error?.responseSnippet,
        );
        return res.status(502).json({
          error:
            "Comparison service returned incomplete structured data. Please try the comparison again.",
        });
      }

      if (error?.message?.includes("GEMINI_API_KEY")) {
        return res.status(503).json({
          error:
            "GEMINI_API_KEY is not configured. Create .env.local and restart the server.",
        });
      }

      if (
        error?.message?.includes("429") ||
        error?.message?.includes("RESOURCE_EXHAUSTED") ||
        error?.message?.includes("quota exceeded")
      ) {
        return res.status(429).json({
          error:
            "Gemini API quota exceeded. Please wait a few minutes and try again.",
        });
      }

      if (isGeminiUnavailable(error)) {
        return res.status(503).json({
          error:
            "Comparison service is temporarily busy. Please try again in a moment.",
        });
      }

      if (
        error?.message?.includes("403") ||
        error?.message?.includes("PERMISSION_DENIED")
      ) {
        return res.status(403).json({
          error:
            "Gemini API permission denied. Check your GEMINI_API_KEY.",
        });
      }

      return res.status(500).json({
        error:
          extractUpstreamErrorMessage(error) || "Comparison failed.",
      });
    }
  };


  const compareUpload = async (req: Request, res: Response) => {
    const files = ((req as any).files || {}) as Record<string, Express.Multer.File[]>;
    const source1File = files.source1?.[0];
    const source2Files = files.source2 || [];
    const uploadedFiles = [source1File, ...source2Files].filter(Boolean) as Express.Multer.File[];

    if (!source1File || source2Files.length === 0) {
      for (const file of uploadedFiles) {
        await import("node:fs").then(({ promises }) =>
          promises.unlink(file.path).catch(() => undefined),
        );
      }
      return res.status(400).json({ error: "Comparison request is missing source files." });
    }

    try {
      const preparedSource1 = await prepareUploadedFileForComparison(source1File);
      const preparedSource2 = await Promise.all(source2Files.map(prepareUploadedFileForComparison));
      const results = await runGeminiComparison(preparedSource1, preparedSource2);
      return res.json(results);
    } catch (error: any) {
      console.error("Comparison upload error:", error);

      if (isInvalidStructuredResponse(error))
        return res.status(502).json({ error: "Comparison service returned incomplete structured data. Please try the comparison again." });

      if (error?.message?.includes("GEMINI_API_KEY"))
        return res.status(503).json({ error: "GEMINI_API_KEY is not configured. Create .env.local and restart the server." });

      if (error?.message?.includes("429") || error?.message?.includes("RESOURCE_EXHAUSTED") || error?.message?.includes("quota exceeded"))
        return res.status(429).json({ error: "Gemini API quota exceeded. Please wait a few minutes and try again." });

      if (isGeminiUnavailable(error))
        return res.status(503).json({ error: "Comparison service is temporarily busy. Please try again in a moment." });

      if (error?.message?.includes("403") || error?.message?.includes("PERMISSION_DENIED"))
        return res.status(403).json({ error: "Gemini API permission denied. Check your GEMINI_API_KEY." });

      return res.status(500).json({ error: extractUpstreamErrorMessage(error) || "Comparison failed." });
    } finally {
      for (const file of uploadedFiles) {
        await import("node:fs").then(({ promises }) =>
          promises.unlink(file.path).catch(() => undefined),
        );
      }
    }
  };

  const exportAccountability = async (req: Request, res: Response) => {
    try {
      const payload = sanitizeAccountabilityPayload(
        req.body as Partial<AccountabilityFormPayload>,
      );
      const format = getAccountabilityExportFormat(
        (req.body as { format?: string } | undefined)?.format,
      );

      if (!payload.items.length) {
        return res.status(400).json({
          error: "At least one accountability row is required before export.",
        });
      }

      const exportedFile = await generateAccountabilityExport(payload, format);

      let mmddyy = "";
      const rawDate = payload.effectiveDate || "";
      const isoMatch = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
      const usMatch = rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      const altMatch = rawDate.match(/^(\d{2})-(\d{2})-(\d{4})/);

      if (isoMatch) {
        mmddyy = `${isoMatch[2]}${isoMatch[3]}${isoMatch[1].slice(-2)}`;
      } else if (usMatch) {
        mmddyy = `${usMatch[1]}${usMatch[2]}${usMatch[3].slice(-2)}`;
      } else if (altMatch) {
        mmddyy = `${altMatch[1]}${altMatch[2]}${altMatch[3].slice(-2)}`;
      } else {
        const now = new Date();
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const dd = String(now.getDate()).padStart(2, "0");
        const yy = String(now.getFullYear()).slice(-2);
        mmddyy = `${mm}${dd}${yy}`;
      }

      const safeName =
        (payload.employeeName || "Unknown")
          .trim()
          .replace(/[/\\:*?"<>|]+/g, " ")
          .replace(/\s{2,}/g, " ")
          .trim() || "Unknown";

      const fileNameBase =
        `${mmddyy} ${safeName} - New Accountability`;

      res.setHeader("Content-Type", exportedFile.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileNameBase}.${exportedFile.extension}"`,
      );
      return res.send(exportedFile.buffer);
    } catch (error: any) {
      console.error("Accountability export error:", error);
      return res.status(500).json({
        error:
          error?.message ||
          "Failed to generate the accountability form.",
      });
    }
  };

  return {
    upload,
    getAccountabilityFormList,
    getAccountabilityForm,
    createAccountabilityFormRecord,
    updateAccountabilityFormRecord,
    deleteAccountabilityFormRecord,
    getHistory,
    createHistory,
    deleteHistory,
    lookupBarcode,
    scanBarcode,
    ocrV2,
    extractIntake,
    compare,
    compareUpload,
    exportAccountability,
  };
}

export type AccountabilityController = ReturnType<
  typeof createAccountabilityController
>;
