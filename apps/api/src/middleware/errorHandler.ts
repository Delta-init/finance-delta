import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
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

  if (err instanceof ZodError) {
    return res.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: err.flatten().fieldErrors,
      },
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

  // Malformed input reaching Mongoose (invalid ObjectId, unparseable date fed
  // to a query) throws CastError — that's a bad request, not a server fault.
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "CastError"
  ) {
    const path = (err as { path?: string }).path;
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: path ? `Invalid value for '${path}'` : "Invalid parameter",
      },
    });
  }

  logger.error({ err }, "Unhandled error");
  return res.status(500).json({
    error: { code: "INTERNAL", message: "Internal server error" },
  });
}
