/**
 * A client's "Receives emails" switch (the user, 2026-11-16: "client default true, can receive mails, but we can
 * manually change it to not receive"):
 *
 *   1. New clients receive emails; turning off keeps who, when and why; another edit leaves that alone; on clears it.
 *      Only a Manager, an Accountant, an Administrator or a Super Admin changes it — not a salesperson.
 *   2. The list filters by it.
 *   3. Off: none of the 7 client emails go — invoice, approved invoice, resend, payment tax invoice, course payment
 *      receipt, overdue reminder, instalment reminder — each logged "opted_out". Staff emails to the same address go.
 *      Mixed recipients: only the client's address is held back. Another organization's client is its own.
 *   4. The instalment reminder pass settles it as skipped (not failed, not retried).
 *   5. Back on: emails go again.
 *
 * No mail transport here: what would go is logged "not_configured" — nothing leaves. Run through
 * scripts/client-email-optout-e2e.sh. Scratch databases only.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { EmailLog } = await import("../modules/email-log/email-log.model");
const customers = await import("../modules/customer/customer.service");
const email = await import("../lib/email");
const { runInstalmentReminders } = await import("../jobs/instalment-reminder.worker");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

await mongoose.connect(uri);
for (const c of await mongoose.connection.db!.listCollections().toArray()) await mongoose.connection.db!.collection(c.name).deleteMany({});
const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const other = await Organization.create({ name: "Bangalore E2E", baseCurrency: "INR" });
const orgId = String(org._id);
const mona = await User.create({ name: "Mona Manager", email: "mona@e2e-optout.test", passwordHash: "x", status: "active", memberships: [] });
const manager = { userId: String(mona._id), permissions: ["customer:update", "customer:emails"], isSuperAdmin: false };
const salesperson = { userId: String(new Types.ObjectId()), permissions: ["customer:update", "customer:create"], isSuperAdmin: false };
const superAdmin = { userId: String(mona._id), permissions: [], isSuperAdmin: true };
const base = { phone: "0500000000", companyName: "", vatNumber: "", discountPct: 0, billingAddress: {}, shippingAddress: {}, tagIds: [] } as any;

step("1. The switch");
const abel = await customers.createCustomer(orgId, { ...base, name: "Abel Client", email: "abel@e2e-optout.test" }, salesperson);
check("a new client receives emails", abel.receivesEmails === true && abel.emailsOff === null, JSON.stringify(abel));
let refused = "";
try { await customers.createCustomer(orgId, { ...base, name: "Bea Client", email: "bea@e2e-optout.test", receivesEmails: false }, salesperson); } catch (e) { refused = (e as Error).message; }
check("a salesperson may not create one with emails off", /Only a Manager/.test(refused), refused);
refused = "";
try { await customers.updateCustomer(orgId, abel.id, { receivesEmails: false }, salesperson); } catch (e) { refused = (e as Error).message; }
check("…nor turn them off", /Only a Manager/.test(refused), refused);
const same = await customers.updateCustomer(orgId, abel.id, { phone: "0500000001", receivesEmails: true }, salesperson);
check("a salesperson's other edit, sending the setting unchanged: fine", same.phone === "0500000001" && same.receivesEmails === true);
const off = await customers.updateCustomer(orgId, abel.id, { receivesEmails: false, emailsOffReason: "Asked not to be emailed" }, manager);
check("a Manager turns them off: who, when and why kept", off.receivesEmails === false && off.emailsOff?.byName === "Mona Manager" && off.emailsOff?.reason === "Asked not to be emailed" && !!off.emailsOff?.at, JSON.stringify(off.emailsOff));
const edited = await customers.updateCustomer(orgId, abel.id, { companyName: "Abel LLC", receivesEmails: false }, salesperson);
check("another edit leaves that as it was", edited.receivesEmails === false && edited.emailsOff?.at === off.emailsOff?.at && edited.emailsOff?.byName === "Mona Manager", JSON.stringify(edited.emailsOff));
const bea = await customers.createCustomer(orgId, { ...base, name: "Bea Client", email: "bea@e2e-optout.test", receivesEmails: false, emailsOffReason: "Bounced" }, superAdmin);
check("a Super Admin may create one with emails off", bea.receivesEmails === false && bea.emailsOff?.reason === "Bounced");
await customers.createCustomer(String(other._id), { ...base, name: "Abel Elsewhere", email: "abel@e2e-optout.test" }, salesperson);

step("2. The list");
const q = (emails?: "on" | "off") => customers.listCustomers(orgId, { page: 1, pageSize: 50, emails } as any);
check("emails off: Abel and Bea", (await q("off")).data.map((c) => c.name).sort().join() === "Abel Client,Bea Client");
check("emails on: neither", (await q("on")).data.length === 0);
check("all: both", (await q()).data.length === 2);

step("3. Off: the client's emails are held back");
const log = (kind: string, organizationId: string = orgId) => ({ organizationId, kind });
const latest = async (kind: string, to: string) => (await EmailLog.find({ kind, to }).sort({ _id: -1 }).limit(1).lean<any[]>())[0];
const to = "abel@e2e-optout.test";
const inv = { orgName: "Delta", invoiceNumber: "IN-1", customerName: "Abel", totalFormatted: "AED 10", dueDate: "2026-12-01" };
for (const kind of ["invoice", "invoice_approved", "invoice_resend"]) {
  const r = await email.sendInvoiceEmail({ to, ...inv, log: log(kind) });
  check(`${kind}: not sent, logged opted_out`, r.error === "opted_out" && (await latest(kind, to))?.state === "opted_out", JSON.stringify(r));
}
let n = await email.sendNotice({ to: [to], subject: "Tax invoice", title: "t", lines: ["x"], log: log("payment_tax_invoice") });
check("payment_tax_invoice: not sent", n.sent === 0 && n.skipped === "opted_out" && (await latest("payment_tax_invoice", to))?.state === "opted_out", JSON.stringify(n));
n = await email.sendNotice({ to: ["ABEL@e2e-optout.test "], subject: "Receipt", title: "t", lines: ["x"], log: log("course_payment_receipt") });
check("course_payment_receipt (address in other case): not sent", n.skipped === "opted_out", JSON.stringify(n));
let r = await email.sendReminderEmail({ to, ...inv, intervalDays: 1, log: log("reminder") });
check("reminder: not sent", r.error === "opted_out", JSON.stringify(r));
r = await email.sendInstalmentReminderEmail({ to, orgName: "Delta", customerName: "Abel", course: "C", invoiceNumber: "IN-1", balance: "AED 5", total: "AED 10", paid: "AED 5",
  dueDate: "2026-12-01", dueDateLong: "1 December 2026", daysBefore: 3, bank: null, log: log("instalment_reminder") } as any);
check("instalment_reminder: not sent", r.error === "opted_out", JSON.stringify(r));
n = await email.sendNotice({ to: [to], subject: "Staff", title: "t", lines: ["x"], log: log("notice") });
check("a staff notice to the same address: goes (not held back)", n.skipped === "not_configured" && (await latest("notice", to))?.state === "not_configured", JSON.stringify(n));
r = await email.sendInvoiceEmail({ to: "staff@e2e-optout.test", ...inv, log: log("invoice_salesperson") });
check("the salesperson's copy: goes", r.error === "not_configured", JSON.stringify(r));
n = await email.sendNotice({ to: [to, "cara@e2e-optout.test"], subject: "Two", title: "t", lines: ["x"], log: log("payment_tax_invoice") });
check("two addresses, one a client with emails off: only that one held back", (await latest("payment_tax_invoice", to))?.state === "opted_out" && (await latest("payment_tax_invoice", "cara@e2e-optout.test"))?.state === "not_configured", JSON.stringify(n));
r = await email.sendInvoiceEmail({ to, ...inv, log: log("invoice", String(other._id)) });
check("the same address as another organization's client (emails on): goes", r.error === "not_configured", JSON.stringify(r));

step("4. The instalment reminder pass");
// The UAE day, as the pass reads it, three days on.
const uae = new Date(Date.now() + 4 * 3600e3);
const due = new Date(Date.UTC(uae.getUTCFullYear(), uae.getUTCMonth(), uae.getUTCDate() + 3));
await Invoice.collection.insertOne({
  organizationId: org._id, customerId: new Types.ObjectId(abel.id), customerName: "Abel Client", invoiceNumber: "IN-OPT-1", status: "partial",
  approval: { state: "approved" }, currency: "AED", totalMinor: 100000, amountPaidMinor: 50000, balanceMinor: 50000, dueDate: due, lineItems: [], payments: [],
} as any);
const run = await runInstalmentReminders(new Date());
const rem = await mongoose.connection.db!.collection("instalmentreminders").findOne({ invoiceNumber: "IN-OPT-1" });
check("settled as skipped — emails turned off, not failed", (run as any).skipped >= 1 && rem?.state === "skipped" && /turned off/.test(String(rem?.reason)), `${JSON.stringify(run)} ${JSON.stringify(rem)}`);

step("5. Back on");
const on = await customers.updateCustomer(orgId, abel.id, { receivesEmails: true }, manager);
check("on again: who and why cleared", on.receivesEmails === true && on.emailsOff === null, JSON.stringify(on));
r = await email.sendInvoiceEmail({ to, ...inv, log: log("invoice") });
check("its invoice email goes again", r.error === "not_configured", JSON.stringify(r));

await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
