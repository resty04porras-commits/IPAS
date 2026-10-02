import type { Request, Response } from "express";
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
