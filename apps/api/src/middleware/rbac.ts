import type { NextFunction, Request, Response } from "express";
import { hasPermission, type Permission } from "@delta/shared";
import { AppError } from "../lib/http";

/** Guards a route behind a required permission. Super admins bypass all checks. */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      throw new AppError("UNAUTHENTICATED", "Authentication required");
    }
    if (req.auth.isSuperAdmin) return next();
    if (!hasPermission(req.auth.permissions, permission)) {
      throw new AppError(
        "FORBIDDEN",
        `Missing required permission: ${permission}`,
      );
    }
    next();
  };
}

/** Guards a route to platform super admins only. */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) {
    throw new AppError("UNAUTHENTICATED", "Authentication required");
  }
  if (!req.auth.isSuperAdmin) {
    throw new AppError("FORBIDDEN", "Super admin access required");
  }
  next();
}
