import type { PoolClient } from "pg";
import { db } from "../postgres.js";

export type AccountabilityItemInput = {
  assetId?: string | null;
  sourceName?: string;
  components?: string;
  description?: string;
  hardwareId?: string;
  serial?: string;
  remarks?: string;
  notes?: string;
};

export type AccountabilityFormInput = {
  employeeId?: string;
  employeeName: string;
  designation?: string;
  department?: string;
  effectiveDate?: string;

  // Store only an existing file/storage path here.
  // Do not store base64 signature data in this field.
  signaturePath?: string;

  processedBy?: string;
  processedDate?: string;

  checkedBy?: string;
  checkedDate?: string;

  verifiedBy?: string;
  verifiedTitle?: string;
  verifiedDate?: string;

  notedBy?: string;
  notedTitle?: string;
  notedDate?: string;

  status?: string;
  createdBy?: string | null;

  items?: AccountabilityItemInput[];
};

function nullableText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function nullableUuid(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeStatus(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized || "draft";
}

const formSelect = `
  SELECT
    af.id,
    af.employee_id AS "employeeId",
    af.employee_name AS "employeeName",
    af.designation,
    af.department,
    af.effective_date AS "effectiveDate",
    af.signature_path AS "signaturePath",
    af.processed_by AS "processedBy",
    af.processed_date AS "processedDate",
    af.checked_by AS "checkedBy",
    af.checked_date AS "checkedDate",
    af.verified_by AS "verifiedBy",
    af.verified_title AS "verifiedTitle",
    af.verified_date AS "verifiedDate",
    af.noted_by AS "notedBy",
    af.noted_title AS "notedTitle",
    af.noted_date AS "notedDate",
    af.status,
    af.created_by AS "createdBy",
    af.created_at AS "createdAt",
    af.updated_at AS "updatedAt"
  FROM accountability_forms af
`;

async function getItems(
  accountabilityId: string,
  client: PoolClient | typeof db = db,
) {
  const result = await client.query(
    `
      SELECT
        id,
        accountability_id AS "accountabilityId",
        asset_id AS "assetId",
        source_name AS "sourceName",
        component AS "components",
        description,
        hardware_id AS "hardwareId",
        serial_number AS "serial",
        remarks,
        notes,
        created_at AS "createdAt"
      FROM accountability_items
      WHERE accountability_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [accountabilityId],
  );

  return result.rows;
}

async function getFormByIdWithClient(
  id: string,
  client: PoolClient | typeof db = db,
) {
  const result = await client.query(
    `${formSelect}
     WHERE af.id = $1`,
    [id],
  );

  const form = result.rows[0];

  if (!form) {
    return null;
  }

  const items = await getItems(id, client);

  return {
    ...form,
    items,
  };
}

async function insertItems(
  client: PoolClient,
  accountabilityId: string,
  items: AccountabilityItemInput[],
): Promise<void> {
  for (const item of items) {
    await client.query(
      `
        INSERT INTO accountability_items (
          accountability_id,
          asset_id,
          source_name,
          component,
          description,
          hardware_id,
          serial_number,
          remarks,
          notes
        )
        VALUES (
          $1,
          $2::uuid,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9
        )
      `,
      [
        accountabilityId,
        nullableUuid(item.assetId),
        nullableText(item.sourceName),
        nullableText(item.components),
        nullableText(item.description),
        nullableText(item.hardwareId),
        nullableText(item.serial),
        nullableText(item.remarks),
        nullableText(item.notes),
      ],
    );
  }
}

export async function getAccountabilityForms() {
  const result = await db.query(
    `${formSelect}
     ORDER BY af.created_at DESC`,
  );

  const forms = [];

  for (const form of result.rows) {
    forms.push({
      ...form,
      items: await getItems(form.id),
    });
  }

  return forms;
}

export async function getAccountabilityFormById(id: string) {
  return getFormByIdWithClient(id);
}

export async function createAccountabilityForm(
  input: AccountabilityFormInput,
) {
  const employeeName = String(input.employeeName ?? "").trim();

  if (!employeeName) {
    throw new Error("Employee name is required.");
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        INSERT INTO accountability_forms (
          employee_id,
          employee_name,
          designation,
          department,
          effective_date,
          signature_path,
          processed_by,
          processed_date,
          checked_by,
          checked_date,
          verified_by,
          verified_title,
          verified_date,
          noted_by,
          noted_title,
          noted_date,
          status,
          created_by
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          NULLIF($5, '')::date,
          $6,
          $7,
          NULLIF($8, '')::date,
          $9,
          NULLIF($10, '')::date,
          $11,
          $12,
          NULLIF($13, '')::date,
          $14,
          $15,
          NULLIF($16, '')::date,
          $17,
          $18::uuid
        )
        RETURNING id
      `,
      [
        nullableText(input.employeeId),
        employeeName,
        nullableText(input.designation),
        nullableText(input.department),
        nullableText(input.effectiveDate),
        nullableText(input.signaturePath),
        nullableText(input.processedBy),
        nullableText(input.processedDate),
        nullableText(input.checkedBy),
        nullableText(input.checkedDate),
        nullableText(input.verifiedBy),
        nullableText(input.verifiedTitle),
        nullableText(input.verifiedDate),
        nullableText(input.notedBy),
        nullableText(input.notedTitle),
        nullableText(input.notedDate),
        normalizeStatus(input.status),
        nullableUuid(input.createdBy),
      ],
    );

    const id = result.rows[0].id as string;

    await insertItems(client, id, input.items ?? []);

    const created = await getFormByIdWithClient(id, client);

    await client.query("COMMIT");

    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateAccountabilityForm(
  id: string,
  input: AccountabilityFormInput,
) {
  const employeeName = String(input.employeeName ?? "").trim();

  if (!employeeName) {
    throw new Error("Employee name is required.");
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        UPDATE accountability_forms
        SET
          employee_id = $2,
          employee_name = $3,
          designation = $4,
          department = $5,
          effective_date = NULLIF($6, '')::date,
          signature_path = $7,
          processed_by = $8,
          processed_date = NULLIF($9, '')::date,
          checked_by = $10,
          checked_date = NULLIF($11, '')::date,
          verified_by = $12,
          verified_title = $13,
          verified_date = NULLIF($14, '')::date,
          noted_by = $15,
          noted_title = $16,
          noted_date = NULLIF($17, '')::date,
          status = $18,
          updated_at = NOW()
        WHERE id = $1
        RETURNING id
      `,
      [
        id,
        nullableText(input.employeeId),
        employeeName,
        nullableText(input.designation),
        nullableText(input.department),
        nullableText(input.effectiveDate),
        nullableText(input.signaturePath),
        nullableText(input.processedBy),
        nullableText(input.processedDate),
        nullableText(input.checkedBy),
        nullableText(input.checkedDate),
        nullableText(input.verifiedBy),
        nullableText(input.verifiedTitle),
        nullableText(input.verifiedDate),
        nullableText(input.notedBy),
        nullableText(input.notedTitle),
        nullableText(input.notedDate),
        normalizeStatus(input.status),
      ],
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `
        DELETE FROM accountability_items
        WHERE accountability_id = $1
      `,
      [id],
    );

    await insertItems(client, id, input.items ?? []);

    const updated = await getFormByIdWithClient(id, client);

    await client.query("COMMIT");

    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteAccountabilityForm(id: string) {
  const result = await db.query(
    `
      DELETE FROM accountability_forms
      WHERE id = $1
      RETURNING id
    `,
    [id],
  );

  return result.rows[0] ?? null;
}