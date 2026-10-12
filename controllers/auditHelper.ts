import type { Request } from "express";

import {
  createAuditLog,
  type AuditLogInput,
} from "../database/repositories/auditRepository.js";

export type RequestAuditInput = {
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
};

function getRequestIp(req: Request): string | null {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string") {
    const firstIp = forwardedFor.split(",")[0]?.trim();

    if (firstIp) {
      return firstIp;
    }
  }

  if (Array.isArray(forwardedFor)) {
    const firstIp = forwardedFor[0]?.split(",")[0]?.trim();

    if (firstIp) {
      return firstIp;
    }
  }

  return req.ip || req.socket?.remoteAddress || null;
}

export async function writeAuditLog(
  req: Request,
  input: RequestAuditInput,
): Promise<void> {
  try {
    const sessionUser = (req as any).session?.user;

    const auditInput: AuditLogInput = {
      userId: sessionUser?.id || null,
      employeeId: sessionUser?.employeeId || null,
      actorName: sessionUser?.name || null,
      action: input.action,
      entityType: input.entityType || null,
      entityId: input.entityId || null,
      details: input.details || {},
      ipAddress: getRequestIp(req),
    };

    await createAuditLog(auditInput);
  } catch (error) {
    console.error("Audit log write failed:", {
      action: input.action,
      entityType: input.entityType || null,
      entityId: input.entityId || null,
      error,
    });
  }
}