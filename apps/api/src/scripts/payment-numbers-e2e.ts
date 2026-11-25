/**
 * Finance's payment numbers for Root's Manager TV export (2026-11-25): /service/payment-numbers — each invoice asked
 * by number or by the CRM's id for the close, with its payments' TI and receipt numbers; void invoices left out; the
 * same number in two organizations answers from both, each saying which. Read-only.
 * Run through scripts/payment-numbers-e2e.sh (throwaway mongod).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) { console.error(`Refusing: ${uri}`); process.exit(1); }
const { paymentNumbersFor } = await import("../modules/integrations/payment-numbers.service");
let failures = 0, checks = 0;
const check = (label: string, ok: boolean, detail = "") => { checks++; if (ok) console.log(`  ✓ ${label}`); else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); } };
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 500);

await mongoose.connect(uri);
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const HQ = new Types.ObjectId(), BLR = new Types.ObjectId();
const pay = (d: string, a: number, o: Record<string, unknown> = {}) => ({ _id: new Types.ObjectId(), paidOn: new Date(`${d}T00:00:00.000Z`), amountMinor: a, ...o });
await db.collection("invoices").insertMany([
  { organizationId: HQ, invoiceNumber: "IN-00396", status: "paid", proforma: { at: new Date() }, payments: [pay("2026-11-11", 20_000, { taxInvoice: { number: "TI-00073" }, receiptNumber: "RCT-1" }), pay("2026-11-19", 205_000, { taxInvoice: { number: "TI-00076" } })] },
  { organizationId: HQ, invoiceNumber: "IN-00405", status: "paid", external: { source: "crm", externalId: "student-sooraj" }, payments: [pay("2026-11-12", 225_000)] },
  { organizationId: HQ, invoiceNumber: "IN-00050", status: "paid", payments: [pay("2026-11-01", 100)] },
  { organizationId: BLR, invoiceNumber: "IN-00050", status: "paid", payments: [pay("2026-11-10", 5_737_500, { receiptNumber: "RCT-B9" })] },
  { organizationId: HQ, invoiceNumber: "IN-00999", status: "void", payments: [pay("2026-11-20", 100)] },
]);
const r = await paymentNumbersFor(["IN-00396", "IN-00050", "IN-00999", "", "IN-00396"], ["student-sooraj"]);
const by = (n: string) => r.filter((x) => x.invoiceNumber === n);
check("a pro-forma's payments with their TI and receipt numbers, by day and amount", j(by("IN-00396")[0]?.payments.map((p) => [p.paidOn, p.amountMinor, p.taxInvoiceNumber, p.receiptNumber])) === j([["2026-11-11", 20000, "TI-00073", "RCT-1"], ["2026-11-19", 205000, "TI-00076", ""]]), j(by("IN-00396")));
check("asked by the CRM's id: IN-00405, with that id", by("IN-00405").length === 1 && by("IN-00405")[0]!.externalId === "student-sooraj", j(by("IN-00405")));
check("the same number in two organizations: both, each saying which", by("IN-00050").length === 2 && new Set(by("IN-00050").map((x) => x.organizationId)).size === 2, j(by("IN-00050")));
check("a void invoice left out", by("IN-00999").length === 0);
check("nothing asked: nothing", (await paymentNumbersFor([], [])).length === 0);
check("nothing written", (await db.collection("invoices").countDocuments()) === 5);
console.log(`\n${checks - failures}/${checks} checks passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
