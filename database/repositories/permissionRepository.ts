import { db } from "../postgres.js";

export type RoleInput = {
  roleCode: string;
  roleName: string;
  description?: string | null;
  active?: boolean;
};

export type PermissionInput = {
  permissionCode: string;
  permissionName: string;
  description?: string | null;
};

function nullableText(value: unknown): string | null {
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

function normalizeId(value: unknown, fieldName = "ID"): number {
  const normalized = Number(value);

  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return normalized;
}

function normalizePermissionIds(values: unknown[]): number[] {
  return [
    ...new Set(
      (values ?? []).map((value) =>
        normalizeId(value, "Permission ID"),
      ),
    ),
  ];
}

const ROLE_SELECT = `
  SELECT
    id,
    role_code AS "roleCode",
    role_name AS "roleName",
    description,
    active
  FROM roles
`;

const PERMISSION_SELECT = `
  SELECT
    id,
    permission_code AS "permissionCode",
    permission_name AS "permissionName",
    description
  FROM permissions
`;

export async function getRoles() {
  const result = await db.query(
    `${ROLE_SELECT} ORDER BY id ASC`,
  );

  return result.rows;
}

export async function getRoleById(id: number) {
  const roleId = normalizeId(id, "Role ID");

  const result = await db.query(
    `${ROLE_SELECT} WHERE id = $1 LIMIT 1`,
    [roleId],
  );

  return result.rows[0] || null;
}

export async function getRoleByCode(roleCode: string) {
  const normalizedRoleCode = String(roleCode ?? "").trim();

  if (!normalizedRoleCode) {
    return null;
  }

  const result = await db.query(
    `${ROLE_SELECT} WHERE role_code = $1 LIMIT 1`,
    [normalizedRoleCode],
  );

  return result.rows[0] || null;
}

export async function createRole(input: RoleInput) {
  const roleCode = normalizeRequiredText(
    input.roleCode,
    "Role code",
  );

  const roleName = normalizeRequiredText(
    input.roleName,
    "Role name",
  );

  const result = await db.query(
    `
      INSERT INTO roles (
        role_code,
        role_name,
        description,
        active
      )
      VALUES ($1, $2, $3, $4)
      RETURNING
        id,
        role_code AS "roleCode",
        role_name AS "roleName",
        description,
        active
    `,
    [
      roleCode,
      roleName,
      nullableText(input.description),
      input.active ?? true,
    ],
  );

  return result.rows[0];
}

export async function updateRole(
  id: number,
  input: RoleInput,
) {
  const roleId = normalizeId(id, "Role ID");

  const roleCode = normalizeRequiredText(
    input.roleCode,
    "Role code",
  );

  const roleName = normalizeRequiredText(
    input.roleName,
    "Role name",
  );

  const result = await db.query(
    `
      UPDATE roles
      SET
        role_code = $2,
        role_name = $3,
        description = $4,
        active = $5
      WHERE id = $1
      RETURNING
        id,
        role_code AS "roleCode",
        role_name AS "roleName",
        description,
        active
    `,
    [
      roleId,
      roleCode,
      roleName,
      nullableText(input.description),
      input.active ?? true,
    ],
  );

  return result.rows[0] || null;
}

export async function deleteRole(id: number) {
  const roleId = normalizeId(id, "Role ID");

  const result = await db.query(
    `
      DELETE FROM roles
      WHERE id = $1
      RETURNING id
    `,
    [roleId],
  );

  return result.rows[0] || null;
}

export async function getPermissions() {
  const result = await db.query(
    `${PERMISSION_SELECT} ORDER BY id ASC`,
  );

  return result.rows;
}

export async function getPermissionById(id: number) {
  const permissionId = normalizeId(id, "Permission ID");

  const result = await db.query(
    `${PERMISSION_SELECT} WHERE id = $1 LIMIT 1`,
    [permissionId],
  );

  return result.rows[0] || null;
}

export async function getPermissionByCode(
  permissionCode: string,
) {
  const normalizedPermissionCode = String(
    permissionCode ?? "",
  ).trim();

  if (!normalizedPermissionCode) {
    return null;
  }

  const result = await db.query(
    `${PERMISSION_SELECT} WHERE permission_code = $1 LIMIT 1`,
    [normalizedPermissionCode],
  );

  return result.rows[0] || null;
}

export async function createPermission(
  input: PermissionInput,
) {
  const permissionCode = normalizeRequiredText(
    input.permissionCode,
    "Permission code",
  );

  const permissionName = normalizeRequiredText(
    input.permissionName,
    "Permission name",
  );

  const result = await db.query(
    `
      INSERT INTO permissions (
        permission_code,
        permission_name,
        description
      )
      VALUES ($1, $2, $3)
      RETURNING
        id,
        permission_code AS "permissionCode",
        permission_name AS "permissionName",
        description
    `,
    [
      permissionCode,
      permissionName,
      nullableText(input.description),
    ],
  );

  return result.rows[0];
}

export async function updatePermission(
  id: number,
  input: PermissionInput,
) {
  const permissionId = normalizeId(
    id,
    "Permission ID",
  );

  const permissionCode = normalizeRequiredText(
    input.permissionCode,
    "Permission code",
  );

  const permissionName = normalizeRequiredText(
    input.permissionName,
    "Permission name",
  );

  const result = await db.query(
    `
      UPDATE permissions
      SET
        permission_code = $2,
        permission_name = $3,
        description = $4
      WHERE id = $1
      RETURNING
        id,
        permission_code AS "permissionCode",
        permission_name AS "permissionName",
        description
    `,
    [
      permissionId,
      permissionCode,
      permissionName,
      nullableText(input.description),
    ],
  );

  return result.rows[0] || null;
}

export async function deletePermission(id: number) {
  const permissionId = normalizeId(
    id,
    "Permission ID",
  );

  const result = await db.query(
    `
      DELETE FROM permissions
      WHERE id = $1
      RETURNING id
    `,
    [permissionId],
  );

  return result.rows[0] || null;
}

export async function getRolePermissions(
  roleId: number,
) {
  const normalizedRoleId = normalizeId(
    roleId,
    "Role ID",
  );

  const result = await db.query(
    `
      SELECT
        p.id,
        p.permission_code AS "permissionCode",
        p.permission_name AS "permissionName",
        p.description
      FROM role_permissions rp
      INNER JOIN permissions p
        ON p.id = rp.permission_id
      WHERE rp.role_id = $1
      ORDER BY p.id ASC
    `,
    [normalizedRoleId],
  );

  return result.rows;
}

export async function getRolesWithPermissions() {
  const roles = await getRoles();

  if (roles.length === 0) {
    return [];
  }

  const result = await db.query(
    `
      SELECT
        rp.role_id AS "roleId",
        p.id,
        p.permission_code AS "permissionCode",
        p.permission_name AS "permissionName",
        p.description
      FROM role_permissions rp
      INNER JOIN permissions p
        ON p.id = rp.permission_id
      ORDER BY rp.role_id ASC, p.id ASC
    `,
  );

  const permissionsByRole = new Map<number, any[]>();

  for (const permission of result.rows) {
    const roleId = Number(permission.roleId);
    const current = permissionsByRole.get(roleId) ?? [];

    current.push({
      id: permission.id,
      permissionCode: permission.permissionCode,
      permissionName: permission.permissionName,
      description: permission.description,
    });

    permissionsByRole.set(roleId, current);
  }

  return roles.map((role) => ({
    ...role,
    permissions:
      permissionsByRole.get(Number(role.id)) ?? [],
  }));
}

export async function replaceRolePermissions(
  roleId: number,
  permissionIds: number[],
) {
  const normalizedRoleId = normalizeId(
    roleId,
    "Role ID",
  );

  const normalizedPermissionIds =
    normalizePermissionIds(permissionIds ?? []);

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const roleResult = await client.query(
      `
        SELECT id
        FROM roles
        WHERE id = $1
        LIMIT 1
      `,
      [normalizedRoleId],
    );

    if (!roleResult.rows[0]) {
      throw new Error("Role not found.");
    }

    if (normalizedPermissionIds.length > 0) {
      const permissionResult = await client.query(
        `
          SELECT id
          FROM permissions
          WHERE id = ANY($1::bigint[])
        `,
        [normalizedPermissionIds],
      );

      if (
        permissionResult.rows.length !==
        normalizedPermissionIds.length
      ) {
        throw new Error(
          "One or more permissions do not exist.",
        );
      }
    }

    await client.query(
      `
        DELETE FROM role_permissions
        WHERE role_id = $1
      `,
      [normalizedRoleId],
    );

    if (normalizedPermissionIds.length > 0) {
      await client.query(
        `
          INSERT INTO role_permissions (
            role_id,
            permission_id
          )
          SELECT
            $1,
            permission_id
          FROM unnest($2::bigint[]) AS permission_id
        `,
        [
          normalizedRoleId,
          normalizedPermissionIds,
        ],
      );
    }

    const result = await client.query(
      `
        SELECT
          p.id,
          p.permission_code AS "permissionCode",
          p.permission_name AS "permissionName",
          p.description
        FROM role_permissions rp
        INNER JOIN permissions p
          ON p.id = rp.permission_id
        WHERE rp.role_id = $1
        ORDER BY p.id ASC
      `,
      [normalizedRoleId],
    );

    await client.query("COMMIT");

    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function roleHasPermission(
  roleCode: string,
  permissionCode: string,
) {
  const normalizedRoleCode = String(
    roleCode ?? "",
  ).trim();

  const normalizedPermissionCode = String(
    permissionCode ?? "",
  ).trim();

  if (
    !normalizedRoleCode ||
    !normalizedPermissionCode
  ) {
    return false;
  }

  const result = await db.query(
    `
      SELECT 1
      FROM roles r
      INNER JOIN role_permissions rp
        ON rp.role_id = r.id
      INNER JOIN permissions p
        ON p.id = rp.permission_id
      WHERE
        r.role_code = $1
        AND r.active = TRUE
        AND p.permission_code = $2
      LIMIT 1
    `,
    [
      normalizedRoleCode,
      normalizedPermissionCode,
    ],
  );

  return Boolean(result.rows[0]);
}