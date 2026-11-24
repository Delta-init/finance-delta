/**
 * scripts/move-enrolment-crm.ts against a scratch database: a Sales CRM enrolment moved to Draw — the dry run changing
 * nothing; the refusals (a balance payment or course change still waiting, the old sale already in a commission payout,
 * the Draw id on another invoice, a void invoice, an unknown CRM) changing nothing; the write moving the source, the
 * CRM's id, the CRM tag, the salesperson (an account made with no access when they have none; theirs when they have
 * one) and who closed it, and the LMS row's source — the money, lines, payments and approval untouched; a second run
 * refused; the undo putting it all back.
 *
 * Run through scripts/move-enrolment-crm-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { Organization } = await import("../modules/organization/organization.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { User } = await import("../modules/user/user.model");
const { LmsProvision } = await import("../modules/integrations/lms-provision.model");
const { moveEnrolmentCrm, undoMoveEnrolmentCrm } = await import("./move-enrolment-crm");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 500);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const dir = mkdtempSync(`${tmpdir()}/move-enrolment-crm-e2e-`);

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const other = await Organization.create({ name: "Elsewhere E2E", baseCurrency: "AED" });
const CUST = new Types.ObjectId();
const gopika = await User.collection.insertOne({ name: "Rep Sales", email: "rep.sales@e2e.local", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(), status: "active" }] } as never);
// Somebody who has an account, but in another organization only.
await User.collection.insertOne({ name: "Rep Elsewhere", email: "rep.elsewhere@e2e.local", passwordHash: "x", status: "active", memberships: [{ organizationId: other._id, roleId: new Types.ObjectId(), status: "active" }] } as never);
const SALES_STUDENT = "6afdaa0098bfe176ae43c2aa", DRAW_STUDENT = "6b057080f5adda5893d20daa";
const invId = new Types.ObjectId();
const base = {
  organizationId: org._id, customerId: CUST, customerName: "Client Test", issueDate: new Date("2026-11-18"), dueDate: new Date("2026-11-18"), currency: "AED", exchangeRate: 1, taxInclusive: true,
  lineItems: [{ description: "COURSE ONE", quantity: 1, unitPriceMinor: 225_000, discountPct: 0, taxes: [], lineSubtotalMinor: 214_286, discountMinor: 0, taxableMinor: 214_286, taxTotalMinor: 10_714, lineTotalMinor: 225_000 }],
  subtotalMinor: 214_286, discountTotalMinor: 0, taxBreakdown: [], taxTotalMinor: 10_714, roundOffMinor: 0, totalMinor: 225_000, baseTotalMinor: 225_000,
  amountPaidMinor: 225_000, balanceMinor: 0, payments: [{ _id: new Types.ObjectId(), amountMinor: 225_000, method: "tamara", receiptNumber: "RCT-00077", paidOn: new Date("2026-11-18") }],
  approval: { state: "approved", byName: "Approver", at: new Date("2026-11-18T14:05:24Z") }, createdAt: new Date(), updatedAt: new Date(),
};
await Invoice.collection.insertOne({
  _id: invId, invoiceNumber: "IN-00456", status: "paid", salespersonId: gopika.insertedId, salespersonName: "Rep Sales", ...base,
  enrolment: { course: "COURSE ONE", modeOfStudy: "online", language: "Malayalam", meetingBy: "Rep Sales", meetingByEmail: "rep.sales@e2e.local", crm: "delta", academy: "dubai" },
  external: { source: "crm", externalId: SALES_STUDENT, flags: [] },
} as never);
await LmsProvision.collection.insertOne({ invoiceId: invId, invoiceNumber: "IN-00456", status: "sent", source: "crm", payload: { email: "client@e2e.local", crm: "delta" }, commission: { state: "sent" } } as never);
const snapshot = async () => {
  const i = await Invoice.findById(invId).lean<any>();
  return j({ lines: i.lineItems, total: i.totalMinor, paid: i.amountPaidMinor, balance: i.balanceMinor, status: i.status, payments: i.payments, approval: i.approval, customer: i.customerId, course: i.enrolment.course, academy: i.enrolment.academy });
};
const money = await snapshot();
const opts = { invoice: "IN-00456", to: "draw", externalId: DRAW_STUDENT, salespersonEmail: "rep.draw@e2e.local", salespersonName: "Rep Draw", crmSale: "6afdaa1438c65b87cd06ecaa", write: false, dir };
const state = async () => {
  const i = await Invoice.findById(invId).lean<any>();
  const p = await LmsProvision.findOne({ invoiceId: invId }).lean<any>();
  return j([i.external.source, i.external.externalId, i.enrolment.crm, String(i.salespersonId), i.salespersonName, i.enrolment.meetingBy, i.enrolment.meetingByEmail, p.source, p.payload.crm]);
};
const s0 = await state();

step("Dry run");
let r = await moveEnrolmentCrm(opts);
check("says what moves, and what stays", r.lines.some((l) => /delta \(crm 6afdaa0098bfe176ae43c2aa\) → draw \(draw-crm 6b057080f5adda5893d20daa\)/.test(l)) && r.lines.some((l) => /Rep Sales → Rep Draw \(an account made for them, no access\)/.test(l))
  && r.lines.some((l) => /crm \/ delta → draw-crm \/ draw/.test(l)) && r.lines.some((l) => /unchanged/.test(l)), r.lines.join("\n"));
check("nothing written, no account made", (await state()) === s0 && !(await User.findOne({ email: "rep.draw@e2e.local" })), await state());

step("Refusals");
const bp = await db.collection("balancepayments").insertOne({ organizationId: org._id, invoiceId: invId, status: "pending", source: "crm", externalId: "bp-1" });
const cc = await db.collection("coursechanges").insertOne({ organizationId: org._id, invoiceId: invId, status: "pending", source: "crm", externalId: "cc-1" });
const po = await db.collection("crmcommissionpayouts").insertOne({ key: "delta:2026-11:x", organizationId: org._id, crm: "delta", month: "2026-11", personName: "Rep Sales", saleIds: [opts.crmSale], state: "approved" });
const taken = await Invoice.collection.insertOne({ _id: new Types.ObjectId(), invoiceNumber: "IN-00457", status: "paid", salespersonId: gopika.insertedId, salespersonName: "Rep Sales", ...base, external: { source: "draw-crm", externalId: DRAW_STUDENT, flags: [] } } as never);
let m = await refusal(moveEnrolmentCrm({ ...opts, write: true }));
check("a waiting balance payment, a waiting course change, the sale in a payout, the id on another invoice: refused as one list",
  /balance payment\(s\) on IN-00456 still waiting/.test(m) && /course change on IN-00456 is still waiting/.test(m) && /in Rep Sales's delta commission for 2026-11, already approved/.test(m) && /IN-00457 already is draw's student/.test(m), m);
check("…nothing written", (await state()) === s0 && !(await User.findOne({ email: "rep.draw@e2e.local" })));
await db.collection("balancepayments").deleteOne({ _id: bp.insertedId });
await db.collection("coursechanges").deleteOne({ _id: cc.insertedId });
await db.collection("crmcommissionpayouts").deleteOne({ _id: po.insertedId });
await Invoice.collection.deleteOne({ _id: taken.insertedId });
await Invoice.collection.updateOne({ _id: invId }, { $set: { status: "void" } });
m = await refusal(moveEnrolmentCrm({ ...opts, write: true }));
check("a void invoice: refused", /IN-00456 is void/.test(m), m);
await Invoice.collection.updateOne({ _id: invId }, { $set: { status: "paid" } });
m = await refusal(moveEnrolmentCrm({ ...opts, to: "nowhere", write: true }));
check("an unknown CRM: refused", /--to "nowhere"/.test(m), m);
m = await refusal(moveEnrolmentCrm({ ...opts, externalId: "STU-0037", write: true }));
check("an id that isn't one: refused", /--external-id "STU-0037"/.test(m), m);
check("…still nothing written", (await state()) === s0);

step("Write");
r = await moveEnrolmentCrm({ ...opts, write: true });
const inv = await Invoice.findById(invId).lean<any>();
const made = await User.findOne({ email: "rep.draw@e2e.local" }).lean<any>();
check("the CRM, its student, the tag: Draw's", inv.external.source === "draw-crm" && inv.external.externalId === DRAW_STUDENT && inv.enrolment.crm === "draw", j(inv.external));
check("the salesperson: an account made for them in this organization, no access, on the invoice", !!made && made.memberships.length === 1 && String(made.memberships[0].organizationId) === String(org._id)
  && String(inv.salespersonId) === String(made._id) && inv.salespersonName === "Rep Draw", j(made));
check("who closed it: Rep Draw <rep.draw@e2e.local>", inv.enrolment.meetingBy === "Rep Draw" && inv.enrolment.meetingByEmail === "rep.draw@e2e.local");
const prov = await LmsProvision.findOne({ invoiceId: invId }).lean<any>();
check("the LMS row: draw-crm / draw, the rest of it kept", prov.source === "draw-crm" && prov.payload.crm === "draw" && prov.payload.email === "client@e2e.local" && prov.commission.state === "sent", j(prov));
check("the money, lines, payments, approval, customer, course and academy untouched", (await snapshot()) === money);
check("a backup in the folder given", !!r.backupFile && r.backupFile.startsWith(dir) && existsSync(r.backupFile), r.backupFile);
m = await refusal(moveEnrolmentCrm({ ...opts, write: true }));
check("again: refused, already Draw's", /already draw's, student 6b057080f5adda5893d20daa/.test(m), m);

step("Undo");
let u = await undoMoveEnrolmentCrm(r.backupFile!, false);
check("a dry run says what goes back, changes nothing", /back to crm 6afdaa0098bfe176ae43c2aa, Rep Sales, crm delta/.test(u[0]!) && /Nothing written/.test(u.at(-1)!) && (await Invoice.findById(invId).lean<any>()).external.source === "draw-crm", u.join("\n"));
u = await undoMoveEnrolmentCrm(r.backupFile!, true);
check("--write: the invoice and its LMS row back exactly", (await state()) === s0 && (await snapshot()) === money, await state());

step("A salesperson with an account here");
const own = await User.collection.insertOne({ name: "Rep Draw Here", email: "rep.here@e2e.local", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(), status: "active" }] } as never);
const users = await User.countDocuments();
r = await moveEnrolmentCrm({ ...opts, salespersonEmail: "REP.HERE@e2e.local", salespersonName: "Rep Here", write: true });
const inv2 = await Invoice.findById(invId).lean<any>();
check("their own account, its own name; none made", String(inv2.salespersonId) === String(own.insertedId) && inv2.salespersonName === "Rep Draw Here" && (await User.countDocuments()) === users && inv2.enrolment.meetingByEmail === "rep.here@e2e.local", j([inv2.salespersonName, inv2.enrolment]));
await undoMoveEnrolmentCrm(r.backupFile!, true);
m = await refusal(moveEnrolmentCrm({ ...opts, salespersonEmail: "rep.elsewhere@e2e.local", salespersonName: "Rep Elsewhere", write: true }));
const elsewhere = await User.findOne({ email: "rep.elsewhere@e2e.local" }).lean<any>();
check("an account in another organization only: added to this one, used", !m && elsewhere.memberships.length === 2 && String((await Invoice.findById(invId).lean<any>()).salespersonId) === String(elsewhere._id), m || j(elsewhere.memberships));

await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
