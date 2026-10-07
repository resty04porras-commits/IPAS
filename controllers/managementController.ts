import type { Request, Response } from "express";
import {
  createUser,
  findUserById,
  getUsers as getUsersFromRepository,
  updateUser,
  type UserInput,
} from "../database/repositories/userRepository.js";

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

      if (isUuid(input.id)) {
        const existingUser = await findUserById(input.id);

        if (existingUser) {
          savedUser = await updateUser(input);
        }
      }

      if (!savedUser) {
        const createInput: UserInput = {
          ...input,
          id: undefined,
          mustChangePassword: true,
        };

        savedUser = await createUser(createInput);
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

  return {
    getUsers,
    saveUser,
  };
}