import type { Request, Response } from "express";
import { writeAuditLog } from "./auditHelper.js";

type CompareSourceFile = {
  name: string;
  kind: "excel" | "pdf" | "image";
  contentType: "text" | "inlineData";
  content: string;
  mimeType: string;
};

type LiquidationRecord = {
  sourceName: string;
  transactionDate: string;
  time: string;
  from: string;
  to: string;
  modeOfTransportation: string;
  amount: string;
  perDiem: string;
  breakfast: string;
  lunch: string;
  dinner: string;
  others: string;
  remarks: string;
  notes?: string;
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


type LiquidationFormPayload = {
  employeeName: string;
  reportDate: string;
  designation: string;
  base: string;
  purpose: string;
  cashAdvance: string;
  preparedByName: string;
  preparedByTitle: string;
  checkedByName: string;
  checkedByTitle: string;
  reviewedByName: string;
  reviewedByTitle: string;
  notedByName: string;
  notedByTitle: string;
  approvedByName: string;
  approvedByTitle: string;
  items: LiquidationRecord[];
  preparedBySignature?: string;
};

type LiquidationExportFormat = "xlsx" | "pdf";

import {
  getTravelEntries,
  upsertTravelEntry,
  type TerTravelEntryInput,
} from "../database/repositories/terRepository.js";

function sanitizeTerId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const clean = raw
    .replace(/[^a-zA-Z0-9:_@./ -]+/g, "")
    .slice(0, 160)
    .trim();

  return clean || "ter:shared";
}

function cleanText(value: unknown, maxLength?: number): string | undefined {
  if (typeof value !== "string") return undefined;

  const cleaned = value.trim();

  if (!cleaned) return undefined;

  return typeof maxLength === "number"
    ? cleaned.slice(0, maxLength)
    : cleaned;
}

function cleanNumber(value: unknown): string | number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();

    if (cleaned && Number.isFinite(Number(cleaned))) {
      return cleaned;
    }
  }

  return 0;
}

function sanitizeTravelEntry(
  terId: string,
  value: unknown,
): TerTravelEntryInput {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  const rawId =
    typeof raw.id === "string"
      ? raw.id.trim()
      : "";

  return {
    id: rawId.slice(0, 160) || crypto.randomUUID(),
    terId,

    sourceName: cleanText(raw.sourceName),
    transactionDate: cleanText(raw.transactionDate),
    time: cleanText(raw.time, 30),
    from: cleanText(raw.from),
    to: cleanText(raw.to),
    modeOfTransportation: cleanText(raw.modeOfTransportation, 150),

    amount: cleanNumber(raw.amount),
    perDiem: cleanNumber(raw.perDiem),
    breakfast: cleanNumber(raw.breakfast),
    lunch: cleanNumber(raw.lunch),
    dinner: cleanNumber(raw.dinner),
    others: cleanNumber(raw.others),

    remarks: cleanText(raw.remarks),
    notes: cleanText(raw.notes),

    ticketFileName: cleanText(raw.ticketFileName, 240),
    ticketMimeType: cleanText(raw.ticketMimeType, 120),
    ticketStoragePath: cleanText(raw.ticketStoragePath),
  };
}

function formatApiDate(value: unknown): string {
  if (!value) return "";

  const date = value instanceof Date
    ? value
    : new Date(String(value));

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatApiNumber(
  value: unknown,
  blankWhenZero = false,
): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return String(value);
  }

  if (blankWhenZero && number === 0) {
    return "";
  }

  return String(number);
}

function toLegacyApiEntry(entry: any) {
  return {
    sourceName: entry.sourceName ?? "",
    transactionDate: formatApiDate(entry.transactionDate),
    time: entry.time ?? "",
    from: entry.from ?? "",
    to: entry.to ?? "",
    modeOfTransportation: entry.modeOfTransportation ?? "",
    amount: formatApiNumber(entry.amount),
    perDiem: formatApiNumber(entry.perDiem, true),
    breakfast: formatApiNumber(entry.breakfast, true),
    lunch: formatApiNumber(entry.lunch, true),
    dinner: formatApiNumber(entry.dinner, true),
    others: formatApiNumber(entry.others, true),
    remarks: entry.remarks ?? "",
    notes: entry.notes ?? "",
    id: entry.id,
    terId: entry.terId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ticketFileName: entry.ticketFileName ?? "",
    ticketMimeType: entry.ticketMimeType ?? "",
  };
}

export async function saveTerTravelEntry(
  req: Request,
  res: Response,
) {
  try {
    const body = req.body as
      | { terId?: unknown; entry?: unknown }
      | undefined;

    const terId = sanitizeTerId(body?.terId);
    const entry = sanitizeTravelEntry(terId, body?.entry);

    const savedEntry = await upsertTravelEntry(entry);

    await writeAuditLog(req, {
      action: "TER_ENTRY_SAVED",
      entityType: "ter_travel_entry",
      entityId: savedEntry.id,
      details: {
        terId: savedEntry.terId,
      },
    });

    return res.status(200).json({
      entry: toLegacyApiEntry(savedEntry),
    });
  } catch (error: any) {
    console.error("TER PostgreSQL travel entry save error:", error);

    return res.status(500).json({
      error:
        error?.message ||
        "Failed to save the TER travel entry.",
    });
  }
}

export async function loadTerTravelEntries(
  req: Request,
  res: Response,
) {
  try {
    const terId = sanitizeTerId(req.query.terId);

    const entries = await getTravelEntries(terId);

    return res.status(200).json({
      terId,
      entries: entries.map(toLegacyApiEntry),
      updatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("TER PostgreSQL travel entries load error:", error);

    return res.status(500).json({
      error:
        error?.message ||
        "Failed to load TER travel entries.",
    });
  }
}

export type TerLiquidationControllerDependencies = {
  prepareUploadedFileForComparison: (
    file: Express.Multer.File,
  ) => Promise<CompareSourceFile>;
  extractLiquidationRecordsFromEvidence: (
    evidenceFiles: CompareSourceFile[],
  ) => Promise<LiquidationExtractionResponse>;
  isInvalidStructuredResponse: (error: unknown) => boolean;
  isGeminiUnavailable: (error: any) => boolean;
  extractUpstreamErrorMessage: (error: any) => string;
  sanitizeLiquidationPayload: (
    payload: Partial<LiquidationFormPayload> | undefined,
  ) => LiquidationFormPayload;
  getLiquidationExportFormat: (
    value: unknown,
  ) => LiquidationExportFormat;
  generateLiquidationExport: (
    payload: LiquidationFormPayload,
    format: LiquidationExportFormat,
  ) => Promise<{
    buffer: Buffer;
    contentType: string;
    extension: LiquidationExportFormat;
  }>;
};

export function createTerLiquidationController(
  dependencies: TerLiquidationControllerDependencies,
) {
  const {
    prepareUploadedFileForComparison,
    extractLiquidationRecordsFromEvidence,
    isInvalidStructuredResponse,
    isGeminiUnavailable,
    extractUpstreamErrorMessage,
    sanitizeLiquidationPayload,
    getLiquidationExportFormat,
    generateLiquidationExport,
  } = dependencies;

  const extractLiquidation = async (req: Request, res: Response) => {
    const files = (((req as any).files || []) as Express.Multer.File[])
      .filter(Boolean);

    if (files.length === 0) {
      return res.status(400).json({
        error: "At least one receipt image is required.",
      });
    }

    try {
      const preparedEvidence = await Promise.all(
        files.map(prepareUploadedFileForComparison),
      );
      const extraction =
        await extractLiquidationRecordsFromEvidence(preparedEvidence);

      return res.json(extraction);
    } catch (error: any) {
      console.error("Liquidation extraction error:", error);

      if (isInvalidStructuredResponse(error)) {
        return res.status(502).json({
          error:
            "The liquidation extraction service returned incomplete structured data. Please scan the receipt again.",
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
            "Liquidation extraction is temporarily busy. Please try again in a moment.",
        });
      }

      return res.status(500).json({
        error:
          extractUpstreamErrorMessage(error) ||
          "Failed to extract liquidation receipt details.",
      });
    } finally {
      const { promises } = await import("node:fs");
      for (const file of files) {
        await promises.unlink(file.path).catch(() => undefined);
      }
    }
  };

  const exportLiquidation = async (req: Request, res: Response) => {
    try {
      const payload = sanitizeLiquidationPayload(
        req.body as Partial<LiquidationFormPayload>,
      );
      const format = getLiquidationExportFormat(
        (req.body as { format?: string } | undefined)?.format,
      );

      if (!payload.items.length) {
        return res.status(400).json({
          error: "At least one liquidation row is required before export.",
        });
      }

      const exportedFile = await generateLiquidationExport(payload, format);

      const fileNameSuffix = (payload.employeeName || "liquidation-form")
        .trim()
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase() || "liquidation-form";

      res.setHeader("Content-Type", exportedFile.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileNameSuffix}-liquidation-form.${exportedFile.extension}"`,
      );

      return res.send(exportedFile.buffer);
    } catch (error: any) {
      console.error("Liquidation export error:", error);

      return res.status(500).json({
        error:
          error?.message ||
          "Failed to generate the liquidation form.",
      });
    }
  };

  return {
    extractLiquidation,
    exportLiquidation,
  };
}
