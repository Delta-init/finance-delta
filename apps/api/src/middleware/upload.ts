import type { NextFunction, Request, Response } from "express";
import Busboy from "busboy";
import { AppError } from "../lib/http";

export interface ParsedFile {
  buffer: Buffer;
  mimeType: string;
  originalName: string;
  size: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      file?: ParsedFile;
    }
  }
}

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Parses a multipart/form-data request, pulling out:
 *   - `req.body`  — all text fields (JSON-parsed when Content-Type hint says so)
 *   - `req.file`  — the first uploaded file (buffer + metadata)
 *
 * Falls through (calls next()) immediately for non-multipart requests so
 * existing JSON routes are unaffected.
 */
export function parseUpload(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ct = req.headers["content-type"] ?? "";
  if (!ct.includes("multipart/form-data")) {
    return next();
  }

  const body: Record<string, unknown> = {};
  let file: ParsedFile | undefined;
  let fileSizeExceeded = false;

  const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES } });

  bb.on("field", (name, value) => {
    // Auto-parse JSON blobs sent as a single "data" field
    if (name === "data") {
      try {
        Object.assign(body, JSON.parse(value));
      } catch {
        body[name] = value;
      }
    } else {
      body[name] = value;
    }
  });

  bb.on("file", (_field, stream, info) => {
    if (file) {
      // Only accept first file; drain and discard extras
      stream.resume();
      return;
    }

    const { filename, mimeType } = info;
    if (!ALLOWED_MIME.has(mimeType)) {
      stream.resume();
      next(
        new AppError(
          "VALIDATION_ERROR",
          `File type "${mimeType}" is not allowed. Upload JPEG, PNG, WebP, GIF, or PDF.`,
        ),
      );
      return;
    }

    const chunks: Buffer[] = [];

    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("limit", () => {
      fileSizeExceeded = true;
      stream.resume();
    });
    stream.on("end", () => {
      if (!fileSizeExceeded) {
        const buffer = Buffer.concat(chunks);
        file = { buffer, mimeType, originalName: filename, size: buffer.byteLength };
      }
    });
  });

  bb.on("finish", () => {
    if (fileSizeExceeded) {
      return next(new AppError("VALIDATION_ERROR", "File exceeds the 10 MB limit."));
    }
    req.body = body;
    if (file) req.file = file;
    next();
  });

  bb.on("error", (err: Error) => next(err));

  req.pipe(bb);
}
