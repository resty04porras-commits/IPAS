import bcrypt from "bcryptjs";
import { db } from "../postgres.js";

export type UserInput = {
  id?: string;
  employeeId: string;
  name: string;
  email?: string | null;
  designation?: string | null;
  department?: string | null;
  baseOffice?: string | null;
  group?: string | null;
  division?: string | null;
  district?: string | null;
  remarks?: string | null;
  divisionId?: number | null;
  districtId?: number | null;
  role?: string;
  status?: string;
  photoURL?: string | null;
  signaturePath?: string | null;
  mustChangePassword?: boolean;
  uiSettings?: Record<string, unknown>;
  profileCustomization?: Record<string, unknown>;
};

function nullableText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function mapUser(row: any) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    name: row.name,
    email: row.email,
    designation: row.designation,
    department: row.department,
    baseOffice: row.baseOffice,
    group: row.group,
    division: row.division,
    district: row.district,
    remarks: row.remarks,
    divisionId: row.divisionId,
    districtId: row.districtId,
    role: row.role,
    status: row.status,
    photoURL: row.photoURL,
    signaturePath: row.signaturePath,
    mustChangePassword: row.mustChangePassword,
    uiSettings: row.uiSettings || {},
    profileCustomization: row.profileCustomization || {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt,
  };
}

export async function findPublicUserById(id: string) {
  const user = await findUserById(id);

  if (!user) {
    return null;
  }

  return mapUser(user);
}

const USER_SELECT = `
  SELECT
    id,
    employee_id AS "employeeId",
    name,
    email,
    designation,
    department,
    base_office AS "baseOffice",
    user_group AS "group",
    division,
    district,
    remarks,
    division_id AS "divisionId",
    district_id AS "districtId",
    role,
    status,
    password_hash AS "passwordHash",
    must_change_password AS "mustChangePassword",
    photo_url AS "photoURL",
    signature_path AS "signaturePath",
    ui_settings AS "uiSettings",
    profile_customization AS "profileCustomization",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    last_login_at AS "lastLoginAt"
  FROM users
`;

export async function getUsers() {
  const result = await db.query(
    `${USER_SELECT} ORDER BY name ASC, employee_id ASC`,
  );

  return result.rows.map(mapUser);
}

export async function findUserByEmployeeId(employeeId: string) {
  const normalizedEmployeeId = String(employeeId ?? "").trim();

  if (!normalizedEmployeeId) {
    return null;
  }

  const result = await db.query(
    `${USER_SELECT} WHERE employee_id = $1 LIMIT 1`,
    [normalizedEmployeeId],
  );

  return result.rows[0] || null;
}

export async function findUserById(id: string) {
  const normalizedId = String(id ?? "").trim();

  if (!normalizedId) {
    return null;
  }

  const result = await db.query(
    `${USER_SELECT} WHERE id = $1::uuid LIMIT 1`,
    [normalizedId],
  );

  return result.rows[0] || null;
}

export async function verifyUserPassword(
  user: any,
  password: string,
): Promise<boolean> {
  if (!user?.passwordHash || typeof password !== "string") {
    return false;
  }

  return bcrypt.compare(password, user.passwordHash);
}

export async function hashPassword(password: string): Promise<string> {
  if (!password || typeof password !== "string") {
    throw new Error("Password is required.");
  }

  return bcrypt.hash(password, 12);
}

export async function createUser(
  input: UserInput,
  initialPassword = "1234",
) {
  if (!input.employeeId?.trim()) {
    throw new Error("Employee ID is required.");
  }

  if (!input.name?.trim()) {
    throw new Error("User name is required.");
  }

  const passwordHash = await hashPassword(initialPassword);

  const result = await db.query(
    `
      INSERT INTO users (
        employee_id,
        name,
        email,
        designation,
        department,
        base_office,
        user_group,
        division,
        district,
        remarks,
        division_id,
        district_id,
        role,
        status,
        password_hash,
        must_change_password,
        photo_url,
        signature_path,
        ui_settings,
        profile_customization
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18,
        $19::jsonb, $20::jsonb
      )
      RETURNING id
    `,
    [
      input.employeeId.trim(),
      input.name.trim(),
      nullableText(input.email),
      nullableText(input.designation),
      nullableText(input.department),
      nullableText(input.baseOffice),
      nullableText(input.group),
      nullableText(input.division),
      nullableText(input.district),
      nullableText(input.remarks),
      input.divisionId ?? null,
      input.districtId ?? null,
      input.role || "USER",
      input.status || "Active",
      passwordHash,
      input.mustChangePassword ?? true,
      nullableText(input.photoURL),
      nullableText(input.signaturePath),
      JSON.stringify(input.uiSettings || {}),
      JSON.stringify(input.profileCustomization || {}),
    ],
  );

  return findPublicUserById(result.rows[0].id);
}

export async function updateUser(input: UserInput) {
  if (!input.id?.trim()) {
    throw new Error("User ID is required.");
  }

  if (!input.employeeId?.trim()) {
    throw new Error("Employee ID is required.");
  }

  if (!input.name?.trim()) {
    throw new Error("User name is required.");
  }

  const result = await db.query(
    `
      UPDATE users
      SET
        employee_id = $2,
        name = $3,
        email = $4,
        designation = $5,
        department = $6,
        base_office = $7,
        user_group = $8,
        division = $9,
        district = $10,
        remarks = $11,
        division_id = $12,
        district_id = $13,
        role = $14,
        status = $15,
        photo_url = $16,
        signature_path = $17,
        ui_settings = $18::jsonb,
        profile_customization = $19::jsonb,
        updated_at = NOW()
      WHERE id = $1::uuid
      RETURNING id
    `,
    [
      input.id.trim(),
      input.employeeId.trim(),
      input.name.trim(),
      nullableText(input.email),
      nullableText(input.designation),
      nullableText(input.department),
      nullableText(input.baseOffice),
      nullableText(input.group),
      nullableText(input.division),
      nullableText(input.district),
      nullableText(input.remarks),
      input.divisionId ?? null,
      input.districtId ?? null,
      input.role || "USER",
      input.status || "Active",
      nullableText(input.photoURL),
      nullableText(input.signaturePath),
      JSON.stringify(input.uiSettings || {}),
      JSON.stringify(input.profileCustomization || {}),
    ],
  );

  if (!result.rowCount) {
    return null;
  }

  return findPublicUserById(result.rows[0].id);
}

export async function changeUserPassword(
  employeeId: string,
  newPassword: string,
) {
  const passwordHash = await hashPassword(newPassword);

  const result = await db.query(
    `
      UPDATE users
      SET
        password_hash = $2,
        must_change_password = FALSE,
        updated_at = NOW()
      WHERE employee_id = $1
      RETURNING id
    `,
    [employeeId.trim(), passwordHash],
  );

  return Boolean(result.rowCount);
}

export async function updateUserProfile(
  id: string,
  values: {
    photoURL?: string | null;
    uiSettings?: Record<string, unknown>;
    profileCustomization?: Record<string, unknown>;
  },
) {
  const current = await findUserById(id);

  if (!current) {
    return null;
  }

  const result = await db.query(
    `
      UPDATE users
      SET
        photo_url = $2,
        ui_settings = $3::jsonb,
        profile_customization = $4::jsonb,
        updated_at = NOW()
      WHERE id = $1::uuid
      RETURNING id
    `,
    [
      id,
      values.photoURL !== undefined
        ? nullableText(values.photoURL)
        : current.photoURL,
      JSON.stringify(
        values.uiSettings !== undefined
          ? values.uiSettings
          : current.uiSettings || {},
      ),
      JSON.stringify(
        values.profileCustomization !== undefined
          ? values.profileCustomization
          : current.profileCustomization || {},
      ),
    ],
  );

  return findUserById(result.rows[0].id);
}

export async function markUserLogin(id: string) {
  await db.query(
    `
      UPDATE users
      SET last_login_at = NOW()
      WHERE id = $1::uuid
    `,
    [id],
  );
}