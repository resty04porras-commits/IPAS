import type { OcrSourceFile as CompareSourceFile, OcrSnapshot, OcrRecognition, OcrRecognizeOptions } from "../types/ocr.js";
import type { BarcodeScanResult as ScanResult, BarcodeCandidate } from "../types/barcode.js";
import type { Request, Response } from "express";
import { createComparisonResponse } from "../services/comparisonStream.js";
import type { ComparisonContext } from "../services/comparisonWorkflow.js";
import { generateComparisonReportExport } from "../services/comparisonReport.js";
import type { Multer } from "multer";
import { writeAuditLog } from "./auditHelper.js";
import {
  createAccountabilityForm,
  deleteAccountabilityForm,
  getAccountabilityFormById,
  getAccountabilityForms,
  updateAccountabilityForm,
} from "../database/repositories/accountabilityRepository.js";

type IntakeRecord = {
  sourceName: string;
  components: string;
  description: string;
  hardwareId: string;
  serial: string;
  remarks: string;
  notes?: string;
};

type BarcodeScanResult = ScanResult<IntakeRecord>;


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
    options?: { timeoutMs?: number },
  ) => Promise<BarcodeScanResult>;
  extractUpstreamErrorMessage: (error: unknown) => string;
  buildPlainTextSnapshot: (text: string) => OcrSnapshot;
  recognizeOcrDetailed: (
    file: CompareSourceFile,
    options?: OcrRecognizeOptions,
  ) => Promise<OcrRecognition>;
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
    context?: ComparisonContext,
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

      const startedAt = Date.now();
      const [ocrAttempt, barcodeAttempt] = await Promise.allSettled([
        recognizeOcrDetailed(preparedFile, { mode: "full" }),
        // Optional enrichment has its own short timeout. Its failure must not
        // turn a successful OCR read into an error or change OCR confidence.
        Promise.resolve().then(() => postToPaddleBarcodeService(preparedFile, { timeoutMs: 5000 })),
      ]);
      if (ocrAttempt.status === "rejected") throw ocrAttempt.reason;
      const { snapshot, engine, fallback, primaryError } = ocrAttempt.value;
      const scan = barcodeAttempt.status === "fulfilled" ? barcodeAttempt.value : null;
      const barcodeValues: BarcodeCandidate[] = Array.isArray(scan?.barcodes)
        ? scan.barcodes.filter((entry) => entry && typeof entry.value === "string" && entry.value.trim())
        : [];
      if (!barcodeValues.length && scan?.barcode) {
        barcodeValues.push({ value: scan.barcode, type: scan.type });
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
        // Decoded data is separate from OCR text. The operator decides whether
        // a candidate represents an asset tag, serial, product code, or URL.
        barcodes: barcodeValues,
        raw: {
          engine,
          fallback,
          barcodeStatus: scan ? (barcodeValues.length ? "decoded" : "not_detected") : "unavailable",
          ...(scan?.engine ? { barcodeEngine: scan.engine } : {}),
          ...(primaryError ? { primaryError } : {}),
        },
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

  function comparisonFailure(error: any, reply: ReturnType<typeof createComparisonResponse>) {
    if (error?.code === "AI_DAILY_BUDGET") return reply.fail("The installation's Gemini allowance for the past 24 hours is exhausted. A readable local PDF or structured Excel reference can still be compared with local OCR.", 429);
    if (error?.code === "AI_MINUTE_BUDGET") return reply.fail("The installation's Gemini allowance per minute is exhausted. Local reading remains available; retry cloud reading when the allowance becomes available.", 429);
    if (error?.code === "AI_COOLDOWN") return reply.fail("Gemini is cooling down after an earlier provider error. Local reading remains available; cloud reading can be retried after the cooldown.", 429);
    if (error?.code === "AI_DISABLED") return reply.fail("Reference document reading is unavailable in local-only mode. Use a structured Excel table or check the existing document-reading settings.", 503);
    if (error?.code === "AI_TIMEOUT") return reply.fail("Reference document reading timed out. The selected files were kept; use a clearer reference copy or try again.", 504);
    if (isInvalidStructuredResponse(error)) return reply.fail("Comparison service returned incomplete structured data. The selected files were kept; review the source or try again.", 502);
    if (error?.message?.includes("GEMINI_API_KEY")) return reply.fail("GEMINI_API_KEY is not configured. Create .env.local and restart the server.", 503);
    if (error?.status === 429 || /429|RESOURCE_EXHAUSTED|quota exceeded/i.test(error?.message || "")) return reply.fail("Cloud comparison quota or the local request budget is unavailable. The selected files were kept.", 429);
    if (error?.status === 403 || /403|PERMISSION_DENIED/.test(error?.message || "")) return reply.fail("Gemini API permission denied. Check your GEMINI_API_KEY.", 403);
    if ([400,413,499,504].includes(error?.status)) return reply.fail(String(error.message).slice(0,500), error.status);
    if (isGeminiUnavailable(error)) return reply.fail("Comparison service is temporarily busy. Please try again in a moment.", 503);
    return reply.fail((extractUpstreamErrorMessage(error) || "Comparison failed.").slice(0,500), 500);
  }
  const compare = async (req: Request, res: Response) => {
    const { source1, source2 } = req.body as { source1?: CompareSourceFile; source2?: CompareSourceFile[] };
    if (!source1 || !Array.isArray(source2) || !source2.length) return res.status(400).json({ error: "Comparison request is missing source files." });
    const reply = createComparisonResponse(req,res);
    try {
      reply.progress({ stage: "source", completed: 0, total: 1, message: "Preparing the comparison…" });
      return reply.finish(await runGeminiComparison(source1, source2, reply.context));
    } catch (error) { console.error("Comparison error:", error); return comparisonFailure(error,reply); }
    finally { reply.dispose(); }
  };

  const compareUpload = async (req: Request, res: Response) => {
    const files = ((req as any).files || {}) as Record<string, Express.Multer.File[]>;
    const source1File = files.source1?.[0], source2Files = files.source2 || [];
    const uploadedFiles = [source1File,...source2Files].filter(Boolean) as Express.Multer.File[];
    const reply = createComparisonResponse(req,res);
    try {
      if (!source1File || !source2Files.length) return reply.fail("Comparison request is missing source files.",400);
      reply.progress({ stage: "source", completed: 0, total: 1, message: "Preparing the uploaded files…" });
      const preparedSource1 = await prepareUploadedFileForComparison(source1File);
      const preparedSource2 = await Promise.all(source2Files.map(prepareUploadedFileForComparison));
      return reply.finish(await runGeminiComparison(preparedSource1,preparedSource2,reply.context));
    } catch (error) { console.error("Comparison upload error:", error); return comparisonFailure(error,reply); }
    finally {
      reply.dispose();
      for (const file of uploadedFiles) await import("node:fs").then(({ promises }) => promises.unlink(file.path).catch(() => undefined));
    }
  };

  const exportComparison = async (req: Request, res: Response) => {
    try {
      const exported = await generateComparisonReportExport(req.body?.results,req.body?.format);
      res.setHeader("Content-Type",exported.contentType);
      res.setHeader("Content-Disposition",`attachment; filename="comparison-results.${exported.extension}"`);
      res.setHeader("Cache-Control","no-store");
      return res.send(exported.buffer);
    } catch (error: any) {
      return res.status(error?.status === 400 ? 400 : 500).json({error:error?.status === 400 ? error.message : "The comparison report could not be exported. Please try again."});
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
    exportComparison,
    exportAccountability,
  };
}

export type AccountabilityController = ReturnType<
  typeof createAccountabilityController
>;
