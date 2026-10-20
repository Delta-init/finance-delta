/**
 * Salespeople on the Users page, and editing everything about a user (the user, 2026-10-20) — finance's services in
 * this process, on a scratch database:
 *
 *   1. The list: payroll-only accounts with their sales, last sale and CRMs; CRM salespeople with no account here,
 *      one with an account in another organization marked so; the search.
 *   2. Making a payroll account a user: a real role (not Payroll employee), the department, Manager; the password set
 *      works; the same account — its invoices still its own; one who can already sign in is refused.
 *   3. An account for a CRM salesperson: created, their invoices moved to them and the "no account here" flag gone;
 *      without moving, left; one already here refused; one in another organization gets this one added.
 *   4. Editing: email (taken by another — refused; changed — signs in with it), a new password, status, name.
 *   5. The rules the screens send by: an invite or a password needed to make a user.
 *
 * Run through scripts/salespeople-e2e.sh. Scratch databases only.
 */
import mongoose from "mongoose";
import { convertSalespersonSchema, createCrmSalespersonSchema, updateUserSchema } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Role } = await import("../modules/role/role.model");
const { Department } = await import("../modules/department/department.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { verifyPassword } = await import("../lib/password");
const users = await import("../modules/user/user.service");
const sp = await import("../modules/user/salespeople.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 400);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const other = await Organization.create({ name: "Delta Bangalore E2E", baseCurrency: "INR" });
const ORG = String(org._id);
const admin = await Role.create({ organizationId: org._id, key: "admin", name: "Administrator", permissions: ["*"] });
const salesRole = await Role.create({ organizationId: org._id, key: "salesperson", name: "Salesperson", permissions: ["invoice:write:own"] });
const payrollRole = await Role.create({ organizationId: org._id, key: "payroll-employee", name: "Payroll employee", permissions: [] });
const otherRole = await Role.create({ organizationId: other._id, key: "salesperson", name: "Salesperson", permissions: [] });
const sales = await Department.create({ organizationId: org._id, name: "Sales" });
const person = (name: string, email: string, roleId: unknown, orgId: unknown = org._id) => User.create({
  name, email, passwordHash: "x", status: "active", memberships: [{ organizationId: orgId, roleId, status: "active" }],
});
const boss = await person("Boss Admin", "boss@e2e.test", admin._id);
const jalwa = await person("Jalwa", "jalwa@e2e.test", payrollRole._id);
const neethu = await person("Neethu", "neethu@e2e.test", payrollRole._id);
await person("Bangalore Bina", "bina@e2e.test", otherRole._id, other._id);
const actor = { userId: String(boss._id), isSuperAdmin: false };

let n = 0;
const invoice = (salespersonId: unknown, name: string, meetingByEmail: string, meetingBy: string, crm: string, flags: string[] = []) => Invoice.collection.insertOne({
  organizationId: org._id, invoiceNumber: `INV-${++n}`, salespersonId, salespersonName: name, status: "sent",
  issueDate: new Date(Date.UTC(2026, 9, n)), enrolment: { meetingByEmail, meetingBy, crm }, external: { source: "crm", externalId: `x${n}`, flags },
});
await invoice(jalwa._id, "Jalwa", "jalwa@e2e.test", "Jalwa", "delta");
await invoice(jalwa._id, "Jalwa", "jalwa@e2e.test", "Jalwa", "delta");
await invoice(boss._id, "Boss Admin", "ria@e2e.test", "Ria", "delta", ["Ria has no account here — reassign this invoice to the right person.", "other flag"]);
await invoice(boss._id, "Boss Admin", "ria@e2e.test", "Ria", "delta", ["Ria has no account here — reassign this invoice to the right person."]);
await invoice(boss._id, "Boss Admin", "bina@e2e.test", "Bina", "banglore");
await invoice(boss._id, "Boss Admin", "sam@e2e.test", "Sam", "draw");

step("1. The list");
const l = await sp.listSalespeople(ORG);
const pj = l.payroll.find((p) => p.name === "Jalwa");
check("payroll-only accounts listed — not the administrator", l.payroll.map((p) => p.name).join() === "Jalwa,Neethu", j(l.payroll));
check("…Jalwa's 2 sales, the latest, the CRM", pj?.invoices === 2 && pj.crms.join() === "delta" && !!pj.lastSaleAt, j(pj));
check("…Neethu, no sales", l.payroll.find((p) => p.name === "Neethu")?.invoices === 0);
const mRia = l.missing.find((m) => m.email === "ria@e2e.test");
check("CRM salespeople with no account here: Ria (2), Bina, Sam", l.missing.map((m) => m.email).sort().join() === "bina@e2e.test,ria@e2e.test,sam@e2e.test" && mRia?.invoices === 2 && mRia.name === "Ria", j(l.missing));
check("…Bina has an account in another organization", l.missing.find((m) => m.email === "bina@e2e.test")?.elsewhere === true && mRia?.elsewhere === false);
check("…someone with an account here is not missing (Jalwa)", !l.missing.some((m) => m.email === "jalwa@e2e.test"));
const s = await sp.listSalespeople(ORG, "neet");
check("the search narrows both lists", s.payroll.map((p) => p.name).join() === "Neethu" && s.missing.length === 0, j(s));

step("2. Making a payroll account a user");
check("to Payroll employee: refused", /Pick a role that can sign in/.test(await refusal(sp.convertSalesperson(ORG, String(jalwa._id), { roleId: String(payrollRole._id) }))));
check("to another organization's role: refused", /isn't one of this organization's/.test(await refusal(sp.convertSalesperson(ORG, String(jalwa._id), { roleId: String(otherRole._id) }))));
const c1 = await sp.convertSalesperson(ORG, String(jalwa._id), { roleId: String(salesRole._id), departmentId: String(sales._id), isManager: true, password: "jalwa-secret-1" });
const j1 = await User.findById(jalwa._id).lean();
const m1 = j1!.memberships.find((m) => String(m.organizationId) === ORG)!;
check("Salesperson, Sales, Manager — the same account", c1.id === String(jalwa._id) && String(m1.roleId) === String(salesRole._id) && String(m1.departmentId) === String(sales._id) && m1.isManager === true, j(m1));
check("…the password set works", await verifyPassword("jalwa-secret-1", j1!.passwordHash));
check("…her invoices still hers", (await Invoice.countDocuments({ salespersonId: jalwa._id })) === 2);
check("…off the salespeople list, on the team list", !(await sp.listSalespeople(ORG)).payroll.some((p) => p.name === "Jalwa") && (await users.listUsers(ORG, { page: 1, pageSize: 50, excludePayrollOnly: true } as never)).data.some((u) => u.name === "Jalwa"));
check("asked again: refused (she can already sign in)", /can already sign in/.test(await refusal(sp.convertSalesperson(ORG, String(jalwa._id), { roleId: String(salesRole._id) }))));
const c2 = await sp.convertSalesperson(ORG, String(neethu._id), { roleId: String(salesRole._id) });
const n2 = await User.findById(neethu._id).lean();
check("with an invite instead of a password: the role given, the password untouched", c2.id === String(neethu._id) && n2!.passwordHash === "x");

step("3. An account for a CRM salesperson");
const r1 = await sp.createFromCrm(ORG, { email: "RIA@e2e.test", name: "Ria R", roleId: String(salesRole._id), password: "ria-secret-12", moveInvoices: true });
const riaInv = await Invoice.find({ "enrolment.meetingByEmail": "ria@e2e.test" }).lean<any[]>();
check("created, her 2 invoices moved to her", r1.moved === 2 && riaInv.every((i) => String(i.salespersonId) === r1.id && i.salespersonName === "Ria R"), j(r1));
check("…the \"no account here\" flag gone, other flags kept", riaInv.every((i) => !i.external.flags.some((f: string) => /no account here/.test(f))) && riaInv.some((i) => i.external.flags.includes("other flag")), j(riaInv.map((i) => i.external.flags)));
check("…she signs in with the password set", await verifyPassword("ria-secret-12", (await User.findById(r1.id).lean())!.passwordHash));
const r2 = await sp.createFromCrm(ORG, { email: "sam@e2e.test", name: "Sam", roleId: String(salesRole._id), moveInvoices: false });
check("without moving: his invoice left where it was", r2.moved === 0 && (await Invoice.countDocuments({ "enrolment.meetingByEmail": "sam@e2e.test", salespersonId: boss._id })) === 1);
check("one already here: refused", /already has an account here/.test(await refusal(sp.createFromCrm(ORG, { email: "sam@e2e.test", name: "Sam", roleId: String(salesRole._id) }))));
const r3 = await sp.createFromCrm(ORG, { email: "bina@e2e.test", name: "Bina", roleId: String(salesRole._id), moveInvoices: true });
const bina = await User.findById(r3.id).lean();
check("an account in another organization: this one added to it, both kept", bina!.memberships.length === 2 && r3.moved === 1, j(bina!.memberships));
check("the list has nobody missing now", (await sp.listSalespeople(ORG)).missing.length === 0);

step("4. Editing everything");
check("an email another account has: refused", /already belongs to another account/.test(await refusal(users.updateUser(ORG, String(jalwa._id), { email: "Ria@e2e.test" }, actor))));
const e1 = await users.updateUser(ORG, String(jalwa._id), { email: "Jalwa.New@E2E.test", name: "Jalwa K", status: "suspended", password: "brand-new-pass" }, actor);
const j2 = await User.findById(jalwa._id).lean();
check("email (lower-cased), name, status saved", e1.email === "jalwa.new@e2e.test" && e1.name === "Jalwa K" && e1.status === "suspended", j(e1));
check("…the new password works, the old one not", await verifyPassword("brand-new-pass", j2!.passwordHash) && !(await verifyPassword("jalwa-secret-1", j2!.passwordHash)));
const e2 = await users.updateUser(ORG, String(jalwa._id), { email: "jalwa.new@e2e.test", status: "active" }, actor);
check("the same email again: fine", e2.email === "jalwa.new@e2e.test" && e2.status === "active");

step("5. The rules the screens send by");
check("making a user with neither an invite nor a password: refused", !convertSalespersonSchema.safeParse({ roleId: "r" }).success);
check("…with an invite: fine; with a password: fine", convertSalespersonSchema.safeParse({ roleId: "r", sendInvite: true }).success && convertSalespersonSchema.safeParse({ roleId: "r", password: "12345678" }).success);
check("creating one: moving invoices is the default", createCrmSalespersonSchema.parse({ email: "a@b.co", name: "Ab", roleId: "r" }).moveInvoices === true);
check("an edit: a short password refused, a bad email refused", !updateUserSchema.safeParse({ password: "short" }).success && !updateUserSchema.safeParse({ email: "nope" }).success);

console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
