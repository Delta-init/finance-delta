import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/http";
import { verifyAccessToken } from "../lib/jwt";

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: string;
  permissions: string[];
  isSuperAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** Verifies the Bearer access token and attaches the auth context (incl. org scope). */
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new AppError("UNAUTHENTICATED", "Missing or malformed access token");
  }
  const token = header.slice("Bearer ".length);
  try {
    const claims = verifyAccessToken(token);

    // Reject pending-org-select tokens on every route except /auth/switch-org.
    if (claims.pendingOrgSelect && !req.path.endsWith("/switch-org")) {
      throw new AppError("UNAUTHENTICATED", "Organization selection required");
    }

    req.auth = {
      userId: claims.sub,
      organizationId: claims.org ?? "",
      role: claims.role ?? "",
      permissions: claims.perms ?? [],
      isSuperAdmin: claims.superAdmin ?? false,
    };
    next();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("UNAUTHENTICATED", "Invalid or expired access token");
  }
}
