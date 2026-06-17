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

  // Seed bootstrap (used by scripts/seed.ts)
  SEED_ORG_NAME: z.string().default("Delta HQ"),
  SEED_ADMIN_NAME: z.string().default("Owner"),
  SEED_ADMIN_EMAIL: z.string().email().default("admin@delta.local"),
  SEED_ADMIN_PASSWORD: z.string().min(8).default("ChangeMe123!"),
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
