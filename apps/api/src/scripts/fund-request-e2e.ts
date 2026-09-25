/**
 * Drives a fund request from Media ERP — money out of Marketing's allocation —
 * over the signed HTTP finance actually receives it on, against a real API.
 *
 * What it proves, all over real HTTP:
 *   - a request handed over lands as a drawdown waiting for review, once,
 *     however many times the caller retries it;
 *   - approving it takes the amount off the department's month, and nothing
 *     moves while it is pending or after it is rejected;
 *   - an approval that would take the month below zero is refused, and stays
 *     refused when two approvals race for the last of it;
 *   - top-ups raised inside finance still add, and rows written before
 *     drawdowns existed still count as top-ups;
 *   - the caller can find out what became of each request by its own id.
 *
 * Run through scripts/fund-request-e2e.sh, which stands up a throwaway mongod
 * and a throwaway API and tears both down again. Refuses to run against
 * anything that does not look like a scratch database on this machine.
 */
import crypto from "node:crypto";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Department } from "../modules/department/department.model";
import { Expense } from "../modules/expense/expense.model";
import { FundingRequestModel } from "../modules/budget/budget.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/[^/?]*e2e/.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const PORT = process.env.E2E_API_PORT ?? "4132";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/api/v1`;
const INBOUND_ID = process.env.INBOUND_CLIENT_ID ?? "";
const INBOUND_SECRET = process.env.INBOUND_INTEGRATION_SECRET ?? "";
if (!INBOUND_ID || !INBOUND_SECRET) {
  console.error("Refusing to run: INBOUND_CLIENT_ID and INBOUND_INTEGRATION_SECRET must be set");
  process.exit(1);
}

const PASSWORD = "E2ePassword1!";
const PERIOD = "2026-10";
const SOURCE = "media-erp";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, detail = "") {
  checks++;
  if (condition) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(name: string) { console.log(`\n\x1b[1m${name}\x1b[0m`); }

type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

async function request(method: string, p: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function login(email: string): Promise<string> {
  const r = await request("POST", "/auth/login", { email, password: PASSWORD });
  const token = r.body?.data?.accessToken as string | undefined;
  if (!token) throw new Error(`login failed for ${email}: ${show(r)}`);
  return token;
}

/**
 * Byte-for-byte what Media ERP's finance client sends. Rebuilt here rather
 * than imported so that a change to the signing on either side shows up as a
 * failure instead of quietly agreeing with itself.
 */
async function signedPost(orgId: string, p: string, payload: unknown, secret = INBOUND_SECRET): Promise<Res> {
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
      "x-delta-signature": crypto.createHmac("sha256", secret).update(canonical).digest("hex"),
      "x-delta-org": orgId,
    },
    body: raw,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function main() {
  await mongoose.connect(uri);
  // The rule since a seed script once found a production URI in an
  // auto-loaded .env: check where the connection actually went, not only
  // what the string said.
  if (mongoose.connection.host !== "127.0.0.1" || !/e2e/.test(mongoose.connection.db!.databaseName)) {
    console.error(`Refusing to run: connected to ${mongoose.connection.host}/${mongoose.connection.db!.databaseName}`);
    process.exit(1);
  }

  step("Setting up an organization with Marketing and Sales");
  const org = await Organization.create({ name: "Fund Request E2E", baseCurrency: "AED" });
  const orgId = String(org._id);
  for (const def of SYSTEM_ROLES) {
    await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const roleId = (key: string) => roles.find((r) => r.key === key)!._id;
  const marketing = await Department.create({ organizationId: org._id, name: "Marketing" });
  const sales = await Department.create({ organizationId: org._id, name: "Sales" });
  const passwordHash = await hashPassword(PASSWORD);
  await User.create({ name: "Approver", email: "approver@e2e-fund.test", passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: roleId("admin"), status: "active" }] });
  await User.create({ name: "Marketer", email: "marketer@e2e-fund.test", passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: roleId("employee"), departmentId: marketing._id, status: "active" }] });
  const approver = await login("approver@e2e-fund.test");
  const marketer = await login("marketer@e2e-fund.test");
  console.log(`  organization ${orgId}, Marketing ${marketing._id}`);

  const summary = async () => {
    const r = await request("GET", `/budgets/summary?month=${PERIOD}&departmentId=${marketing._id}`, undefined, approver);
    return (r.body?.data ?? []).find((row: any) => row.currency === "AED") ?? {};
  };
  const handOver = (externalId: string, amountMinor: number, extra: Record<string, unknown> = {}) =>
    signedPost(orgId, "/api/v1/integrations/funding-requests", {
      source: SOURCE, externalId, departmentId: String(marketing._id), period: PERIOD, currency: "AED",
      amountMinor, title: `Ad spend ${externalId}`, purpose: "Boosting the October open-day campaign on Meta.",
      platform: "Meta Ads", requestedBy: { name: "Media Planner", email: "planner@e2e-media.test" }, ...extra,
    });
  const review = (id: string, decision: "approved" | "rejected", note = "") =>
    request("POST", `/budgets/requests/${id}/review`, { decision, note }, approver);

  step("Marketing is given 10,000 for October");
  const alloc = await request("PATCH", "/budgets/allocations", { departmentId: String(marketing._id), period: PERIOD, currency: "AED", allocatedMinor: 1_000_000, note: "October" }, approver);
  check("allocation saved", alloc.status === 200, show(alloc));

  step("A fund request arrives from Media ERP");
  const first = await handOver("fr-1", 300_000);
  const fr1 = first.body?.data;
  check("accepted", first.status === 200, show(first));
  check("lands as a drawdown", fr1?.kind === "drawdown", show(first));
  check("waiting for review", fr1?.status === "submitted");
  check("says where it came from", fr1?.source === SOURCE);
  check("keeps the platform", fr1?.platform === "Meta Ads");
  check("keeps the requester's name and address", fr1?.requestedByName === "Media Planner" && fr1?.requestedByEmail === "planner@e2e-media.test");
  check("filed under Marketing", fr1?.departmentName === "Marketing");

  const retry = await handOver("fr-1", 300_000);
  check("a retry returns the same request", retry.status === 200 && retry.body?.data?.id === fr1?.id, show(retry));
  check("and does not make a second one", (await FundingRequestModel.countDocuments({ "external.externalId": "fr-1" })) === 1);

  const indexes = await FundingRequestModel.collection.indexes();
  check("the unique key on the caller's id is in place", indexes.some((i) => i.unique && i.key["external.externalId"] === 1), JSON.stringify(indexes.map((i) => i.name)));
  const [raceA, raceB] = await Promise.all([handOver("fr-dup", 1_000), handOver("fr-dup", 1_000)]);
  check("two deliveries at once still make one request", raceA.body?.data?.id === raceB.body?.data?.id && (await FundingRequestModel.countDocuments({ "external.externalId": "fr-dup" })) === 1, `${show(raceA)} | ${show(raceB)}`);
  await FundingRequestModel.deleteOne({ "external.externalId": "fr-dup" });

  step("What is refused at the door");
  const unknownDept = await handOver("fr-x1", 1_000, { departmentId: String(new Types.ObjectId()) });
  check("a department outside the organization", unknownDept.status === 422, show(unknownDept));
  const noRequester = await handOver("fr-x2", 1_000, { requestedBy: undefined });
  check("no requester", unknownDept.status === 422 && noRequester.status >= 400 && noRequester.status < 500, show(noRequester));
  const badSig = await signedPost(orgId, "/api/v1/integrations/funding-requests", { source: SOURCE, externalId: "fr-x3" }, "not-the-secret-at-all-not-the-secret");
  check("a bad signature", badSig.status === 401, show(badSig));
  const wrongOrg = await signedPost(String(new Types.ObjectId()), "/api/v1/integrations/funding-requests", { source: SOURCE, externalId: "fr-x4" });
  check("an organization that does not exist", wrongOrg.status === 404, show(wrongOrg));
  check("none of them was stored", (await FundingRequestModel.countDocuments({ "external.externalId": { $in: ["fr-x1", "fr-x2", "fr-x3", "fr-x4"] } })) === 0);

  step("Pending changes nothing; approving takes it off the month");
  let s = await summary();
  check("still 10,000 available while pending", s.availableMinor === 1_000_000, JSON.stringify(s));
  check("counted as pending", s.pendingRequests === 1, JSON.stringify(s));
  const ok1 = await review(fr1.id, "approved", "Go ahead");
  check("approved", ok1.status === 200 && ok1.body?.data?.status === "approved", show(ok1));
  s = await summary();
  check("3,000 shown as drawn", s.approvedDrawdownsMinor === 300_000, JSON.stringify(s));
  check("7,000 left", s.availableMinor === 700_000, JSON.stringify(s));
  check("not counted as a top-up", s.approvedRequestsMinor === 0, JSON.stringify(s));

  step("More than is left is refused");
  const big = (await handOver("fr-2", 800_000)).body?.data;
  const refused = await review(big.id, "approved");
  check("refused with a conflict", refused.status === 409, show(refused));
  check("the message says what is left", /7,000\.00 left/.test(refused.body?.error?.message ?? ""), show(refused));
  check("the request is still waiting", (await FundingRequestModel.findById(big.id).lean())?.status === "submitted");
  check("nothing moved", (await summary()).availableMinor === 700_000);

  step("A top-up raised in finance still adds to the month");
  const topup = await request("POST", "/budgets/requests", { period: PERIOD, amountMinor: 200_000, title: "Extra for October", purpose: "Open day needs more reach than planned.", currency: "AED" }, marketer);
  check("raised by the department", topup.status === 201 && topup.body?.data?.kind === "topup" && topup.body?.data?.source === "finance", show(topup));
  const topupOk = await review(topup.body.data.id, "approved");
  check("approved", topupOk.status === 200, show(topupOk));
  s = await summary();
  check("9,000 left after the top-up", s.availableMinor === 900_000, JSON.stringify(s));
  const bigOk = await review(big.id, "approved");
  check("the 8,000 drawdown now fits", bigOk.status === 200, show(bigOk));
  check("1,000 left", (await summary()).availableMinor === 100_000);

  step("Approved expenses count against the same month");
  await Expense.collection.insertOne({
    organizationId: org._id, departmentId: marketing._id, status: "approved", currency: "AED",
    totalMinor: 50_000, amountMinor: 50_000, expenseDate: new Date("2026-10-15T00:00:00Z"),
    expenseNumber: "EXP-E2E-1", category: "Ads", description: "Boost", submittedById: new Types.ObjectId(), submittedByName: "Someone",
  });
  check("500 left", (await summary()).availableMinor === 50_000);
  const over = (await handOver("fr-3", 60_000)).body?.data;
  check("600 refused", (await review(over.id, "approved")).status === 409);
  const exact = (await handOver("fr-4", 50_000)).body?.data;
  check("exactly what is left is allowed", (await review(exact.id, "approved")).status === 200);
  check("nothing left", (await summary()).availableMinor === 0);

  step("Rejecting");
  const noReason = await review(over.id, "rejected", "no");
  check("needs a reason", noReason.status === 422 || noReason.status === 400, show(noReason));
  const rejected = await review(over.id, "rejected", "Over the October budget");
  check("rejected", rejected.status === 200 && rejected.body?.data?.status === "rejected", show(rejected));
  check("and nothing moved", (await summary()).availableMinor === 0);

  step("Media ERP can find out what happened");
  const statuses = await signedPost(orgId, "/api/v1/integrations/funding-requests/status", { source: SOURCE, externalIds: ["fr-1", "fr-3", "fr-4", "fr-unknown"] });
  const byId = new Map<string, any>((statuses.body?.data ?? []).map((row: any) => [row.externalId, row]));
  check("answered", statuses.status === 200, show(statuses));
  check("approved one reported approved, with the approver", byId.get("fr-1")?.status === "approved" && byId.get("fr-1")?.reviewedByName === "Approver");
  check("rejected one carries the reason", byId.get("fr-3")?.status === "rejected" && byId.get("fr-3")?.reviewNote === "Over the October budget");
  check("an id it never saw is simply absent", !byId.has("fr-unknown") && byId.size === 3);
  const otherSource = await signedPost(orgId, "/api/v1/integrations/funding-requests/status", { source: "draw-crm", externalIds: ["fr-1"] });
  check("another source cannot read them", otherSource.status === 200 && (otherSource.body?.data ?? []).length === 0, show(otherSource));

  step("Rows from before drawdowns existed still count as top-ups");
  await FundingRequestModel.collection.insertOne({
    organizationId: org._id, departmentId: marketing._id, period: PERIOD, currency: "AED", amountMinor: 10_000,
    title: "Old", purpose: "Written before kinds existed", status: "approved", requestedById: new Types.ObjectId(),
    requestedByName: "Old", reviewNote: "", createdAt: new Date(), updatedAt: new Date(),
  });
  s = await summary();
  check("added, not taken off", s.availableMinor === 10_000 && s.approvedRequestsMinor === 210_000, JSON.stringify(s));
  const list = await request("GET", `/budgets/requests?month=${PERIOD}`, undefined, approver);
  const old = (list.body?.data ?? []).find((row: any) => row.title === "Old");
  check("and read back as a top-up", old?.kind === "topup" && old?.source === "finance", JSON.stringify(old));

  step("Two approvals racing for the last of the month");
  // 100 left: two requests of 80 each fit alone, never together.
  const a = (await handOver("fr-race-a", 8_000)).body?.data;
  const b = (await handOver("fr-race-b", 8_000)).body?.data;
  const [ra, rb] = await Promise.all([review(a.id, "approved"), review(b.id, "approved")]);
  const approvedCount = [ra, rb].filter((r) => r.status === 200).length;
  s = await summary();
  check("at most one of them went through", approvedCount <= 1, `${show(ra)} | ${show(rb)}`);
  check("the month is not overdrawn", s.availableMinor >= 0, JSON.stringify(s));
  check("anything refused is back waiting for review", (await FundingRequestModel.countDocuments({ _id: { $in: [a.id, b.id] }, status: "submitted" })) === 2 - approvedCount);

  step("Another department's money is untouched");
  const salesRow = (await request("GET", `/budgets/summary?month=${PERIOD}&departmentId=${sales._id}`, undefined, approver)).body?.data ?? [];
  check("Sales has no drawdowns", salesRow.every((row: any) => row.approvedDrawdownsMinor === 0));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
