/**
 * Finance's old books for the sales CRMs and Root (2026-11-25): GET /integrations/old-books/payments?from= —
 * old-books invoices with money paid on or after `from`, each with its salesperson's email, course, fee and every
 * payment (oldest first); other invoices and older money left out; a void one comes with its status. Read-only.
 * Run by scripts/old-books-payments-e2e.sh on a scratch database.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test|scratch/i.test(uri)) { console.error(`Refusing: ${uri}`); process.exit(1); }
let failures = 0, checks = 0;
const check = (label: string, ok: boolean, detail = "") => { checks++; if (ok) console.log(`  ✓ ${label}`); else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); } };
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);

await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { oldBooksPaymentsSince } = await import("../modules/integrations/old-books-payments.service");

const org = new Types.ObjectId(), athira = new Types.ObjectId(), nobody = new Types.ObjectId();
await db.collection("users").insertMany([{ _id: athira, email: "athira@e2e.test", name: "Athira" }]);
const pay = (d: string, a: number) => ({ _id: new Types.ObjectId(), paidOn: new Date(`${d}T00:00:00.000Z`), amountMinor: a * 100, method: "billexpro" });
const inv = (n: string, src: string, sp: Types.ObjectId | null, pays: any[], extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(), organizationId: org, invoiceNumber: n, customerName: `Client ${n}`, salespersonId: sp, salespersonName: "Athira  K",
  external: { source: src, externalId: n }, lineItems: [{ description: "Market Break-out Trading Program — (× 0.5)" }], currency: "AED",
  issueDate: new Date("2026-06-17T00:00:00.000Z"), totalMinor: 120000, balanceMinor: 0, status: "paid", payments: pays, ...extra,
});
await db.collection("invoices").insertMany([
  inv("DMDT1", "old_books", athira, [pay("2026-11-11", 600), pay("2026-06-18", 600)]),
  inv("DMDT2", "old_books", nobody, [pay("2026-11-04", 1000)], { status: "partial", balanceMinor: 50000 }),
  inv("DMDT3", "old_books", athira, [pay("2026-10-03", 599.5)]),
  inv("DMDT4", "old_books", athira, [pay("2026-11-20", 300)], { status: "void" }),
  inv("IN-1", "crm", athira, [pay("2026-11-12", 2250)]),
  inv("IN-2", "", athira, [pay("2026-11-12", 500)]),
]);

const nov = await oldBooksPaymentsSince("2026-11-01");
check("only old-books invoices with money from 1 Nov (3 of 6)", j(nov.map((i) => i.invoiceNumber)) === j(["DMDT1", "DMDT2", "DMDT4"]), j(nov.map((i) => i.invoiceNumber)));
const a = nov.find((i) => i.invoiceNumber === "DMDT1")!;
check("with the salesperson's email, name tidied, course, fee and balance", a.salespersonEmail === "athira@e2e.test" && a.salespersonName === "Athira K" && /Break-out/.test(a.course) && a.totalMinor === 120000 && a.balanceMinor === 0 && a.status === "paid", j(a));
check("every payment on it, oldest first, the June one too", j(a.payments.map((p) => [p.paidOn, p.amountMinor])) === j([["2026-06-18", 60000], ["2026-11-11", 60000]]) && a.payments.every((p) => /^[a-f0-9]{24}$/.test(p.id)), j(a.payments));
check("a salesperson with no account here: email empty", nov.find((i) => i.invoiceNumber === "DMDT2")?.salespersonEmail === "");
check("a void one comes with its status", nov.find((i) => i.invoiceNumber === "DMDT4")?.status === "void");
const oct = await oldBooksPaymentsSince("2026-10-01");
check("from 1 Oct: the October one too", oct.some((i) => i.invoiceNumber === "DMDT3") && oct.length === 4, j(oct.map((i) => i.invoiceNumber)));
check("nothing written", (await db.collection("invoices").countDocuments()) === 6);

console.log(`\n${checks - failures}/${checks} checks passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
