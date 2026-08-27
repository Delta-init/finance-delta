import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),

  MONGODB_URI: z
    .string()
    .default("mongodb://localhost:27017/finanace"),

  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET must be set (>=16 chars)"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET must be set (>=16 chars)"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),

  REDIS_URL: z.string().default("redis://localhost:6379"),
  RESEND_API_KEY: z.string().default(""),
  FROM_EMAIL: z.string().email().default("noreply@delta.local"),
  FROM_NAME: z.string().default("Delta Finance"),

  // Cloudflare R2 (file uploads — optional; uploads disabled when unset)
  R2_ACCOUNT_ID: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),
  R2_BUCKET_NAME: z.string().default("delta-uploads"),
  R2_PUBLIC_URL: z.string().default(""),

  // ── HRMS integration ──────────────────────────────────────────────────────
  // Where the HRMS API lives and the shared-secret credentials we sign with.
  // All three empty means the payroll integration is off and its endpoints say
  // so plainly, rather than failing with a connection error at sync time.
  HRMS_API_URL: z.string().default(""),
  HRMS_CLIENT_ID: z.string().default(""),
  HRMS_INTEGRATION_SECRET: z.string().default(""),

  // Seed bootstrap (used by scripts/seed.ts)
  SEED_ORG_NAME: z.string().default("Delta HQ"),
  SEED_ADMIN_NAME: z.string().default("Owner"),
  SEED_ADMIN_EMAIL: z.string().email().default("admin@delta.local"),
  SEED_ADMIN_PASSWORD: z.string().min(8).default("ChangeMe123!"),
  SEED_SUPER_ADMIN_NAME: z.string().default("Super Admin"),
  SEED_SUPER_ADMIN_EMAIL: z.string().email().default("superadmin@delta.local"),
  SEED_SUPER_ADMIN_PASSWORD: z.string().min(8).default("SuperAdmin@2025!"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "❌ Invalid environment variables:\n",
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
