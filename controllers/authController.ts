import type { Request, Response } from "express";
import {
  changeUserPassword,
  findUserByEmployeeId,
  markUserLogin,
  updateUserProfile,
  verifyUserPassword,
} from "../database/repositories/userRepository.js";
import { writeAuditLog } from "./auditHelper.js";

function toSessionUser(user: any) {
  return {
    id: user.id,
    employeeId: user.employeeId,
    name: user.name,
    designation: user.designation,
    role:
      user.role ||
      (user.designation === "Administrator" ? "SUPER_ADMIN" : "USER"),
    photoURL: user.photoURL || null,
    mustChangePassword: Boolean(user.mustChangePassword),
    uiSettings: user.uiSettings || {},
    profileCustomization: user.profileCustomization || {},
  };
}

export function createAuthController() {
  const login = async (req: Request, res: Response) => {
    try {
      const employeeId = String(req.body?.employeeId ?? "").trim();
      const password = req.body?.password;

      if (!employeeId || typeof password !== "string" || !password) {
        return res
          .status(401)
          .json({ error: "Invalid Employee ID or Password" });
      }

      const foundUser = await findUserByEmployeeId(employeeId);

      if (!foundUser) {
        return res
          .status(401)
          .json({ error: "Invalid Employee ID or Password" });
      }

      if (
        foundUser.status &&
        String(foundUser.status).toLowerCase() !== "active"
      ) {
        return res
          .status(401)
          .json({ error: "Invalid Employee ID or Password" });
      }

      const passwordIsValid = await verifyUserPassword(
        foundUser,
        password,
      );

      if (!passwordIsValid) {
        return res
          .status(401)
          .json({ error: "Invalid Employee ID or Password" });
      }

      const sessionUser = toSessionUser(foundUser);

      (req as any).session.user = sessionUser;

      await markUserLogin(foundUser.id);

      return res.json(sessionUser);
    } catch (error) {
      console.error("Auth login error:", error);
      return res.status(500).json({ error: "Unable to sign in." });
    }
  };

  const me = (req: Request, res: Response) => {
    return res.json((req as any).session.user || null);
  };

  const logout = (req: Request, res: Response) => {
    (req as any).session = null;
    return res.json({ success: true });
  };

  const changePassword = async (req: Request, res: Response) => {
    try {
      const sessionUser = (req as any).session.user;

      if (!sessionUser?.employeeId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const newPassword = req.body?.newPassword;

      if (typeof newPassword !== "string" || !newPassword) {
        return res.status(400).json({ error: "New password is required" });
      }

      const changed = await changeUserPassword(
        sessionUser.employeeId,
        newPassword,
      );

      if (!changed) {
        return res.status(404).json({ error: "User not found" });
      }

      (req as any).session.user.mustChangePassword = false;

      await writeAuditLog(req, {
        action: "PASSWORD_CHANGED",
        entityType: "user",
        entityId: sessionUser.id || null,
        details: {
          employeeId: sessionUser.employeeId,
        },
      });

      return res.json({ success: true });
    } catch (error) {
      console.error("Change password error:", error);
      return res.status(500).json({ error: "Unable to change password." });
    }
  };

  const updateUser = async (req: Request, res: Response) => {
    try {
      const sessionUser = (req as any).session.user;

      if (!sessionUser?.id) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { photoURL, uiSettings, profileCustomization } = req.body ?? {};

      const updatedUser = await updateUserProfile(sessionUser.id, {
        photoURL,
        uiSettings,
        profileCustomization,
      });

      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }

      const updatedSessionUser = toSessionUser(updatedUser);

      (req as any).session.user = updatedSessionUser;

      await writeAuditLog(req, {
        action: "PROFILE_UPDATED",
        entityType: "user",
        entityId: updatedUser.id,
        details: {
          employeeId: updatedUser.employeeId,
        },
      });

      return res.json(updatedSessionUser);
    } catch (error) {
      console.error("Update user error:", error);
      return res.status(500).json({ error: "Unable to update user." });
    }
  };

  return {
    login,
    me,
    logout,
    changePassword,
    updateUser,
  };
}