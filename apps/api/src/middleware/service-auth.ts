import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { signRequest } from "../lib/signing";

/**
 * Machine-to-machine authentication for the integration API.
 *
 * The counterpart of the middleware the HRMS repo already runs, and of
 * `lib/hrms-client.ts` here — this is the same protocol pointed the other way,
 * so that another service can call into finance.
 *
 * Deliberately not a JWT. The caller is a server, not a person: there is no
 * login, no refresh, nothing to revoke on logout. What matters is that a
 * request cannot be replayed and cannot be altered in flight, because this
 * door creates invoices.
 *
 *   METHOD \n ORIGINAL_URL \n TIMESTAMP \n NONCE \n sha256(rawBody)
 */

/** How far a caller's clock may drift before the request is refused. */
const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Nonces already spent, with the time they expire.
 *
 * In-process, so it stops replays against this instance only. Enough for a
 * single node and deliberately not enough for several: before this API is run
 * behind more than one process, move the set to Redis, or a replay need only
 * be aimed at a different node to succeed.
 */
const seenNonces = new Map<string, number>();

function sweepNonces(now: number): void {
  if (seenNonces.size < 1000) return;
  for (const [nonce, expiresAt] of seenNonces) {
    if (expiresAt <= now) seenNonces.delete(nonce);
  }
}

/** Constant-time compare, so the answer does not leak through the runtime. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself be a leak.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** One shape of refusal, whatever went wrong. */
function deny(res: Response): void {
  res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Unauthorized" } });
}

/**
 * Guards the integration routes.
 *
 * Refuses anything unsigned, stale, replayed or altered — and says only "no",
 * so a caller probing the endpoint learns nothing about which part failed.
 */
export function serviceAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = env.INBOUND_INTEGRATION_SECRET;
  const clientId = env.INBOUND_CLIENT_ID;

  // Unconfigured means off, not open.
  if (!secret || !clientId) {
    res.status(503).json({
      error: { code: "UNAVAILABLE", message: "Integration API is not enabled on this server" },
    });
    return;
  }

  const client = String(req.headers["x-delta-client"] ?? "");
  const timestamp = String(req.headers["x-delta-timestamp"] ?? "");
  const nonce = String(req.headers["x-delta-nonce"] ?? "");
  const signature = String(req.headers["x-delta-signature"] ?? "");

  if (!client || !timestamp || !nonce || !signature) return deny(res);
  if (!safeEqual(client, clientId)) return deny(res);

  const ts = Number(timestamp);
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return deny(res);

  if (seenNonces.has(nonce)) return deny(res);

  /*
   * The bytes as they arrived.
   *
   * Re-serialising `req.body` would let the caller and this server disagree
   * about key order or how a number is written, and the signature would then
   * fail for honest requests while telling nobody why.
   */
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody?.toString("utf8") ?? "";
  const expected = signRequest(secret, req.method, req.originalUrl, timestamp, nonce, rawBody);

  if (!safeEqual(signature, expected)) return deny(res);

  sweepNonces(now);
  seenNonces.set(nonce, now + MAX_SKEW_MS);
  next();
}
