import { db } from "../postgres.js";

export type AuditLogInput = {
  userId?: string | null;
  employeeId?: string | null;
  actorName?: string | null;

  action: string;

  entityType?: string | null;
  entityId?: string | null;

  details?: Record<string, unknown> | null;
  ipAddress?: string | null;
};

export type AuditLogQuery = {
  userId?: string;
  employeeId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;

  limit?: number;
  offset?: number;
};

function nullableText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function nullableUuid(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeRequiredText(value: unknown, fieldName: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }

  return normalized;
}

function normalizeDetails(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function normalizeLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return 100;
  }

  const normalized = Number(value);

  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error("Limit must be a positive integer.");
  }

  return Math.min(normalized, 500);
}

function normalizeOffset(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const normalized = Number(value);

  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error("Offset must be a non-negative integer.");
  }

  return normalized;
}

const auditLogSelect = `
  SELECT
    a.id,
    a.user_id AS "userId",
    a.employee_id AS "employeeId",
    a.actor_name AS "actorName",
    a.action,
    a.entity_type AS "entityType",
    a.entity_id AS "entityId",
    a.details,
    a.ip_address::text AS "ipAddress",
    a.created_at AS "createdAt"
  FROM audit_logs a
`;

export async function getAuditLogs(query: AuditLogQuery = {}) {
  const conditions: string[] = [];
  const values: unknown[] = [];

  const addCondition = (sql: string, value: unknown) => {
    values.push(value);
    conditions.push(sql.replace("?", `$${values.length}`));
  };

  if (query.userId) {
    addCondition("a.user_id = ?::uuid", query.userId);
  }

  if (query.employeeId) {
    addCondition("a.employee_id = ?", query.employeeId);
  }

  if (query.action) {
    addCondition("a.action = ?", query.action);
  }

  if (query.entityType) {
    addCondition("a.entity_type = ?", query.entityType);
  }

  if (query.entityId) {
    addCondition("a.entity_id = ?", query.entityId);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const limit = normalizeLimit(query.limit);
  const offset = normalizeOffset(query.offset);

  values.push(limit);
  const limitParameter = `$${values.length}`;

  values.push(offset);
  const offsetParameter = `$${values.length}`;

  const result = await db.query(
    `
      ${auditLogSelect}
      ${whereClause}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limitParameter}
      OFFSET ${offsetParameter}
    `,
    values,
  );

  return result.rows;
}

export async function getAuditLogById(id: number | string) {
  const normalizedId = Number(id);

  if (!Number.isInteger(normalizedId) || normalizedId < 1) {
    throw new Error("Audit log ID must be a positive integer.");
  }

  const result = await db.query(
    `
      ${auditLogSelect}
      WHERE a.id = $1
    `,
    [normalizedId],
  );

  return result.rows[0] ?? null;
}

export async function createAuditLog(input: AuditLogInput) {
  const action = normalizeRequiredText(input.action, "Action");

  const result = await db.query(
    `
      INSERT INTO audit_logs (
        user_id,
        employee_id,
        actor_name,
        action,
        entity_type,
        entity_id,
        details,
        ip_address
      )
      VALUES (
        $1::uuid,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7::jsonb,
        $8::inet
      )
      RETURNING id
    `,
    [
      nullableUuid(input.userId),
      nullableText(input.employeeId),
      nullableText(input.actorName),
      action,
      nullableText(input.entityType),
      nullableText(input.entityId),
      JSON.stringify(normalizeDetails(input.details)),
      nullableText(input.ipAddress),
    ],
  );

  return getAuditLogById(result.rows[0].id);
}