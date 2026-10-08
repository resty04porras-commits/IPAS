import { db } from "../postgres.js";

export type DocumentInput = {
  documentType?: string;
  category?: string;

  originalFilename: string;
  storedFilename?: string;

  mimeType?: string;
  fileSize?: number | null;

  storageProvider?: string;
  storagePath?: string;

  nextcloudPath?: string;
  nextcloudUrl?: string;

  accountabilityId?: string | null;
  travelReportId?: string | null;
  uploadedBy?: string | null;

  status?: string;
  metadata?: Record<string, unknown> | null;
};

function nullableText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function nullableUuid(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeStorageProvider(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized || "local";
}

function normalizeStatus(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized || "active";
}

function normalizeFileSize(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = Number(value);

  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error("File size must be a non-negative number.");
  }

  return Math.trunc(normalized);
}

function normalizeMetadata(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

const documentSelect = `
  SELECT
    d.id,
    d.document_type AS "documentType",
    d.category,
    d.original_filename AS "originalFilename",
    d.stored_filename AS "storedFilename",
    d.mime_type AS "mimeType",
    d.file_size AS "fileSize",
    d.storage_provider AS "storageProvider",
    d.storage_path AS "storagePath",
    d.nextcloud_path AS "nextcloudPath",
    d.nextcloud_url AS "nextcloudUrl",
    d.accountability_id AS "accountabilityId",
    d.travel_report_id AS "travelReportId",
    d.uploaded_by AS "uploadedBy",
    d.uploaded_at AS "uploadedAt",
    d.status,
    d.metadata
  FROM documents d
`;

export async function getDocuments() {
  const result = await db.query(
    `${documentSelect}
     ORDER BY d.uploaded_at DESC, d.id DESC`,
  );

  return result.rows;
}

export async function getDocumentById(id: string) {
  const result = await db.query(
    `${documentSelect}
     WHERE d.id = $1`,
    [id],
  );

  return result.rows[0] ?? null;
}

export async function createDocument(input: DocumentInput) {
  const originalFilename = String(input.originalFilename ?? "").trim();

  if (!originalFilename) {
    throw new Error("Original filename is required.");
  }

  const result = await db.query(
    `
      INSERT INTO documents (
        document_type,
        category,
        original_filename,
        stored_filename,
        mime_type,
        file_size,
        storage_provider,
        storage_path,
        nextcloud_path,
        nextcloud_url,
        accountability_id,
        travel_report_id,
        uploaded_by,
        status,
        metadata
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11::uuid,
        $12::uuid,
        $13::uuid,
        $14,
        $15::jsonb
      )
      RETURNING id
    `,
    [
      nullableText(input.documentType),
      nullableText(input.category),
      originalFilename,
      nullableText(input.storedFilename),
      nullableText(input.mimeType),
      normalizeFileSize(input.fileSize),
      normalizeStorageProvider(input.storageProvider),
      nullableText(input.storagePath),
      nullableText(input.nextcloudPath),
      nullableText(input.nextcloudUrl),
      nullableUuid(input.accountabilityId),
      nullableUuid(input.travelReportId),
      nullableUuid(input.uploadedBy),
      normalizeStatus(input.status),
      JSON.stringify(normalizeMetadata(input.metadata)),
    ],
  );

  return getDocumentById(result.rows[0].id as string);
}

export async function updateDocument(
  id: string,
  input: DocumentInput,
) {
  const originalFilename = String(input.originalFilename ?? "").trim();

  if (!originalFilename) {
    throw new Error("Original filename is required.");
  }

  const result = await db.query(
    `
      UPDATE documents
      SET
        document_type = $2,
        category = $3,
        original_filename = $4,
        stored_filename = $5,
        mime_type = $6,
        file_size = $7,
        storage_provider = $8,
        storage_path = $9,
        nextcloud_path = $10,
        nextcloud_url = $11,
        accountability_id = $12::uuid,
        travel_report_id = $13::uuid,
        uploaded_by = $14::uuid,
        status = $15,
        metadata = $16::jsonb
      WHERE id = $1
      RETURNING id
    `,
    [
      id,
      nullableText(input.documentType),
      nullableText(input.category),
      originalFilename,
      nullableText(input.storedFilename),
      nullableText(input.mimeType),
      normalizeFileSize(input.fileSize),
      normalizeStorageProvider(input.storageProvider),
      nullableText(input.storagePath),
      nullableText(input.nextcloudPath),
      nullableText(input.nextcloudUrl),
      nullableUuid(input.accountabilityId),
      nullableUuid(input.travelReportId),
      nullableUuid(input.uploadedBy),
      normalizeStatus(input.status),
      JSON.stringify(normalizeMetadata(input.metadata)),
    ],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return getDocumentById(id);
}

export async function deleteDocument(id: string) {
  const result = await db.query(
    `
      DELETE FROM documents
      WHERE id = $1
      RETURNING id
    `,
    [id],
  );

  return result.rows[0] ?? null;
}