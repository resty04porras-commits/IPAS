
import type { Request, Response, NextFunction } from "express";

import { findUserById } from "../database/repositories/userRepository.js";
import { roleHasPermission } from "../database/repositories/permissionRepository.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requirePermission(permissionCode: string) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const sessionUser = (req as any).session?.user;

      if (
        !sessionUser ||
        typeof sessionUser.id !== "string" ||
        !UUID_PATTERN.test(sessionUser.id)
      ) {
        res.status(401).json({
          error: "Not authenticated.",
        });
        return;
      }

      const user = await findUserById(sessionUser.id);

      if (!user) {
        res.status(401).json({
          error: "User account not found.",
        });
        return;
      }

      if (String(user.status).toLowerCase() !== "active") {
        res.status(403).json({
          error: "User account is inactive.",
        });
        return;
      }

      if (user.mustChangePassword === true) {
        res.status(403).json({
          error: "Password change required.",
        });
        return;
      }

      const roleCode = String(user.role ?? "").trim();

      const allowed = await roleHasPermission(
        roleCode,
        permissionCode,
      );

      if (!allowed) {
        res.status(403).json({
          error: "Insufficient permissions.",
        });
        return;
      }

      next();
    } catch (error) {
      console.error("Permission validation failed:", error);

      res.status(500).json({
        error: "Unable to verify permissions.",
      });
    }
  };
}
