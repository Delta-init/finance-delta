/**
 * Deleting (the user, 2026-10-16: "we need delete option … invoice … payment
 * receipt … bill also can't delete … expense delete also"), against a real API:
 *
 *   Invoices   any status once nothing is paid against it; with payments,
 *              refused until each is deleted (the balance and status worked
 *              out again); a credit note, a balance payment or a Tetra payment
 *              referring to it refuses; an enrolment's queued LMS provisioning
 *              and its instalment reminders stop with it, a done one stays;
 *   Bills      a payment can be deleted (status worked out again: part paid,
 *              then back to approved), then the bill; not on a voided bill;
 *   Expenses   any status, paid too; one from HRMS or posted by payroll refused;
 *   Rights     an employee is refused each of them.
 *
 * Run through scripts/deletes-e2e.sh (throwaway mongod + API, no .env).
 */
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Department } from "../modules/department/department.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/[^/?]*e2e/.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const BASE = `http://127.0.0.1:${process.env.E2E_API_PORT ?? "4135"}/api/v1`;
const PASSWORD = "E2ePassword1!";

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => (JSON.stringify(v) ?? String(v)).slice(0, 300);
async function request(method: string, p: string, token?: string, body?: unknown) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
async function login(email: string) {
  const r = await request("POST", "/auth/login", undefined, { email, password: PASSWORD });
  const t = r.body?.data?.accessToken as string | undefined;
  if (!t) throw new Error(`login failed for ${email}: ${show(r.body)}`);
  return t;
}

async function main() {
  await mongoose.connect(uri);
  if (mongoose.connection.host !== "127.0.0.1" || !/e2e/.test(mongoose.connection.db!.databaseName)) process.exit(1);
  await mongoose.connection.db!.dropDatabase();
  const db = mongoose.connection.db!;

  const org = await Organization.create({ name: "Deletes E2E", baseCurrency: "AED" });
  for (const def of SYSTEM_ROLES) {
    await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
  }
  const roleId = async (key: string) => (await Role.findOne({ organizationId: org._id, key }).lean())!._id;
  const dept = await Department.create({ organizationId: org._id, name: "Accounts" });
  const passwordHash = await hashPassword(PASSWORD);
  const mk = (name: string, email: string, role: Types.ObjectId) =>
    User.create({ name, email, passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: role, departmentId: dept._id, status: "active" }] });
  const admin = await mk("Admin", "admin@e2e-deletes.test", await roleId("admin"));
  await mk("Employee", "employee@e2e-deletes.test", await roleId("employee"));
  const tA = await login("admin@e2e-deletes.test");
  const tE = await login("employee@e2e-deletes.test");

  const customerId = new Types.ObjectId();
  const day = (d: number) => new Date(Date.now() + d * 86_400_000);
  const invoice = async (n: string, status: string, payments: number[] = [], extra: Record<string, unknown> = {}) => {
    const paid = payments.reduce((a, b) => a + b, 0);
    const _id = new Types.ObjectId();
    await db.collection("invoices").insertOne({
      _id, organizationId: org._id, invoiceNumber: n, customerId, customerName: "Client", salespersonId: admin._id, salespersonName: "Admin",
      issueDate: day(-5), dueDate: day(25), currency: "AED", lineItems: [], totalMinor: 100_00, amountPaidMinor: paid, balanceMinor: 100_00 - paid, status,
      payments: payments.map((a) => ({ _id: new Types.ObjectId(), method: "cash", amountMinor: a, paidOn: day(-1), reference: "", notes: "" })),
      approval: { state: "not_required" }, createdAt: day(-5), updatedAt: day(-5), ...extra,
    });
    return String(_id);
  };
  const inv = async (id: string) => db.collection("invoices").findOne({ _id: new Types.ObjectId(id) });

  step("Invoices");
  const sent = await invoice("IN-1", "sent");
  let r = await request("DELETE", `/invoices/${sent}`, tE);
  check("an employee cannot delete an invoice (403)", r.status === 403, `${r.status}`);
  r = await request("DELETE", `/invoices/${sent}`, tA);
  check("a sent invoice with nothing paid: deleted", r.status === 204 && !(await inv(sent)), `${r.status} ${show(r.body)}`);
  const paidInv = await invoice("IN-2", "paid", [60_00, 40_00]);
  r = await request("DELETE", `/invoices/${paidInv}`, tA);
  check("a paid invoice: refused while its 2 payments are there, saying to delete them first", r.status === 409 && /2 payments/.test(r.body?.error?.message ?? ""), show(r.body));
  const [p1, p2] = ((await inv(paidInv))!.payments as any[]).map((p) => String(p._id));
  r = await request("DELETE", `/invoices/${paidInv}/payments/${p1}`, tE);
  check("an employee cannot delete a payment (403)", r.status === 403);
  r = await request("DELETE", `/invoices/${paidInv}/payments/${p1}`, tA);
  let doc = await inv(paidInv);
  check("deleting one payment: part paid, 40 paid, 60 owing", r.status === 200 && doc?.status === "partial" && doc.amountPaidMinor === 40_00 && doc.balanceMinor === 60_00, show(doc && { s: doc.status, p: doc.amountPaidMinor }));
  r = await request("DELETE", `/invoices/${paidInv}/payments/${p2}`, tA);
  doc = await inv(paidInv);
  check("…the last one: nothing paid, back to sent", r.status === 200 && doc?.status === "sent" && doc.amountPaidMinor === 0, show(doc?.status));
  r = await request("DELETE", `/invoices/${paidInv}`, tA);
  check("…and then the invoice can be deleted", r.status === 204 && !(await inv(paidInv)), `${r.status}`);

  const credited = await invoice("IN-3", "sent");
  await db.collection("creditnotes").insertOne({ organizationId: org._id, creditNoteNumber: "CN-1", invoiceId: new Types.ObjectId(credited), invoiceNumber: "IN-3", customerId, customerName: "Client", reason: "x" });
  r = await request("DELETE", `/invoices/${credited}`, tA);
  check("a credit note refers to it: refused", r.status === 409 && /credit note/.test(r.body?.error?.message ?? ""), show(r.body));
  const bal = await invoice("IN-4", "partial", [], { amountPaidMinor: 0 });
  await db.collection("balancepayments").insertOne({ organizationId: org._id, source: "crm", externalId: "bp-1", invoiceId: new Types.ObjectId(bal), amountMinor: 10_00, currency: "AED", method: "cash", paidOn: "2026-10-15" });
  r = await request("DELETE", `/invoices/${bal}`, tA);
  check("a sales CRM balance payment refers to it: refused", r.status === 409 && /balance payment/.test(r.body?.error?.message ?? ""), show(r.body));
  const tetra = await invoice("IN-5", "sent");
  await db.collection("tetradeposits").insertOne({ organizationId: org._id, externalId: "td-1", courseInvoice: { invoiceId: new Types.ObjectId(tetra) } });
  r = await request("DELETE", `/invoices/${tetra}`, tA);
  check("a CS Portal payment refers to it: refused", r.status === 409 && /CS Portal/.test(r.body?.error?.message ?? ""), show(r.body));

  const enrol = await invoice("IN-6", "sent", [], { enrolment: { course: "MBT", modeOfStudy: "online", language: "English" }, external: { source: "crm", externalId: "close-1" } });
  const done = await invoice("IN-7", "sent", [], { enrolment: { course: "MBT", modeOfStudy: "online", language: "English" }, external: { source: "crm", externalId: "close-2" } });
  await db.collection("lmsprovisions").insertMany([
    { organizationId: org._id, invoiceId: new Types.ObjectId(enrol), invoiceNumber: "IN-6", source: "crm", status: "pending", payload: {} },
    { organizationId: org._id, invoiceId: new Types.ObjectId(done), invoiceNumber: "IN-7", source: "crm", status: "sent", payload: {} },
  ]);
  await db.collection("instalmentreminders").insertOne({ organizationId: org._id, invoiceId: new Types.ObjectId(enrol), dueOn: "2026-11-01", daysBefore: 3 });
  r = await request("DELETE", `/invoices/${enrol}`, tA);
  check("a sales CRM enrolment can be deleted", r.status === 204, `${r.status} ${show(r.body)}`);
  check("…its LMS provisioning still queued stops, and its instalment reminders", !(await db.collection("lmsprovisions").findOne({ invoiceId: new Types.ObjectId(enrol) }))
    && !(await db.collection("instalmentreminders").findOne({ invoiceId: new Types.ObjectId(enrol) })));
  r = await request("DELETE", `/invoices/${done}`, tA);
  check("…one already in the LMS: deleted, and its provisioning record kept (what was done stays done)", r.status === 204
    && !!(await db.collection("lmsprovisions").findOne({ invoiceId: new Types.ObjectId(done) })));

  step("Bills");
  const bill = async (n: string, status: string, payments: number[]) => {
    const paid = payments.reduce((a, b) => a + b, 0);
    const _id = new Types.ObjectId();
    await db.collection("bills").insertOne({
      _id, organizationId: org._id, billNumber: n, vendorId: new Types.ObjectId(), vendorName: "Printer Co", billDate: day(-3), dueDate: day(27),
      currency: "AED", lineItems: [], totalMinor: 90_00, amountPaidMinor: paid, balanceMinor: 90_00 - paid, status,
      payments: payments.map((a) => ({ _id: new Types.ObjectId(), method: "cash", amountMinor: a, paidOn: day(-1) })), attachments: [],
      createdAt: day(-3), updatedAt: day(-3),
    });
    return String(_id);
  };
  const billDoc = async (id: string) => db.collection("bills").findOne({ _id: new Types.ObjectId(id) });
  const b1 = await bill("BL-1", "paid", [30_00, 60_00]);
  r = await request("DELETE", `/bills/${b1}`, tA);
  check("a bill with payments: refused", r.status === 409 && /payments recorded/.test(r.body?.error?.message ?? ""), show(r.body));
  const [bp1, bp2] = ((await billDoc(b1))!.payments as any[]).map((p) => String(p._id));
  r = await request("DELETE", `/bills/${b1}/payments/${bp1}`, tE);
  check("an employee cannot delete a bill payment (403)", r.status === 403);
  r = await request("DELETE", `/bills/${b1}/payments/${bp1}`, tA);
  let bd = await billDoc(b1);
  check("deleting a bill payment: part paid, 60 paid, 30 owing", r.status === 200 && bd?.status === "partially_paid" && bd.amountPaidMinor === 60_00 && bd.balanceMinor === 30_00, show(bd && { s: bd.status, p: bd.amountPaidMinor }));
  r = await request("DELETE", `/bills/${b1}/payments/${bp2}`, tA);
  bd = await billDoc(b1);
  check("…the last one: back to approved, nothing paid", r.status === 200 && bd?.status === "approved" && bd.amountPaidMinor === 0, show(bd?.status));
  r = await request("DELETE", `/bills/${b1}`, tA);
  check("…and then the bill can be deleted", r.status === 204 && !(await billDoc(b1)), `${r.status}`);
  const b2 = await bill("BL-2", "voided", [10_00]);
  const vp = String(((await billDoc(b2))!.payments as any[])[0]._id);
  r = await request("DELETE", `/bills/${b2}/payments/${vp}`, tA);
  check("a payment on a voided bill: refused", r.status === 409, `${r.status}`);
  r = await request("DELETE", `/bills/${b2}/payments/${new Types.ObjectId()}`, tA);
  check("a payment that isn't there: 404", r.status === 404 || r.status === 409, `${r.status}`);

  step("Expenses");
  const expense = async (n: string, status: string, extra: Record<string, unknown> = {}) => {
    const _id = new Types.ObjectId();
    await db.collection("expenses").insertOne({
      _id, organizationId: org._id, expenseNumber: n, category: "other", description: `Spend ${n}`, totalMinor: 25_00, currency: "AED",
      status, expenseDate: day(-2), attachments: [], createdAt: day(-2), updatedAt: day(-2), ...extra,
    });
    return String(_id);
  };
  const expDoc = async (id: string) => db.collection("expenses").findOne({ _id: new Types.ObjectId(id) });
  const e1 = await expense("EXP-1", "draft");
  r = await request("DELETE", `/expenses/${e1}`, tE);
  check("an employee cannot delete an expense (403)", r.status === 403, `${r.status}`);
  r = await request("DELETE", `/expenses/${e1}`, tA);
  check("a draft expense: deleted", r.status === 204 && !(await expDoc(e1)), `${r.status} ${show(r.body)}`);
  const e2 = await expense("EXP-2", "approved", { paidOn: day(-1), paymentStatus: "paid" });
  r = await request("DELETE", `/expenses/${e2}`, tA);
  check("an approved, paid expense: deleted", r.status === 204 && !(await expDoc(e2)), `${r.status}`);
  const e3 = await expense("EXP-3", "voided");
  r = await request("DELETE", `/expenses/${e3}`, tA);
  check("a voided expense: deleted", r.status === 204, `${r.status}`);
  const e4 = await expense("EXP-4", "approved", { source: { kind: "hrms_procurement", key: "hrms:o:r:0", hrmsOrgId: "o", requestId: "r", round: 0 } });
  r = await request("DELETE", `/expenses/${e4}`, tA);
  check("one from HRMS: refused, saying to void it", r.status === 409 && /came from HRMS/.test(r.body?.error?.message ?? "") && !!(await expDoc(e4)), show(r.body));
  const e5 = await expense("EXP-5", "approved");
  await db.collection("payrollruns").insertOne({ organizationId: org._id, runNumber: "PR-1", hrmsOrgId: "o", period: "2026-09", status: "paid", currency: "AED", payments: [{ _id: new Types.ObjectId(), amountMinor: 25_00, expenseId: new Types.ObjectId(e5) }] });
  r = await request("DELETE", `/expenses/${e5}`, tA);
  check("one a payroll payment posted: refused", r.status === 409 && /payroll/.test(r.body?.error?.message ?? ""), show(r.body));
  r = await request("DELETE", `/expenses/${new Types.ObjectId()}`, tA);
  check("one that isn't there: 404", r.status === 404, `${r.status}`);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
