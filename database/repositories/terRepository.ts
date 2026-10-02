import { db } from "../postgres.js";

export type TerTravelEntryInput = {
  id: string;
  terId: string;
  sourceName?: string;
  transactionDate?: string;
  time?: string;
  from?: string;
  to?: string;
  modeOfTransportation?: string;
  amount?: string | number;
  perDiem?: string | number;
  breakfast?: string | number;
  lunch?: string | number;
  dinner?: string | number;
  others?: string | number;
  remarks?: string;
  notes?: string;
  ticketFileName?: string;
  ticketMimeType?: string;
  ticketStoragePath?: string;
};

function numericValue(value: string | number | undefined): number {
  if (value === undefined || value === null || value === "") return 0;

  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/,/g, ""));

  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableText(value: string | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export async function getTravelEntries(terId: string) {
  const result = await db.query(
    `
      SELECT
        id,
        travel_report_id AS "travelReportId",
        ter_id AS "terId",
        source_name AS "sourceName",
        transaction_date AS "transactionDate",
        transaction_time AS "time",
        origin AS "from",
        destination AS "to",
        mode_of_transportation AS "modeOfTransportation",
        amount,
        per_diem AS "perDiem",
        breakfast,
        lunch,
        dinner,
        others,
        remarks,
        notes,
        ticket_file_name AS "ticketFileName",
        ticket_mime_type AS "ticketMimeType",
        ticket_storage_path AS "ticketStoragePath",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM travel_entries
      WHERE ter_id = $1
      ORDER BY transaction_date ASC NULLS LAST, created_at ASC
    `,
    [terId],
  );

  return result.rows;
}

export async function upsertTravelEntry(entry: TerTravelEntryInput) {
  if (!entry.id?.trim()) {
    throw new Error("Travel entry id is required.");
  }

  if (!entry.terId?.trim()) {
    throw new Error("TER id is required.");
  }

  const result = await db.query(
    `
      INSERT INTO travel_entries (
        id,
        ter_id,
        source_name,
        transaction_date,
        transaction_time,
        origin,
        destination,
        mode_of_transportation,
        amount,
        per_diem,
        breakfast,
        lunch,
        dinner,
        others,
        remarks,
        notes,
        ticket_file_name,
        ticket_mime_type,
        ticket_storage_path
      )
      VALUES (
        $1, $2, $3, NULLIF($4, '')::date, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19
      )
      ON CONFLICT (id)
      DO UPDATE SET
        ter_id = EXCLUDED.ter_id,
        source_name = EXCLUDED.source_name,
        transaction_date = EXCLUDED.transaction_date,
        transaction_time = EXCLUDED.transaction_time,
        origin = EXCLUDED.origin,
        destination = EXCLUDED.destination,
        mode_of_transportation = EXCLUDED.mode_of_transportation,
        amount = EXCLUDED.amount,
        per_diem = EXCLUDED.per_diem,
        breakfast = EXCLUDED.breakfast,
        lunch = EXCLUDED.lunch,
        dinner = EXCLUDED.dinner,
        others = EXCLUDED.others,
        remarks = EXCLUDED.remarks,
        notes = EXCLUDED.notes,
        ticket_file_name = EXCLUDED.ticket_file_name,
        ticket_mime_type = EXCLUDED.ticket_mime_type,
        ticket_storage_path = EXCLUDED.ticket_storage_path,
        updated_at = NOW()
      RETURNING
        id,
        travel_report_id AS "travelReportId",
        ter_id AS "terId",
        source_name AS "sourceName",
        transaction_date AS "transactionDate",
        transaction_time AS "time",
        origin AS "from",
        destination AS "to",
        mode_of_transportation AS "modeOfTransportation",
        amount,
        per_diem AS "perDiem",
        breakfast,
        lunch,
        dinner,
        others,
        remarks,
        notes,
        ticket_file_name AS "ticketFileName",
        ticket_mime_type AS "ticketMimeType",
        ticket_storage_path AS "ticketStoragePath",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
    [
      entry.id.trim(),
      entry.terId.trim(),
      nullableText(entry.sourceName),
      nullableText(entry.transactionDate),
      nullableText(entry.time),
      nullableText(entry.from),
      nullableText(entry.to),
      nullableText(entry.modeOfTransportation),
      numericValue(entry.amount),
      numericValue(entry.perDiem),
      numericValue(entry.breakfast),
      numericValue(entry.lunch),
      numericValue(entry.dinner),
      numericValue(entry.others),
      nullableText(entry.remarks),
      nullableText(entry.notes),
      nullableText(entry.ticketFileName),
      nullableText(entry.ticketMimeType),
      nullableText(entry.ticketStoragePath),
    ],
  );

  return result.rows[0];
}
