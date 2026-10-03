/**
 * POST /api/v1/lms/customer-check, against a running API and its database.
 *
 * The Delta LMS asks this before an admin approves a student, and refuses the
 * approval when finance does not know the email. Pinned here:
 *
 *   A. only the LMS gets an answer: no secret, a wrong one, or a server with
 *      none configured all say no;
 *   B. a customer is found by email however it was typed, in every
 *      organization it is in, and an archived one does not count — one from
 *      before the status field does;
 *   C. an email finance has never seen, and one that is not an email.
 *
 * Run through scripts/lms-customer-check-e2e.sh, which starts both APIs.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e/.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a throwaway e2e database, got "${uri}"`);
  process.exit(1);
}
const API = `http://127.0.0.1:${process.env.E2E_API_PORT}/api/v1`;
const BARE = `http://127.0.0.1:${process.env.E2E_BARE_API_PORT}/api/v1`;
const SECRET = process.env.E2E_LMS_SECRET ?? "";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

async function ask(base: string, email: unknown, secret?: string) {
  const res = await fetch(`${base}/lms/customer-check`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret !== undefined ? { "x-lms-secret": secret } : {}) },
    body: JSON.stringify({ email }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
}

await mongoose.connect(uri);
const db = mongoose.connection.db!;
const hq = new Types.ObjectId();
const bangalore = new Types.ObjectId();
await db.collection("organizations").insertMany([
  { _id: hq, name: "Delta HQ" },
  { _id: bangalore, name: "Delta Bangalore" },
]);
const customer = (organizationId: Types.ObjectId, email: string, extra: Record<string, unknown> = {}) => ({
  organizationId, email, name: email.split("@")[0], customerCode: `C-${new Types.ObjectId()}`, status: "active", ...extra,
});
await db.collection("customers").insertMany([
  customer(hq, "paid.student@example.com"),
  customer(hq, "two.places@example.com"),
  customer(bangalore, "two.places@example.com"),
  customer(hq, "gone@example.com", { status: "archived" }),
  { ...customer(hq, "legacy@example.com"), status: undefined },
]);
await db.collection("customers").updateOne({ email: "legacy@example.com" }, { $unset: { status: "" } });

step("A. Only the LMS gets an answer");
{
  const none = await ask(API, "paid.student@example.com");
  check("no secret: 401", none.status === 401, JSON.stringify(none));
  const wrong = await ask(API, "paid.student@example.com", "not-the-secret");
  check("a wrong secret: 401", wrong.status === 401, JSON.stringify(wrong));
  const bare = await ask(BARE, "paid.student@example.com", SECRET);
  check("a server with no LMS secret: 503, never an answer", bare.status === 503 && bare.body?.error?.code === "NOT_CONFIGURED" && !("data" in (bare.body ?? {})), JSON.stringify(bare));
}

step("B. Customers finance knows");
{
  const r = await ask(API, "  Paid.Student@Example.COM ", SECRET);
  check("found, however the email was typed", r.status === 200 && r.body?.data?.exists === true, JSON.stringify(r));
  check("...with the organization it is in", JSON.stringify(r.body?.data?.organizations) === JSON.stringify(["Delta HQ"]), JSON.stringify(r.body?.data));
  check("...and nothing else about them", JSON.stringify(Object.keys(r.body?.data ?? {}).sort()) === JSON.stringify(["exists", "organizations"]), JSON.stringify(r.body?.data));
  const two = await ask(API, "two.places@example.com", SECRET);
  check("in two organizations: both, in order", JSON.stringify(two.body?.data?.organizations) === JSON.stringify(["Delta Bangalore", "Delta HQ"]), JSON.stringify(two.body));
  const gone = await ask(API, "gone@example.com", SECRET);
  check("archived: not counted", gone.status === 200 && gone.body?.data?.exists === false && gone.body?.data?.organizations?.length === 0, JSON.stringify(gone.body));
  const legacy = await ask(API, "legacy@example.com", SECRET);
  check("from before the status field: counted", legacy.body?.data?.exists === true, JSON.stringify(legacy.body));
}

step("C. Emails finance has not seen, and ones that are not emails");
{
  const unknown = await ask(API, "never.paid@example.com", SECRET);
  check("never seen: not found, no organizations", unknown.status === 200 && unknown.body?.data?.exists === false && unknown.body?.data?.organizations?.length === 0, JSON.stringify(unknown.body));
  for (const bad of ["", "not-an-email", 42, null]) {
    const r = await ask(API, bad, SECRET);
    check(`${JSON.stringify(bad)}: refused as invalid (422)`, r.status === 422 && r.body?.error?.code === "VALIDATION_ERROR", JSON.stringify(r));
  }
}

await mongoose.disconnect();
console.log("");
if (fail) { console.log(`\x1b[31m${fail} of ${pass + fail} checks failed\x1b[0m`); process.exit(1); }
console.log(`\x1b[32mAll ${pass} checks passed\x1b[0m`);
