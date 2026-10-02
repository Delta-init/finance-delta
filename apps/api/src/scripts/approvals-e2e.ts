/**
 * Drives GET /approvals/summary — what the sidebar counts, the dashboard
 * pop-up and the Approvals page all read — against a real API process.
 *
 * What it proves:
 *   - every kind is counted from the state its own approve route accepts, and
 *     nothing that is already decided or merely sent back;
 *   - a kind is only there for somebody allowed to decide it;
 *   - your own fund request is not "waiting on you";
 *   - another organization's queue never leaks in;
 *   - an unreadable HRMS is reported on purchase requests alone, and does not
 *     take the other counts down with it;
 *   - deciding something takes it off the count;
 *
 * and GET /approvals/list, the Approvals page's one table:
 *   - Pending is what the summary counts, plus the reader's own requests,
 *     marked as theirs; fund requests and deposits are decided right there;
 *   - Approved and Rejected list what was decided, by whom and why — an
 *     invoice sent back among the rejected, a purchase request's expense as
 *     the purchase request;
 *   - an approved enrolment says whether the LMS made the student's account
 *     and whether Tetra Commission's portal did, or why not;
 *   - filtered by type and by date, paged, newest first, never another
 *     organization's, and only the kinds the reader may decide.
 *
 * Run through scripts/approvals-e2e.sh (throwaway mongod + API, no .env).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Department } from "../modules/department/department.model";
import { Invoice } from "../modules/invoice/invoice.model";
import { Expense } from "../modules/expense/expense.model";
import { Bill } from "../modules/bill/bill.model";
import { PayrollRun } from "../modules/payroll/payroll-run.model";
import { PayrollOrgLink } from "../modules/payroll-mapping/org-link.model";
import { FundingRequestModel } from "../modules/budget/budget.model";
import { TetraDepositModel } from "../modules/tetra-deposit/tetra-deposit.model";
import { LmsProvision } from "../modules/integrations/lms-provision.model";
import { accountantEmails, withAccountants } from "../lib/approval-recipients";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/[^/?]*e2e/.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const ORIGIN = `http://127.0.0.1:${process.env.E2E_API_PORT ?? "4133"}`;
const BASE = `${ORIGIN}/api/v1`;
const API_LOG = process.env.E2E_API_LOG ?? "";
const PASSWORD = "E2ePassword1!";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, detail = "") {
  checks++;
  if (condition) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(name: string) { console.log(`\n\x1b[1m${name}\x1b[0m`); }

type Res = { status: number; body: any };
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
  if (!token) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return token;
}
async function signedPost(orgId: string, p: string, payload: unknown): Promise<Res> {
  const raw = JSON.stringify(payload);
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const canonical = ["POST", p, ts, nonce, crypto.createHash("sha256").update(raw).digest("hex")].join("\n");
  const r = await fetch(`${ORIGIN}${p}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-delta-client": process.env.INBOUND_CLIENT_ID ?? "",
      "x-delta-timestamp": ts, "x-delta-nonce": nonce,
      "x-delta-signature": crypto.createHmac("sha256", process.env.INBOUND_INTEGRATION_SECRET ?? "").update(canonical).digest("hex"),
      "x-delta-org": orgId,
    },
    body: raw,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/**
 * Who a notice went to, read from the scratch API's log. With no mail
 * transport configured, finance logs each message — one per recipient — with
 * its subject and address instead of sending it.
 */
async function recipientsOf(subject: string): Promise<string[]> {
  for (let i = 0; i < 25; i++) {
    const raw = fs.readFileSync(API_LOG, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
    const blocks = raw.split(/\n(?=\[\d{2}:\d{2}:\d{2}\.\d{3}\])/).filter((b) => b.includes("No mail transport configured") && b.includes(subject));
    if (blocks.length) {
      await new Promise((r) => setTimeout(r, 300)); // let the rest of that notice's messages land
      const again = fs.readFileSync(API_LOG, "utf8").replace(/\x1b\[[0-9;]*m/g, "")
        .split(/\n(?=\[\d{2}:\d{2}:\d{2}\.\d{3}\])/).filter((b) => b.includes("No mail transport configured") && b.includes(subject));
      return again.flatMap((b) => [...b.matchAll(/"([^"\s]+@[^"\s]+)"/g)].map((m) => m[1]!));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return [];
}

const summaryOf = async (token: string) => (await request("GET", "/approvals/summary", undefined, token)).body?.data;
const group = (s: any, type: string) => (s?.groups ?? []).find((g: any) => g.type === type);

async function main() {
  await mongoose.connect(uri);
  if (mongoose.connection.host !== "127.0.0.1" || !/e2e/.test(mongoose.connection.db!.databaseName)) {
    console.error(`Refusing to run: connected to ${mongoose.connection.host}/${mongoose.connection.db!.databaseName}`);
    process.exit(1);
  }

  step("Two organizations, and people who decide different things");
  const org = await Organization.create({ name: "Approvals E2E", baseCurrency: "AED" });
  const other = await Organization.create({ name: "Somebody Else", baseCurrency: "AED" });
  for (const o of [org, other]) {
    for (const def of SYSTEM_ROLES) {
      await Role.create({ organizationId: o._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
    }
  }
  const roleId = async (key: string) => (await Role.findOne({ organizationId: org._id, key }).lean())!._id;
  const fundRole = await Role.create({ organizationId: org._id, key: "fund-approver", name: "Fund approver", description: "", permissions: ["budget:approve", "budget:read"], isSystem: false });
  const marketing = await Department.create({ organizationId: org._id, name: "Marketing" });
  const passwordHash = await hashPassword(PASSWORD);
  const mk = (name: string, email: string, role: Types.ObjectId) =>
    User.create({ name, email, passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: role, departmentId: marketing._id, status: "active" }] });
  const admin = await mk("Admin", "admin@e2e-approvals.test", await roleId("admin"));
  const funder = await mk("Funder", "funder@e2e-approvals.test", fundRole._id);
  await mk("Employee", "employee@e2e-approvals.test", await roleId("employee"));
  const tAdmin = await login("admin@e2e-approvals.test");
  const tFunder = await login("funder@e2e-approvals.test");
  const tEmployee = await login("employee@e2e-approvals.test");

  step("Something of every kind, waiting and not");
  const t0 = Date.now();
  const when = (minutesAgo: number) => new Date(t0 - minutesAgo * 60_000);
  const inv = (o: Types.ObjectId, n: string, state: string, minutesAgo: number) => Invoice.collection.insertOne({
    organizationId: o, invoiceNumber: n, customerName: `Client ${n}`, salespersonName: "Rep", totalMinor: 100_00, currency: "AED",
    approval: { state, submittedAt: when(minutesAgo) }, enrolment: { course: "Delta Wave" }, createdAt: when(minutesAgo),
  });
  await inv(org._id, "IN-1", "pending", 30);
  await inv(org._id, "IN-2", "pending", 10);
  await inv(org._id, "IN-3", "approved", 5);
  await inv(org._id, "IN-4", "returned", 5);
  await inv(other._id, "IN-X", "pending", 1);

  const fr = (by: Types.ObjectId | null, title: string, status: string, external = false) => FundingRequestModel.create({
    organizationId: org._id, departmentId: marketing._id, period: "2026-09", currency: "AED", amountMinor: 500_00, title,
    purpose: "Enough words for a purpose line.", status, kind: external ? "drawdown" : "topup",
    ...(external ? { external: { source: "media-erp", externalId: title }, platform: "Google Ads" } : { requestedById: by }),
    requestedByName: external ? "Media Planner" : "Someone",
  });
  const frMedia = await fr(null, "Ads for October", "submitted", true);
  await fr(admin._id, "Admin's own top-up", "submitted");
  await fr(funder._id, "Already decided", "approved");

  const exp = (n: string, status: string) => Expense.collection.insertOne({
    organizationId: org._id, expenseNumber: n, category: "Travel", description: `Claim ${n}`, submittedByName: "Staff",
    totalMinor: 50_00, currency: "AED", status, createdAt: when(20), updatedAt: when(20),
  });
  await exp("EX-1", "submitted"); await exp("EX-2", "submitted"); await exp("EX-3", "submitted"); await exp("EX-4", "approved");
  await Bill.collection.insertOne({ organizationId: org._id, billNumber: "BL-1", vendorName: "Printer Co", totalMinor: 900_00, currency: "AED", status: "pending_approval", dueDate: when(-60 * 24), createdAt: when(15), updatedAt: when(15) });
  await Bill.collection.insertOne({ organizationId: org._id, billNumber: "BL-2", vendorName: "Paid Co", totalMinor: 900_00, currency: "AED", status: "approved", dueDate: when(0), createdAt: when(15), updatedAt: when(15) });
  // Each from its own HRMS organization: a month is imported once per HRMS
  // organization (a unique index), so three runs of one month need three.
  const run = (n: string, status: string) => PayrollRun.collection.insertOne({
    organizationId: org._id, runNumber: n, period: "2026-09", status, currency: "AED", payableMinor: 10_000_00, hrmsOrgId: `hrms-${n}`, hrmsOrgName: "Delta HRMS", importedAt: when(40),
  });
  await run("PR-1", "imported"); await run("PR-2", "additions"); await run("PR-3", "approved");

  step("An approver of everything");
  let s = await summaryOf(tAdmin);
  check("every kind is there", ["invoice", "fund_request", "expense", "bill", "payroll", "procurement"].every((t) => group(s, t)), JSON.stringify(s?.groups?.map((g: any) => g.type)));
  check("2 invoices waiting — not approved, not sent back, not the other organization's", group(s, "invoice")?.count === 2, JSON.stringify(group(s, "invoice")));
  check("newest invoice first", group(s, "invoice")?.items?.[0]?.title === "Client IN-2");
  check("invoices link to the invoice", group(s, "invoice")?.items?.[0]?.href?.startsWith("/invoices/"));
  check("1 fund request — their own top-up is not waiting on them", group(s, "fund_request")?.count === 1, JSON.stringify(group(s, "fund_request")));
  check("and it says it came from Media ERP", /Media ERP/.test(group(s, "fund_request")?.items?.[0]?.subtitle ?? ""));
  check("3 claims", group(s, "expense")?.count === 3);
  check("1 bill", group(s, "bill")?.count === 1 && group(s, "bill")?.items?.[0]?.href?.startsWith("/bills/"));
  check("2 payroll runs (imported and with additions)", group(s, "payroll")?.count === 2);
  check("no purchase requests with no HRMS linked", group(s, "procurement")?.count === 0 && !group(s, "procurement")?.unavailable);
  check("total is the sum", s?.total === 2 + 1 + 3 + 1 + 2, String(s?.total));

  step("Somebody who only decides fund requests");
  s = await summaryOf(tFunder);
  check("sees fund requests and nothing else", s?.groups?.length === 1 && s.groups[0].type === "fund_request", JSON.stringify(s?.groups?.map((g: any) => g.type)));
  check("both of them — neither is theirs", group(s, "fund_request")?.count === 2);
  check("and the total says so", s?.total === 2);

  step("Somebody who decides nothing");
  s = await summaryOf(tEmployee);
  check("no kinds, nothing waiting", s?.groups?.length === 0 && s?.total === 0, JSON.stringify(s));
  const anon = await request("GET", "/approvals/summary");
  check("not signed in is refused", anon.status === 401, String(anon.status));

  step("HRMS unreadable");
  await PayrollOrgLink.collection.insertOne({ organizationId: org._id, hrmsOrgId: "hrms-org-e2e", hrmsOrgName: "Delta HRMS", isActive: true, createdAt: new Date(), updatedAt: new Date() });
  s = await summaryOf(tAdmin);
  check("purchase requests say they could not be read", !!group(s, "procurement")?.unavailable, JSON.stringify(group(s, "procurement")));
  check("and count nothing", group(s, "procurement")?.count === 0);
  check("the other kinds are unaffected", s?.total === 9 && group(s, "invoice")?.count === 2);

  step("Deciding takes it off the count");
  const reviewed = await request("POST", `/budgets/requests/${frMedia._id}/review`, { decision: "rejected", note: "Not this month" }, tAdmin);
  check("rejected", reviewed.status === 200, JSON.stringify(reviewed.body).slice(0, 200));
  s = await summaryOf(tAdmin);
  check("no fund requests waiting now", group(s, "fund_request")?.count === 0);
  check("total down by one", s?.total === 8, String(s?.total));

  step("Accountants hear about every approval request");
  const accountantRole = await roleId("accountant");
  const accountant = await mk("Accountant", "accountant@e2e-approvals.test", accountantRole);
  await User.create({ name: "Gone", email: "gone@e2e-approvals.test", passwordHash, status: "suspended", memberships: [{ organizationId: org._id, roleId: accountantRole, status: "active" }] });
  await User.create({ name: "Invited", email: "invited@e2e-approvals.test", passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: accountantRole, status: "invited" }] });
  const elsewhereRole = (await Role.findOne({ organizationId: other._id, key: "accountant" }).lean())!._id;
  await User.create({ name: "Elsewhere", email: "elsewhere@e2e-approvals.test", passwordHash, status: "active", memberships: [{ organizationId: other._id, roleId: elsewhereRole, status: "active" }] });

  const accountants = await accountantEmails(String(org._id));
  check("only this organization's active accountant — not suspended, not invited, not elsewhere", accountants.length === 1 && accountants[0] === "accountant@e2e-approvals.test", JSON.stringify(accountants));
  const merged = await withAccountants(String(org._id), ["Admin@e2e-approvals.test", "admin@e2e-approvals.test", "ACCOUNTANT@e2e-approvals.test"]);
  check("each address once, whatever its case", merged.length === 2, JSON.stringify(merged));
  check("never the person who raised it", (await withAccountants(String(org._id), [], [String(accountant._id)])).length === 0);

  const topup = await request("POST", "/budgets/requests", { period: "2026-10", amountMinor: 250_00, title: "Top-up for the mail check", purpose: "Checking who is told about it.", currency: "AED" }, tEmployee);
  check("a top-up raised in finance", topup.status === 201, JSON.stringify(topup.body).slice(0, 200));
  const topupTo = await recipientsOf("Fund request: Top-up for the mail check");
  check("…is mailed to the accountant, and only the accountant", topupTo.length === 1 && topupTo[0] === "accountant@e2e-approvals.test", JSON.stringify(topupTo));

  const drawdown = await signedPost(String(org._id), "/api/v1/integrations/funding-requests", {
    source: "media-erp", externalId: "mail-check-1", departmentId: String(marketing._id), period: "2026-10", currency: "AED",
    amountMinor: 700_00, title: "Drawdown for the mail check", purpose: "Checking who is told about it.", platform: "TikTok",
    requestedBy: { name: "Media Planner", email: "planner@e2e-media.test" },
  });
  check("a Media ERP drawdown", drawdown.status === 200, JSON.stringify(drawdown.body).slice(0, 200));
  const drawdownTo = await recipientsOf("Fund request: Drawdown for the mail check");
  check("…is mailed to its approvers and the accountant", ["admin@e2e-approvals.test", "funder@e2e-approvals.test", "accountant@e2e-approvals.test"].every((e) => drawdownTo.includes(e)), JSON.stringify(drawdownTo));
  check("…each of them once", drawdownTo.length === new Set(drawdownTo).size, JSON.stringify(drawdownTo));
  check("…and nobody suspended, invited or elsewhere", !drawdownTo.some((e) => /gone|invited|elsewhere/.test(e)), JSON.stringify(drawdownTo));

  const vendor = await request("POST", "/vendors", { name: "Printer Co", email: "vendor@e2e-approvals.test", phone: "+971500000001" }, tAdmin);
  const bill = await request("POST", "/bills", {
    vendorId: vendor.body?.data?.id, billDate: "2026-09-28", dueDate: "2026-10-28", currency: "AED",
    lineItems: [{ description: "Brochures", quantity: 1, unitPriceMinor: 1200_00 }], requiresApproval: true,
  }, tAdmin);
  check("a bill held for approval", bill.status === 201 && bill.body?.data?.status === "pending_approval", JSON.stringify(bill.body).slice(0, 200));
  const billTo = await recipientsOf(`Bill ${bill.body?.data?.billNumber} needs approval`);
  check("…is mailed to the accountant", billTo.length === 1 && billTo[0] === "accountant@e2e-approvals.test", JSON.stringify(billTo));
  const plain = await request("POST", "/bills", {
    vendorId: vendor.body?.data?.id, billDate: "2026-09-28", dueDate: "2026-10-28", currency: "AED",
    lineItems: [{ description: "Paper", quantity: 1, unitPriceMinor: 100_00 }],
  }, tAdmin);
  check("a bill that needs no approval mails nobody", plain.status === 201 && (await recipientsOf(`Bill ${plain.body?.data?.billNumber} needs approval`)).length === 0);

  step("The table: every approval, waiting and decided");
  const show = (v: unknown) => JSON.stringify(v).slice(0, 300);
  const decidedInvoice = (n: string, state: string, minutesAgo: number, extra: Record<string, unknown> = {}) => Invoice.collection.insertOne({
    organizationId: org._id, invoiceNumber: n, customerName: `Client ${n}`, salespersonName: "Rep", totalMinor: 200_00, currency: "AED",
    approval: { state, submittedAt: when(minutesAgo + 60), at: when(minutesAgo), byName: "Approver A", ...extra },
    enrolment: { course: "Forex Pro" }, createdAt: when(minutesAgo + 60),
  });
  const in5 = (await decidedInvoice("IN-5", "approved", 3)).insertedId;
  const in6 = (await decidedInvoice("IN-6", "approved", 4)).insertedId;
  const in7 = (await decidedInvoice("IN-7", "approved", 6)).insertedId;
  const in8 = (await decidedInvoice("IN-8", "approved", 7)).insertedId;
  await decidedInvoice("IN-9", "approved", 8);
  await decidedInvoice("IN-10", "returned", 2, { byName: "Approver B", returnedReason: "Wrong fee" });
  const provision = (invoiceId: unknown, rest: Record<string, unknown>) => LmsProvision.collection.insertOne({
    organizationId: org._id, invoiceId, invoiceNumber: "", payload: {}, attempts: 1, createdAt: new Date(), updatedAt: new Date(), ...rest,
  });
  await provision(in5, { status: "sent", studentCreated: true, lmsCourseTitle: "Forex Pro", source: "crm", commission: { state: "sent", studentCode: "STU-9001", team: "Team A", mentorName: "Mentor M" } });
  await provision(in6, { status: "sent", studentCreated: false, source: "crm", commission: { state: "skipped", reason: "Not a Forex course (digital-marketing)" } });
  await provision(in7, { status: "failed", lastError: "Course not found in the LMS", source: "crm" });
  await provision(in8, { status: "sent", studentCreated: true, source: "draw-crm" });
  await Expense.collection.insertOne({
    organizationId: org._id, expenseNumber: "EX-5", category: "Travel", description: "Claim EX-5", submittedByName: "Staff", totalMinor: 30_00,
    currency: "AED", status: "rejected", approvedByName: "Approver C", approvedAt: when(1), rejectedReason: "No receipt", createdAt: when(30), updatedAt: when(1),
  });
  await Expense.collection.insertOne({
    organizationId: org._id, expenseNumber: "EX-P", category: "Office", description: "2 × Chairs", submittedByName: "Admin", totalMinor: 400_00,
    currency: "AED", status: "approved", approvedByName: "Admin", approvedAt: when(9), createdAt: when(9), updatedAt: when(9),
    source: { kind: "hrms_procurement", key: "hrms-org-e2e:req-1:0", hrmsOrgId: "hrms-org-e2e", requestId: "req-1", round: 0 },
  });
  await PayrollRun.collection.insertOne({
    organizationId: org._id, runNumber: "PR-4", hrmsOrgId: "hrms-PR-4", period: "2026-08", status: "paid", currency: "AED", payableMinor: 5_000_00, hrmsOrgName: "Delta HRMS",
    importedAt: when(100), approvedById: admin._id, approvedAt: when(10), updatedAt: when(10),
  });
  await PayrollRun.collection.insertOne({
    organizationId: org._id, runNumber: "PR-5", hrmsOrgId: "hrms-PR-5", period: "2026-07", status: "returned", currency: "AED", payableMinor: 5_000_00, hrmsOrgName: "Delta HRMS",
    importedAt: when(100), returnedReason: "Wrong month", updatedAt: when(11),
  });
  await Bill.collection.insertOne({ organizationId: org._id, billNumber: "BL-3", vendorName: "Rejected Co", totalMinor: 300_00, currency: "AED", status: "draft", approvalStatus: "rejected", createdAt: when(30), updatedAt: when(12) });
  const deposit = (externalId: string, status: string, minutesAgo: number, extra: Record<string, unknown> = {}) => TetraDepositModel.collection.insertOne({
    organizationId: org._id, externalId, amountMinor: 1_000_00, currency: "USD", student: { name: `Student ${externalId}`, code: `ST-${externalId}` },
    paymentMethod: "Bank", status, requestedAt: when(minutesAgo + 30), createdAt: when(minutesAgo + 30), updatedAt: when(minutesAgo), ...extra,
  });
  await deposit("D1", "pending", 0);
  await deposit("D2", "approved", 13, { decision: { decidedByName: "Admin", decidedAt: when(13), approvedAmountMinor: 900_00 }, delivery: { state: "failed", lastError: "Student not found" } });
  await deposit("D3", "rejected", 14, { decision: { decidedByName: "Admin", decidedAt: when(14), reason: "Proof unreadable" }, delivery: { state: "delivered" } });
  await deposit("D4", "closed", 15, { closedReason: "Withdrawn at Tetra" });

  const listOf = async (token: string, params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString();
    const r = await request("GET", `/approvals/list${qs ? `?${qs}` : ""}`, undefined, token);
    return { status: r.status, rows: (r.body?.data ?? []) as any[], meta: r.body?.meta };
  };
  const rowOf = (l: { rows: any[] }, type: string, title: string) => l.rows.find((r) => r.type === type && r.title === title);
  const newestFirst = (rows: any[]) => rows.every((r, i) => i === 0 || String(rows[i - 1].at ?? "") >= String(r.at ?? ""));

  const pendingList = await listOf(tAdmin, { pageSize: 100 });
  s = await summaryOf(tAdmin);
  check("Pending by default: only what waits, newest first", pendingList.status === 200 && pendingList.rows.length > 0
    && pendingList.rows.every((r) => r.status === "pending") && newestFirst(pendingList.rows), show(pendingList.rows.map((r) => [r.type, r.status])));
  check("everything the summary counts, and the reader's own request besides — marked as theirs",
    pendingList.meta?.total === s.total + 1 && rowOf(pendingList, "fund_request", "Admin's own top-up")?.own === true, `${pendingList.meta?.total} / summary ${s?.total}`);
  check("fund requests and deposits waiting are decided right here",
    rowOf(pendingList, "fund_request", "Drawdown for the mail check")?.decideHere === true && rowOf(pendingList, "tetra_deposit", "Student D1")?.decideHere === true);
  check("purchase requests HRMS cannot answer for are named, the rest still listed",
    (pendingList.meta?.unavailable ?? []).some((u: string) => /Purchase requests/.test(u)), show(pendingList.meta?.unavailable));
  check("another organization's never", !pendingList.rows.some((r) => r.title === "Client IN-X"));

  const approvedList = await listOf(tAdmin, { status: "approved", pageSize: 100 });
  const a5 = rowOf(approvedList, "invoice", "Client IN-5");
  check("Approved: an enrolment the LMS made an account for, and the commission portal too — with the code, and who approved it",
    a5?.lms?.state === "created" && a5?.commission?.state === "created" && a5?.commission?.code === "STU-9001" && a5?.decidedBy === "Approver A", show(a5));
  const a6 = rowOf(approvedList, "invoice", "Client IN-6");
  check("…a student who already had an LMS account, on a course that is not Forex, so not sent to the portal",
    a6?.lms?.state === "existing" && a6?.commission?.state === "skipped" && /Not a Forex/.test(a6?.commission?.detail ?? ""), show(a6));
  const a7 = rowOf(approvedList, "invoice", "Client IN-7");
  check("…one the LMS turned down, saying why, the portal waiting on it",
    a7?.lms?.state === "failed" && /Course not found/.test(a7?.lms?.detail ?? "") && a7?.commission?.state === "waiting", show(a7));
  check("…one of Draw's, which does not go to the portal", rowOf(approvedList, "invoice", "Client IN-8")?.commission?.state === "not_sent");
  check("…and an invoice with no enrolment to follow, with nothing to report",
    !rowOf(approvedList, "invoice", "Client IN-9")?.lms && !rowOf(approvedList, "invoice", "Client IN-9")?.commission);
  check("a purchase request approved here is listed as the purchase request, not as a claim",
    rowOf(approvedList, "procurement", "2 × Chairs")?.decidedBy === "Admin" && !approvedList.rows.some((r) => r.type === "expense" && r.title === "2 × Chairs"));
  check("a paid payroll run counts as approved, with who approved it", rowOf(approvedList, "payroll", "PR-4 · August 2026")?.decidedBy === "Admin",
    show(rowOf(approvedList, "payroll", "PR-4 · August 2026")));
  const d2 = rowOf(approvedList, "tetra_deposit", "Student D2");
  check("an approved deposit Tetra Commission did not take says so, at the amount approved",
    d2?.delivery?.state === "failed" && d2?.amountMinor === 900_00, show(d2));
  check("nothing waiting or turned down among them, newest first",
    approvedList.rows.every((r) => r.status === "approved") && newestFirst(approvedList.rows));

  const rejectedList = await listOf(tAdmin, { status: "rejected", pageSize: 100 });
  const r10 = rowOf(rejectedList, "invoice", "Client IN-10");
  check("Rejected: an invoice sent back, why, and by whom", r10?.status === "returned" && r10?.reason === "Wrong fee" && r10?.decidedBy === "Approver B", show(r10));
  check("…the fund request rejected earlier, with its note, and who rejected it",
    rowOf(rejectedList, "fund_request", "Ads for October")?.reason === "Not this month" && rowOf(rejectedList, "fund_request", "Ads for October")?.decidedBy === "Admin");
  check("…a claim, a payroll run sent back, a bill and a deposit",
    rowOf(rejectedList, "expense", "Claim EX-5")?.reason === "No receipt" && rowOf(rejectedList, "payroll", "PR-5 · July 2026")?.reason === "Wrong month"
    && !!rowOf(rejectedList, "bill", "Rejected Co") && rowOf(rejectedList, "tetra_deposit", "Student D3")?.reason === "Proof unreadable", show(rejectedList.rows.map((r) => r.title)));
  check("nothing else", rejectedList.rows.every((r) => r.status === "rejected" || r.status === "returned"));

  const everything = await listOf(tAdmin, { status: "all", pageSize: 100 });
  check("All: waiting, approved and rejected together — and a deposit closed at Tetra's end",
    everything.meta?.total === pendingList.meta.total + approvedList.meta.total + rejectedList.meta.total + 1
    && rowOf(everything, "tetra_deposit", "Student D4")?.status === "closed", `${everything.meta?.total}`);

  const enrolments = await listOf(tAdmin, { status: "approved", type: "invoice" });
  check("by type: approved enrolment invoices alone", enrolments.rows.every((r) => r.type === "invoice") && enrolments.meta?.total === 6, `${enrolments.meta?.total}`);
  const inRange = await listOf(tAdmin, { status: "approved", type: "invoice", from: when(6.5).toISOString(), to: when(3.5).toISOString() });
  check("by date: only what was decided inside the range, newest first",
    show(inRange.rows.map((r) => r.title)) === show(["Client IN-6", "Client IN-3", "Client IN-7"]), show(inRange.rows.map((r) => r.title)));
  const second = await listOf(tAdmin, { status: "approved", type: "invoice", pageSize: 2, page: 2 });
  check("paged: the second two of six", show(second.rows.map((r) => r.title)) === show(["Client IN-3", "Client IN-7"]) && second.meta?.pageCount === 3,
    show([second.rows.map((r) => r.title), second.meta]));

  const funderList = await listOf(tFunder, { status: "all", pageSize: 100 });
  check("somebody who decides only fund requests sees only fund requests", funderList.rows.length > 0 && funderList.rows.every((r) => r.type === "fund_request"));
  const employeeList = await listOf(tEmployee, { status: "all" });
  check("somebody who decides nothing sees nothing", employeeList.status === 200 && employeeList.meta?.total === 0, show(employeeList));
  check("not signed in is refused", (await request("GET", "/approvals/list")).status === 401);
  check("a status that does not exist is refused", (await listOf(tAdmin, { status: "maybe" })).status === 422);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
