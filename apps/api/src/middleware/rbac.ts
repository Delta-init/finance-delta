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

/**
 * Guards a route behind any one of several permissions.
 *
 * For routes an employee reaches with a narrow permission and an administrator
 * with a broad one. Which rows they then get is decided in the service by
 * `resolveScope`, not here — the route cannot know, because it has not read
 * anything yet.
 */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      throw new AppError("UNAUTHENTICATED", "Authentication required");
    }
    if (req.auth.isSuperAdmin) return next();
    if (!permissions.some((p) => hasPermission(req.auth!.permissions, p))) {
      throw new AppError(
        "FORBIDDEN",
        `Missing required permission: ${permissions.join(" or ")}`,
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
