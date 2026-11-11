/**
 * Enrolments from before quotes brought to the Zoho Books way (the user, 2026-11-11: "exact same as the quotation
 * based system same as the Zoho Books have … and backfill current invoice also"):
 *
 *   1. every pro-forma becomes an ordinary invoice for the whole fee — its payments stay recorded against it, the
 *      TI numbers stay on them as the record of what was sent, and its VAT is counted on the invoice's own date again
 *      (not payment by payment). CHECK WITH THE ACCOUNTANT FIRST: this moves VAT between periods.
 *   2. every close still waiting in Approvals, or sent back, gets its quote (QT-…). It keeps its invoice number.
 *
 * Reads only unless --write is given. With --write it leaves an undo file beside it, and --undo <file> puts back
 * what that run changed.
 *
 *   cd apps/api && bun src/scripts/enrolment-quotes-backfill.ts                    # look
 *   cd apps/api && bun src/scripts/enrolment-quotes-backfill.ts --write            # do it
 *   cd apps/api && bun src/scripts/enrolment-quotes-backfill.ts --undo <file>      # put it back
 *   … --org <organization id>                                                      # one organization only
 *
 * Uses MONGODB_URI from the environment (the API's .env) — run it where the finance API runs, after the API deploy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import mongoose from "mongoose";
import { backfillEnrolmentQuotes, undoEnrolmentQuotesBackfill, type BackfillResult } from "../modules/quotation/enrolment-quotes-backfill";

const uri = process.env.MONGODB_URI ?? "";
if (!uri) {
  console.error("Set MONGODB_URI (the finance API's database).");
  process.exit(1);
}
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const write = process.argv.includes("--write");
const undoFile = arg("--undo");
const orgId = arg("--org");

await mongoose.connect(uri);
const orgs = new Map((await mongoose.connection.db!.collection("organizations").find({}, { projection: { name: 1 } }).toArray()).map((o) => [String(o._id), String(o.name)]));
const money = (m: number, c: string) => `${c} ${(m / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

if (undoFile) {
  const done = JSON.parse(readFileSync(undoFile, "utf8")) as BackfillResult;
  const r = await undoEnrolmentQuotesBackfill(done);
  console.log(`Put back: ${r.proformas} pro-forma${r.proformas === 1 ? "" : "s"}, ${r.quotes} quote${r.quotes === 1 ? "" : "s"} removed${r.kept ? `, ${r.kept} quote${r.kept === 1 ? "" : "s"} kept (approved since)` : ""}.`);
  await mongoose.disconnect();
  process.exit(0);
}

const res = await backfillEnrolmentQuotes({ write, orgId });
const verb = write ? "now" : "would be";
console.log(`Pro-formas → ordinary invoices (${res.proformas.length})`);
const vat = new Map<string, { invoice: number; tis: number }>();
for (const p of res.proformas) {
  console.log(`  ${orgs.get(p.orgId) ?? p.orgId} · ${p.invoiceNumber} · issued ${p.issueDate} · ${money(p.totalMinor, p.currency)} (VAT ${money(p.taxTotalMinor, p.currency)}) · paid ${money(p.amountPaidMinor, p.currency)}, ${money(p.balanceMinor, p.currency)} left · ${p.taxInvoices.length ? `${p.taxInvoices.join(", ")} kept as the payments' record (VAT ${money(p.taxInvoicedMinor, p.currency)})` : "no tax invoices yet"}`);
  const x = vat.get(p.currency) ?? { invoice: 0, tis: 0 };
  x.invoice += p.taxTotalMinor; x.tis += p.taxInvoicedMinor;
  vat.set(p.currency, x);
}
for (const [cur, x] of vat) {
  console.log(`  VAT ${verb} counted on the invoices' own dates: ${money(x.invoice, cur)} — it was ${money(x.tis, cur)} so far, payment by payment (${money(x.invoice - x.tis, cur)} more, brought forward).`);
}
console.log(`\nCloses waiting in Approvals or sent back → a quote each (${res.waiting.length})`);
for (const w of res.waiting) {
  console.log(`  ${orgs.get(w.orgId) ?? w.orgId} · ${w.invoiceNumber} · ${money(w.totalMinor, w.currency)} · ${w.state === "returned" ? "sent back" : "waiting"}${w.quoteNumber ? ` · ${w.quoteNumber}` : ""}`);
}
if (write) {
  const file = `enrolment-quotes-backfill-undo-${res.at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(res, null, 2));
  console.log(`\nDone. To put it back: bun src/scripts/enrolment-quotes-backfill.ts --undo ${file}`);
} else {
  console.log(res.proformas.length + res.waiting.length ? "\nNothing was changed — run again with --write to do it." : "\nNothing to do.");
}
await mongoose.disconnect();
