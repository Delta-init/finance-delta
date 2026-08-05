import type { NextFunction, Request, Response } from "express";

/**
 * Minimal in-memory fixed-window rate limiter. Enough to blunt online
 * credential brute-force / password-spraying on auth endpoints without a new
 * dependency. For multi-instance deployments, back this with Redis.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  /** Derives the bucket key from the request (default: client IP). */
  keyGenerator?: (req: Request) => string;
  message?: string;
}) {
  const { windowMs, max, message = "Too many attempts. Please try again later." } = opts;
  const keyGenerator = opts.keyGenerator ?? ((req) => req.ip ?? "unknown");
  const buckets = new Map<string, Bucket>();

  return function rateLimiter(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = keyGenerator(req);

    // Opportunistic cleanup so the map doesn't grow unbounded.
    if (buckets.size > 5000) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: { code: "RATE_LIMITED", message },
      });
    }
    return next();
  };
}
