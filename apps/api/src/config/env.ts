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
  /**
   * SMTP, for sending without Resend.
   *
   * Same variable names HRMS uses, deliberately: an organization that has
   * already set up a mail account for one of these should not have to do it
   * again with different spellings for the other.
   *
   * Resend wins when its key is set. Otherwise these are used, and when
   * neither is configured sending is a logged no-op.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z.string().optional(), // "true" | "false"
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

  /*
   * The inbound side: what another server must present to call this one.
   *
   * Separate from the HRMS pair above, which is what this server presents when
   * it calls out. Sharing one secret for both directions would mean anybody
   * able to read the outbound credentials could also impersonate a caller.
   *
   * Empty means the integration API is off. Unconfigured has to mean closed,
   * not open — a deployment that has not set this up must not accept signed
   * requests from anyone who guesses the header names.
   */
  /**
   * The LMS, for giving a student their course once an enrolment is approved.
   *
   * A shared secret rather than the HMAC the HRMS link uses, because that is
   * what the LMS already accepts on its server-to-server routes and a second
   * scheme there would be one more thing to keep in step. Unset, nothing is
   * provisioned and approvals carry on exactly as before.
   */
  LMS_API_URL: z.string().default(""),
  LMS_S2S_SECRET: z.string().default(""),

  INBOUND_CLIENT_ID: z.string().default(""),
  INBOUND_INTEGRATION_SECRET: z.string().default(""),

  /**
   * Whether this process runs the timed jobs.
   *
   * They write: the recurring worker issues invoices, the reminder worker mails
   * clients. A second process against the same database therefore issues them
   * twice — which is what happens the moment somebody points a local copy at
   * production to look at real data. Set false there; the API still serves
   * every request, it simply is not the one on the clock.
   */
  RUN_SCHEDULERS: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),

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

/**
 * Two settings that are only wrong once mail is switched on.
 *
 * `FROM_EMAIL` defaults to noreply@delta.local so the application runs with no
 * mail configured at all. The moment a transport is configured that default
 * becomes a guaranteed failure: no provider will send from an unverified
 * .local domain. It would fail per-email, silently, in a background dispatch
 * nobody is watching — so it is dealt with here, once, at boot.
 *
 * Dealt with rather than only refused. When SMTP is the transport there is a
 * right answer sitting next to the wrong one: SMTP_USER is the authenticated
 * account, and most providers — Gmail among them — require the From address to
 * be exactly that or a verified alias of it. So the sender falls back to the
 * account doing the sending, which is both a working value and the one the
 * provider wants. Refusing to boot over a question that answers itself would
 * be a worse failure than the one being prevented.
 *
 * Resend gets no such fallback. Its key says nothing about which addresses the
 * account may send from, so there is nothing to infer and the only honest move
 * is to stop and say so.
 *
 * `WEB_ORIGIN` is the other one: every action button in every email is built
 * from it, so a default left in place sends the whole company links to
 * localhost. A warning rather than a refusal — wrong, but not broken.
 */
const PLACEHOLDER_SENDER = /@(delta\.local|example\.com)$|\.local$/i;

export function assertMailConfigSane(): void {
  const smtp = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
  if (!env.RESEND_API_KEY && !smtp) return;

  if (PLACEHOLDER_SENDER.test(env.FROM_EMAIL)) {
    // SMTP can answer the question itself; Resend cannot.
    if (smtp && env.SMTP_USER && env.SMTP_USER.includes("@")) {
      (env as { FROM_EMAIL: string }).FROM_EMAIL = env.SMTP_USER;
      console.warn(
        [
          `\u26a0\ufe0f  FROM_EMAIL was still "noreply@delta.local", so mail will be sent as ${env.SMTP_USER}.`,
          "   Set FROM_EMAIL explicitly to silence this. It must be the SMTP account or a verified alias of it.",
        ].join("\n"),
      );
    } else {
      console.error(
        [
          `\u274c Mail is configured but FROM_EMAIL is still "${env.FROM_EMAIL}".`,
          "   No provider will send from that domain, so every email would fail silently.",
          "   Set FROM_EMAIL to an address on a domain verified with your mail provider.",
        ].join("\n"),
      );
      process.exit(1);
    }
  }

  if (isProd && env.WEB_ORIGIN.includes("localhost")) {
    console.warn(
      [
        `\u26a0\ufe0f  Mail is configured but WEB_ORIGIN is "${env.WEB_ORIGIN}".`,
        "   Every link in every email will point there. Set it to the address people actually use.",
      ].join("\n"),
    );
  }
}
