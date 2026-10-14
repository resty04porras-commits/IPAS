
import { db } from "../postgres.js";

export type SettingInput = {
  settingKey: string;
  category?: string;
  settingValue: unknown;
  description?: string | null;
  updatedBy?: string | null;
};

const SENSITIVE_KEY_PATTERN =
  /password|secret|token|credential|private.?key|api.?key|connection.?string|database.?url|dsn/i;

const SETTING_KEY_PATTERN = /^[a-z][a-z0-9_.-]*$/;

function normalizeSettingKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Setting key must be a string.");
  }

  const key = value.trim();

  if (!key || key.length > 150 ||
      !SETTING_KEY_PATTERN.test(key)) {
    throw new Error("Invalid setting key.");
  }

  if (SENSITIVE_KEY_PATTERN.test(key)) {
    throw new Error(
      "Sensitive configuration keys are not allowed.",
    );
  }

  return key;
}

function normalizeCategory(value: unknown): string {
  const category = String(value ?? "general").trim();

  if (!category || category.length > 100) {
    throw new Error("Invalid setting category.");
  }

  return category;
}

function normalizeDescription(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const description = String(value).trim();
  return description || null;
}

function normalizeSettingValue(value: unknown): string {
  if (value === undefined) {
    throw new Error("Setting value is required.");
  }

  const serialized = JSON.stringify(value);

  if (serialized === undefined || serialized.length > 65536) {
    throw new Error("Invalid or oversized setting value.");
  }

  return serialized;
}

const SETTING_SELECT = `
  SELECT
    id,
    setting_key AS "settingKey",
    category,
    setting_value AS "settingValue",
    description,
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    updated_by AS "updatedBy"
  FROM system_settings
`;

export async function getSettings(category?: string) {
  const normalizedCategory =
    category === undefined
      ? null
      : normalizeCategory(category);

  const result = await db.query(
    `${SETTING_SELECT}
     WHERE ($1::text IS NULL OR category = $1)
     ORDER BY category ASC, setting_key ASC`,
    [normalizedCategory],
  );

  return result.rows;
}

export async function getSettingByKey(settingKey: string) {
  const key = normalizeSettingKey(settingKey);

  const result = await db.query(
    `${SETTING_SELECT}
     WHERE setting_key = $1
     LIMIT 1`,
    [key],
  );

  return result.rows[0] ?? null;
}

export async function createSetting(input: SettingInput) {
  const key = normalizeSettingKey(input.settingKey);
  const category = normalizeCategory(input.category);
  const value = normalizeSettingValue(input.settingValue);
  const description = normalizeDescription(input.description);

  const result = await db.query(
    `INSERT INTO system_settings (
       setting_key,
       category,
       setting_value,
       description,
       updated_by
     )
     VALUES ($1, $2, $3::jsonb, $4, $5::uuid)
     RETURNING setting_key`,
    [
      key,
      category,
      value,
      description,
      input.updatedBy ?? null,
    ],
  );

  return getSettingByKey(result.rows[0].setting_key);
}

export async function updateSetting(
  settingKey: string,
  input: SettingInput,
) {
  const key = normalizeSettingKey(settingKey);
  const inputKey = normalizeSettingKey(input.settingKey);

  if (key !== inputKey) {
    throw new Error("Setting key cannot be changed.");
  }

  const category = normalizeCategory(input.category);
  const value = normalizeSettingValue(input.settingValue);
  const description = normalizeDescription(input.description);

  const result = await db.query(
    `UPDATE system_settings
     SET category = $2,
         setting_value = $3::jsonb,
         description = $4,
         updated_by = $5::uuid,
         updated_at = NOW()
     WHERE setting_key = $1
     RETURNING setting_key`,
    [
      key,
      category,
      value,
      description,
      input.updatedBy ?? null,
    ],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return getSettingByKey(key);
}
