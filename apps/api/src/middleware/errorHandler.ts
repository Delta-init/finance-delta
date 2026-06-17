import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/http";
import { logger } from "../lib/logger";

export function notFound(_req: Request, res: Response) {
  res
    .status(404)
    .json({ error: { code: "NOT_FOUND", message: "Route not found" } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  // Duplicate key (e.g. unique email) from Mongo
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === 11000
  ) {
    return res.status(409).json({
      error: { code: "CONFLICT", message: "Resource already exists" },
    });
  }

  logger.error({ err }, "Unhandled error");
  return res.status(500).json({
    error: { code: "INTERNAL", message: "Internal server error" },
  });
}
