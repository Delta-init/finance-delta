import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodTypeAny, type infer as zInfer } from "zod";
import { AppError } from "../lib/http";

/** Parse + coerce a query string against a Zod schema (throws 422 on failure). */
export function parseQuery<S extends ZodTypeAny>(
  schema: S,
  query: unknown,
): zInfer<S> {
  try {
    return schema.parse(query);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid query parameters",
        err.flatten().fieldErrors,
      );
    }
    throw err;
  }
}

/**
 * Validates `req.body` against a Zod schema and replaces it with the parsed
 * (typed, stripped) result. Use the generic to get a typed body downstream.
 */
export function validateBody<S extends ZodTypeAny>(schema: S) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body) as zInfer<S>;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Request validation failed",
          err.flatten().fieldErrors,
        );
      }
      throw err;
    }
  };
}
