/**
 * Drives a genuinely multi-course enrolment — the shape Draw CRM sends,
 * since its students hold an array of courses rather than one — over the
 * signed HTTP finance actually receives it on, against a real API process.
 *
 * It exists because nothing in crm-handover-e2e.ts exercises `courses`, only
 * `course`: that suite predates the array entirely. This is the companion
 * that proves the new branch of the schema without touching the old one,
 * so a change here can never quietly break what that suite already protects.
 *
 * Three things checked, all real:
 *   - one invoice, one line item per course, correctly priced and taxed;
 *   - `course` and `courses` are mutually exclusive, not just documented as
 *     such — the schema itself has to refuse both and refuse neither;
 *   - a returned multi-course invoice can still be corrected and resubmitted,
 *     the same guarantee single-course enrolments already have.
 *
 * Run through scripts/multi-course-enrolment-e2e.sh, which stands up a
 * throwaway mongod and a throwaway API and tears both down again. Refuses to
 * run against anything that does not look like a scratch database.
 */
import crypto from "node:crypto";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Invoice } from "../modules/invoice/invoice.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

const PORT = process.env.E2E_API_PORT ?? "4131";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/api/v1`;
const INBOUND_ID = process.env.INBOUND_CLIENT_ID ?? "";
const INBOUND_SECRET = process.env.INBOUND_INTEGRATION_SECRET ?? "";
if (!INBOUND_ID || !INBOUND_SECRET) {
  console.error("Refusing to run: INBOUND_CLIENT_ID and INBOUND_INTEGRATION_SECRET must be set");
  process.exit(1);
}

const PASSWORD = "E2ePassword1!";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, detail = "") {
  checks++;
  if (condition) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(name: string) { console.log(`\n\x1b[1m${name}\x1b[0m`); }

type Res = { status: number; body: Record<string, never> };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

async function signedPost(orgId: string, p: string, payload: unknown): Promise<Res> {
  const raw = JSON.stringify(payload);
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const canonical = ["POST", p, ts, nonce, crypto.createHash("sha256").update(raw).digest("hex")].join("\n");
  const r = await fetch(`${ORIGIN}${p}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-delta-client": INBOUND_ID,
      "x-delta-timestamp": ts,
      "x-delta-nonce": nonce,
      "x-delta-signature": crypto.createHmac("sha256", INBOUND_SECRET).update(canonical).digest("hex"),
      "x-delta-org": orgId,
    },
    body: raw,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, never> };
}

async function main() {
  await mongoose.connect(uri);
  if (mongoose.connection.db!.databaseName === "finance" || mongoose.connection.db!.databaseName === "finanace") {
    console.error("Refusing to run against a database named like the real one.");
    process.exit(1);
  }

  step("Setting up an organization");
  const org = await Organization.create({
    name: "Draw E2E",
    baseCurrency: "AED",
    taxRates: [{ label: "VAT 5%", code: "VAT", rate: 5, isDefault: true, appliesTo: "sales" }],
  });
  const orgId = String(org._id);

  for (const def of SYSTEM_ROLES) {
    await Role.create({
      organizationId: org._id, key: def.key, name: def.name,
      description: def.description, permissions: def.permissions, isSystem: true,
    });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const roleId = (key: string) => String(roles.find((r) => r.key === key)!._id);
  const passwordHash = await hashPassword(PASSWORD);

  const approver = await User.create({
    name: "Approver",
    email: "approver@e2e-test.com",
    passwordHash,
    status: "active",
    memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(roleId("admin")), status: "active" }],
  });
  void approver;
  console.log(`  organization ${orgId}, ${roles.length} roles`);

  step("Both course and courses at once, or neither, is refused");
  const both = await signedPost(orgId, "/api/v1/integrations/enrolments", {
    externalId: "both-1", source: "draw-crm",
    customer: { name: "X", email: "both@e2e-test.com", phone: "+971500000000" },
    course: { name: "A", amountMinor: 1000 },
    courses: [{ name: "B", amountMinor: 1000 }],
    modeOfStudy: "online", language: "", declaredPaidMinor: 0,
  });
  check("...both refused", both.status >= 400, show(both));

  const neither = await signedPost(orgId, "/api/v1/integrations/enrolments", {
    externalId: "neither-1", source: "draw-crm",
    customer: { name: "X", email: "neither@e2e-test.com", phone: "+971500000000" },
    modeOfStudy: "online", language: "", declaredPaidMinor: 0,
  });
  check("...neither refused", neither.status >= 400, show(neither));

  step("A genuinely multi-course enrolment — the shape Draw sends");
  const multi = await signedPost(orgId, "/api/v1/integrations/enrolments", {
    externalId: "draw-1", source: "draw-crm",
    customer: { name: "Multi Course Student", email: "multi@e2e-test.com", phone: "+971500000001" },
    courses: [
      { name: "Forex Foundations", amountMinor: 100_000, lmsCourseSlug: "forex-foundations" },
      { name: "Options Advanced", amountMinor: 150_000 },
      { name: "Risk Management", amountMinor: 50_000 },
    ],
    salespersonEmail: "approver@e2e-test.com",
    salespersonName: "Draw Rep",
    enrolledOn: new Date().toISOString().slice(0, 10),
    declaredPaidMinor: 0,
    modeOfStudy: "online" as const,
    language: "English",
  });
  check("accepted", multi.status === 200, show(multi));

  const inv = await Invoice.findOne({ "external.externalId": "draw-1" }).lean();
  check("one invoice exists", !!inv);
  const lines = (inv?.lineItems as { description: string; unitPriceMinor: number }[] | undefined) ?? [];
  check("...with three line items, one per course", lines.length === 3, `lines=${lines.length}`);
  check(
    "...each with its own course name and price",
    lines.some((l) => l.description === "Forex Foundations" && l.unitPriceMinor === 100_000) &&
      lines.some((l) => l.description === "Options Advanced" && l.unitPriceMinor === 150_000) &&
      lines.some((l) => l.description === "Risk Management" && l.unitPriceMinor === 50_000),
    JSON.stringify(lines),
  );
  check(
    "the invoice total is all three added together, tax included",
    inv?.totalMinor === 300_000,
    `totalMinor=${inv?.totalMinor}`,
  );
  const enrolmentBlock = inv?.enrolment as { course?: string; lmsCourseSlug?: string } | undefined;
  check(
    "the enrolment summary names the first course, for notifications and reports",
    enrolmentBlock?.course === "Forex Foundations",
    `course=${enrolmentBlock?.course}`,
  );
  check(
    "...and carries that course's slug, for LMS provisioning",
    enrolmentBlock?.lmsCourseSlug === "forex-foundations",
    `slug=${enrolmentBlock?.lmsCourseSlug}`,
  );

  step("Sent back, then corrected — the same guarantee a single course has");
  const { returnInvoice } = await import("../modules/invoice/invoice.service");
  await returnInvoice(orgId, String(inv!._id), "Wrong price on Options Advanced", {
    userId: String(approver._id), name: "Approver",
  });
  const corrected = await signedPost(orgId, "/api/v1/integrations/enrolments", {
    externalId: "draw-1", source: "draw-crm",
    customer: { name: "Multi Course Student", email: "multi@e2e-test.com", phone: "+971500000001" },
    courses: [
      { name: "Forex Foundations", amountMinor: 100_000, lmsCourseSlug: "forex-foundations" },
      { name: "Options Advanced", amountMinor: 130_000 }, // corrected
      { name: "Risk Management", amountMinor: 50_000 },
    ],
    salespersonEmail: "approver@e2e-test.com",
    salespersonName: "Draw Rep",
    enrolledOn: new Date().toISOString().slice(0, 10),
    declaredPaidMinor: 0,
    modeOfStudy: "online" as const,
    language: "English",
  });
  check("the correction is accepted", corrected.status === 200, show(corrected));
  const same = await Invoice.findOne({ "external.externalId": "draw-1" }).lean();
  check("it is the same invoice, same id", String(same?._id) === String(inv?._id));
  check(
    "back to pending, not still returned",
    (same?.approval as { state?: string } | undefined)?.state === "pending",
    JSON.stringify(same?.approval),
  );
  const correctedLines = (same?.lineItems as { description: string; unitPriceMinor: number }[] | undefined) ?? [];
  check(
    "the corrected price is what is billed now",
    correctedLines.find((l) => l.description === "Options Advanced")?.unitPriceMinor === 130_000,
    JSON.stringify(correctedLines),
  );
  check(
    "the invoice total reflects the correction",
    same?.totalMinor === 280_000,
    `totalMinor=${same?.totalMinor}`,
  );

  console.log(
    failures
      ? `\n\x1b[31m${failures} of ${checks} checks failed\x1b[0m`
      : `\n\x1b[32mAll ${checks} checks passed\x1b[0m`,
  );
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error("\nHarness error:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(2);
});
