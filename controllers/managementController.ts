import type { Request, Response } from "express";

import {
  activateUser as activateUserFromRepository,
  createUser,
  deactivateUser as deactivateUserFromRepository,
  findUserById,
  getUsers as getUsersFromRepository,
  updateUser,
  type UserInput,
} from "../database/repositories/userRepository.js";

import {
  getPermissions as getPermissionsFromRepository,
  getRoles as getRolesFromRepository,
  getRolesWithPermissions as getRolesWithPermissionsFromRepository,
} from "../database/repositories/permissionRepository.js";

import {
  getAuditLogs as getAuditLogsFromRepository,
} from "../database/repositories/auditRepository.js";

import { writeAuditLog } from "./auditHelper.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

function normalizeUserInput(body: any): UserInput {
  return {
    id: typeof body?.id === "string" ? body.id.trim() : undefined,
    employeeId: String(body?.employeeId ?? "").trim(),
    name: String(body?.name ?? "").trim(),
    email: body?.email ?? null,
    designation: body?.designation ?? null,
    department: body?.department ?? null,
    baseOffice: body?.baseOffice ?? null,
    group: body?.group ?? null,
    division: body?.division ?? null,
    district: body?.district ?? null,
    remarks: body?.remarks ?? null,
    divisionId: body?.divisionId ?? null,
    districtId: body?.districtId ?? null,
    role: body?.role || "USER",
    status: body?.status || "Active",
    photoURL: body?.photoURL ?? null,
    signaturePath: body?.signaturePath ?? null,
    mustChangePassword: body?.mustChangePassword ?? true,
    uiSettings: body?.uiSettings || {},
    profileCustomization: body?.profileCustomization || {},
  };
}

export function createManagementController() {
  const getUsers = async (_req: Request, res: Response) => {
    try {
      const users = await getUsersFromRepository();
      return res.json(users);
    } catch (error) {
      console.error("Management get users error:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to load users.",
      });
    }
  };

    const saveUser = async (req: Request, res: Response) => {
    try {
      const input = normalizeUserInput(req.body);

      if (!input.employeeId) {
        return res.status(400).json({
          success: false,
          message: "Employee ID is required.",
        });
      }

      if (!input.name) {
        return res.status(400).json({
          success: false,
          message: "Employee Name is required.",
        });
      }

      let savedUser = null;
      let auditAction = "USER_CREATED";

      if (isUuid(input.id)) {
        const existingUser = await findUserById(input.id);

        if (existingUser) {
          savedUser = await updateUser(input);
          auditAction = "USER_UPDATED";
        }
      }

      if (!savedUser) {
        const createInput: UserInput = {
          ...input,
          id: undefined,
          mustChangePassword: true,
        };

        savedUser = await createUser(createInput);
        auditAction = "USER_CREATED";
      }

      if (savedUser) {
        await writeAuditLog(req, {
          action: auditAction,
          entityType: "user",
          entityId: savedUser.id,
          details: {
            employeeId: savedUser.employeeId,
            name: savedUser.name,
            designation: savedUser.designation,
            role: savedUser.role,
            status: savedUser.status,
          },
        });
      }

      return res.json({
        success: true,
        user: savedUser,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return res.status(409).json({
          success: false,
          message: "Employee ID already exists.",
        });
      }

      console.error("Management save user error:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to save user.",
      });
    }
  };

  const deactivateUser = async (req: Request, res: Response) => {
    try {
      const sessionUser = (req as any).session?.user;

      if (!sessionUser) {
        return res.status(401).json({
          success: false,
          message: "Not authenticated.",
        });
      }

      const sessionRole = String(
        sessionUser.role || "",
      ).toUpperCase();

      const sessionDesignation = String(
        sessionUser.designation || "",
      ).toLowerCase();

      const isSuperAdmin =
        sessionRole === "SUPER_ADMIN" ||
        sessionDesignation === "administrator" ||
        sessionDesignation === "system admin";

      if (!isSuperAdmin) {
        return res.status(403).json({
          success: false,
          message:
            "Only Super Admin users can deactivate user accounts.",
        });
      }

      const userId = String(req.params.id ?? "").trim();

      if (!isUuid(userId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid user ID.",
        });
      }

      const existingUser = await findUserById(userId);

      if (!existingUser) {
        return res.status(404).json({
          success: false,
          message: "User not found.",
        });
      }

      if (
        String(existingUser.status || "").toLowerCase() ===
        "inactive"
      ) {
        return res.status(400).json({
          success: false,
          message: "User account is already inactive.",
        });
      }

      if (
        sessionUser.id === userId ||
        (
          sessionUser.employeeId &&
          existingUser.employeeId &&
          String(sessionUser.employeeId) ===
            String(existingUser.employeeId)
        )
      ) {
        return res.status(400).json({
          success: false,
          message: "You cannot deactivate your own account.",
        });
      }

      const deactivatedUser =
        await deactivateUserFromRepository(userId);

      if (!deactivatedUser) {
        return res.status(404).json({
          success: false,
          message: "User not found.",
        });
      }

      await writeAuditLog(req, {
        action: "USER_DEACTIVATED",
        entityType: "user",
        entityId: deactivatedUser.id,
        details: {
          employeeId: deactivatedUser.employeeId,
          name: deactivatedUser.name,
          designation: deactivatedUser.designation,
          role: deactivatedUser.role,
          previousStatus: existingUser.status,
          newStatus: deactivatedUser.status,
        },
      });

      return res.json({
        success: true,
        message: "User deactivated successfully.",
        user: deactivatedUser,
      });
    } catch (error) {
      console.error(
        "Management deactivate user error:",
        error,
      );

      return res.status(500).json({
        success: false,
        message: "Unable to deactivate user.",
      });
    }
  };

    const activateUser = async (req: Request, res: Response) => {
    try {
      const sessionUser = (req as any).session?.user;

      if (!sessionUser) {
        return res.status(401).json({
          success: false,
          message: "Not authenticated.",
        });
      }

      const sessionRole = String(
        sessionUser.role || "",
      ).toUpperCase();

      const sessionDesignation = String(
        sessionUser.designation || "",
      ).toLowerCase();

      const isSuperAdmin =
        sessionRole === "SUPER_ADMIN" ||
        sessionDesignation === "administrator" ||
        sessionDesignation === "system admin";

      if (!isSuperAdmin) {
        return res.status(403).json({
          success: false,
          message:
            "Only Super Admin users can activate user accounts.",
        });
      }

      const userId = String(req.params.id ?? "").trim();

      if (!isUuid(userId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid user ID.",
        });
      }

      const existingUser = await findUserById(userId);

      if (!existingUser) {
        return res.status(404).json({
          success: false,
          message: "User not found.",
        });
      }

      if (
        String(existingUser.status || "").toLowerCase() ===
        "active"
      ) {
        return res.status(400).json({
          success: false,
          message: "User account is already active.",
        });
      }

      const activatedUser =
        await activateUserFromRepository(userId);

      if (!activatedUser) {
        return res.status(404).json({
          success: false,
          message: "User not found.",
        });
      }

      await writeAuditLog(req, {
        action: "USER_REACTIVATED",
        entityType: "user",
        entityId: activatedUser.id,
        details: {
          employeeId: activatedUser.employeeId,
          name: activatedUser.name,
          designation: activatedUser.designation,
          role: activatedUser.role,
          previousStatus: existingUser.status,
          newStatus: activatedUser.status,
        },
      });

      return res.json({
        success: true,
        message: "User activated successfully.",
        user: activatedUser,
      });
    } catch (error) {
      console.error(
        "Management activate user error:",
        error,
      );

      return res.status(500).json({
        success: false,
        message: "Unable to activate user.",
      });
    }
  };

  const getRoles = async (_req: Request, res: Response) => {
    try {
      const roles = await getRolesFromRepository();
      return res.json(roles);
    } catch (error) {
      console.error("Management get roles error:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to load roles.",
      });
    }
  };

  const getPermissions = async (
    _req: Request,
    res: Response,
  ) => {
    try {
      const permissions =
        await getPermissionsFromRepository();

      return res.json(permissions);
    } catch (error) {
      console.error(
        "Management get permissions error:",
        error,
      );

      return res.status(500).json({
        success: false,
        message: "Unable to load permissions.",
      });
    }
  };

  const getRolesWithPermissions = async (
    _req: Request,
    res: Response,
  ) => {
    try {
      const roles =
        await getRolesWithPermissionsFromRepository();

      return res.json(roles);
    } catch (error) {
      console.error(
        "Management get role permissions error:",
        error,
      );

      return res.status(500).json({
        success: false,
        message: "Unable to load role permissions.",
      });
    }
  };

  const getAuditLogs = async (
    req: Request,
    res: Response,
  ) => {
    try {
      const logs = await getAuditLogsFromRepository({
        userId:
          typeof req.query.userId === "string"
            ? req.query.userId
            : undefined,

        employeeId:
          typeof req.query.employeeId === "string"
            ? req.query.employeeId
            : undefined,

        action:
          typeof req.query.action === "string"
            ? req.query.action
            : undefined,

        entityType:
          typeof req.query.entityType === "string"
            ? req.query.entityType
            : undefined,

        entityId:
          typeof req.query.entityId === "string"
            ? req.query.entityId
            : undefined,

        limit:
          typeof req.query.limit === "string"
            ? Number(req.query.limit)
            : undefined,

        offset:
          typeof req.query.offset === "string"
            ? Number(req.query.offset)
            : undefined,
      });

      return res.json(logs);
    } catch (error) {
      console.error(
        "Management get audit logs error:",
        error,
      );

      return res.status(500).json({
        success: false,
        message: "Unable to load audit logs.",
      });
    }
  };

    return {
    getUsers,
    saveUser,
    deactivateUser,
    activateUser,
    getRoles,
    getPermissions,
    getRolesWithPermissions,
    getAuditLogs,
  };
}