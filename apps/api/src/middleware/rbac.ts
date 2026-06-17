import type { NextFunction, Request, Response } from "express";
import { hasPermission, type Permission } from "@delta/shared";
import { AppError } from "../lib/http";

/** Guards a route behind a required permission. Must run after `authenticate`. */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      throw new AppError("UNAUTHENTICATED", "Authentication required");
    }
    if (!hasPermission(req.auth.permissions, permission)) {
      throw new AppError(
        "FORBIDDEN",
        `Missing required permission: ${permission}`,
      );
    }
    next();
  };
}
