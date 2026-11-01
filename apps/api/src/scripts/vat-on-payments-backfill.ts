/**
 * VAT on payments received, back to the enrolments approved before it was turned on (the user, 2026-11-01:
 * "backfill October month also" — only October, no email).
 *
 * In each organization with Settings → "VAT on payments received" on: every enrolment approved, not void, issued in
 * the period (--from/--to, October 2026 by default), carrying VAT, with less collected at the close than its fee,
 * becomes a pro-forma, and each payment on it gets its tax invoice exactly as a new one would (invoice/
 * payment-tax-invoice.ts taxShares — its share of the VAT, the payment that cleared it taking the rest). Numbers are
 * given in the order paid, across every invoice, earliest first. Nobody is emailed. One whose close never said what
 * was collected is listed and left.
 *
 * Reads and prints only, unless --write; --write saves an undo file first and adds to it as it goes (--undo <file>
 * takes the pro-forma and the tax invoices off those invoices again — the numbers given are not given back). Run it
 * from apps/api on the server:
 *
 *   bun src/scripts/vat-on-payments-backfill.ts                       # what it would do
 *   bun src/scripts/vat-on-payments-backfill.ts --write --expect N    # N = the invoice count shown
 *   bun src/scripts/vat-on-payments-backfill.ts --undo <file>
 */
import mongoose, { Types } from "mongoose";
import { readFileSync, writeFileSync } from "node:fs";
import { formatMoney } from "@delta/shared";

export interface BackfillRow {
  invoice: string; customer: string; issued: string; outcome: "would change" | "changed" | "left out";
  detail: string; taxInvoices: Array<{ number: string; paidOn: string; amountMinor: number; taxMinor: number }>;
  vatBeforeMinor: number; currency: string;
}
interface Undo { invoices: Array<{ id: string; number: string; taxInvoices: string[] }> }

const DEFAULT_FROM = "2026-10-01", DEFAULT_TO = "2026-10-31";

export async function backfillVatOnPayments(o: { write: boolean; expect?: number; from?: string; to?: string; undoFile?: string }): Promise<{ rows: BackfillRow[]; undoFile?: string }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { Organization } = await import("../modules/organization/organization.model");
  const { Sequence } = await import("../modules/sequence/sequence.model");
  const { nextNumber } = await import("../modules/sequence/sequence.service");
  const { taxShares } = await import("../modules/invoice/payment-tax-invoice");
  const from = o.from ?? DEFAULT_FROM, to = o.to ?? DEFAULT_TO;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("--from / --to: YYYY-MM-DD");
  const day = (d: unknown) => new Date(d as Date).toISOString().slice(0, 10);

  const orgs = await Organization.find({ vatOnPayments: true }).select("_id name").lean<any[]>();
  if (!orgs.length) throw new Error('No organization has "VAT on payments received" on — turn it on in Settings first');

  const rows: BackfillRow[] = [];
  const plans: Array<{ doc: any; row: BackfillRow; taxes: number[] }> = [];
  for (const org of orgs) {
    const docs = await Invoice.find({
      organizationId: org._id,
      "approval.state": "approved",
      status: { $ne: "void" },
      enrolment: { $ne: null },
      "proforma.at": { $exists: false },
      taxTotalMinor: { $gt: 0 },
      issueDate: { $gte: new Date(`${from}T00:00:00.000Z`), $lte: new Date(`${to}T23:59:59.999Z`) },
    }).select("organizationId invoiceNumber customerName issueDate currency totalMinor taxTotalMinor balanceMinor payments enrolment.declaredPayments enrolment.declaredPaidMinor")
      .sort({ issueDate: 1, invoiceNumber: 1 }).lean<any[]>();
    for (const doc of docs) {
      const e = doc.enrolment ?? {};
      const total = doc.totalMinor ?? 0;
      const said = (e.declaredPayments?.length ?? 0) > 0 || typeof e.declaredPaidMinor === "number";
      const declared = e.declaredPayments?.length ? e.declaredPayments.reduce((s: number, p: any) => s + (p.amountMinor ?? 0), 0) : e.declaredPaidMinor ?? 0;
      if (said && declared >= total) continue;                                  // paid in full at the close: as it is
      const row: BackfillRow = {
        invoice: String(doc.invoiceNumber), customer: String(doc.customerName ?? ""), issued: day(doc.issueDate), outcome: "would change",
        detail: "", taxInvoices: [], vatBeforeMinor: doc.taxTotalMinor ?? 0, currency: String(doc.currency ?? "AED"),
      };
      rows.push(row);
      if (!said) { row.outcome = "left out"; row.detail = "its close didn't say what was collected — check it by hand"; continue; }
      if ((doc.payments ?? []).some((p: any) => p.taxInvoice?.number)) { row.outcome = "left out"; row.detail = "a payment on it has a tax invoice already"; continue; }
      const cur = row.currency;
      row.detail = `${formatMoney(declared, cur)} of ${formatMoney(total, cur)} collected at the close · ${formatMoney(doc.balanceMinor ?? 0, cur)} owed now`;
      plans.push({ doc, row, taxes: taxShares(doc) });
    }
  }

  // Numbers in the order paid, across all of them — what they would be now, from each organization's count.
  const queue = plans.flatMap((pl) => (pl.doc.payments ?? []).map((p: any, i: number) => ({ pl, p, i })))
    .sort((a, b) => new Date(a.p.paidOn).getTime() - new Date(b.p.paidOn).getTime() || a.pl.row.invoice.localeCompare(b.pl.row.invoice) || a.i - b.i);
  const counters = new Map<string, number>();
  for (const org of orgs) counters.set(String(org._id), (await Sequence.findOne({ organizationId: org._id, key: "tax_invoice" }).lean<any>())?.next ?? 0);
  const predicted = new Map<unknown, string>();
  for (const { pl, p } of queue) {
    const k = String(pl.doc.organizationId);
    const n = (counters.get(k) ?? 0) + 1;
    counters.set(k, n);
    predicted.set(p, `TI-${String(n).padStart(5, "0")}`);
  }
  for (const { pl, p, i } of queue) {
    pl.row.taxInvoices.push({ number: predicted.get(p)!, paidOn: day(p.paidOn), amountMinor: p.amountMinor ?? 0, taxMinor: pl.taxes[i]! });
  }
  for (const pl of plans) pl.row.taxInvoices.sort((a, b) => a.number.localeCompare(b.number));
  if (!o.write) return { rows };

  if (o.expect !== undefined && o.expect !== plans.length) throw new Error(`--expect ${o.expect}, but ${plans.length} would change now — run it again without --write and check`);
  const undo: Undo = { invoices: [] };
  const undoFile = o.undoFile ?? `vat-on-payments-backfill-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const save = () => {
    writeFileSync(undoFile, JSON.stringify(undo, null, 2));
    if (!Array.isArray((JSON.parse(readFileSync(undoFile, "utf8")) as Undo).invoices)) throw new Error(`The undo file ${undoFile} didn't read back — stopped`);
  };
  save();

  // Numbers given for real, in the same order; each invoice written once all of its own are known.
  const given = new Map<unknown, string>();
  for (const { pl, p } of queue) given.set(p, await nextNumber(String(pl.doc.organizationId), "tax_invoice", "TI-"));
  const now = new Date();
  for (const pl of plans) {
    const payments = pl.doc.payments ?? [];
    const set: Record<string, unknown> = { proforma: { at: now } };
    const match: Record<string, unknown> = { _id: pl.doc._id, "proforma.at": { $exists: false } };
    payments.forEach((p: any, i: number) => {
      set[`payments.${i}.taxInvoice`] = { number: given.get(p), netMinor: (p.amountMinor ?? 0) - pl.taxes[i]!, taxMinor: pl.taxes[i]!, issuedAt: now };
      match[`payments.${i}._id`] = p._id;
    });
    match[`payments.${payments.length}`] = { $exists: false };
    const r = await Invoice.updateOne(match, { $set: set });
    if (!r.modifiedCount) { pl.row.outcome = "left out"; pl.row.detail = "changed since it was read — run it again"; continue; }
    undo.invoices.push({ id: String(pl.doc._id), number: pl.row.invoice, taxInvoices: payments.map((p: any) => given.get(p)!) });
    save();
    pl.row.outcome = "changed";
    pl.row.taxInvoices = payments.map((p: any, i: number) => ({ number: given.get(p)!, paidOn: day(p.paidOn), amountMinor: p.amountMinor ?? 0, taxMinor: pl.taxes[i]! }))
      .sort((a: any, b: any) => a.number.localeCompare(b.number));
  }
  return { rows, undoFile };
}

/** The pro-forma and the tax invoices taken off the invoices a run changed. The numbers given stay used. */
export async function undoVatOnPaymentsBackfill(file: string): Promise<number> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const u = JSON.parse(readFileSync(file, "utf8")) as Undo;
  let n = 0;
  for (const inv of u.invoices) {
    const r = await Invoice.updateOne({ _id: new Types.ObjectId(inv.id) }, { $unset: { proforma: "", cancelledTaxInvoices: "", "payments.$[].taxInvoice": "" } });
    n += r.modifiedCount;
  }
  return n;
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    if (arg("--undo")) {
      console.log(`Took the pro-forma and tax invoices off ${await undoVatOnPaymentsBackfill(arg("--undo"))} invoice(s), from ${arg("--undo")}.`);
    } else {
      const write = argv.includes("--write");
      const { rows, undoFile } = await backfillVatOnPayments({ write, expect: arg("--expect") ? Number(arg("--expect")) : undefined, from: arg("--from") || undefined, to: arg("--to") || undefined });
      let before = 0, after = 0;
      const byMonth = new Map<string, number>();
      for (const r of rows) {
        console.log(`${r.invoice.padEnd(10)} ${r.issued} ${r.customer.slice(0, 24).padEnd(24)} ${r.outcome.padEnd(12)} ${r.detail}`);
        if (r.outcome === "left out") continue;
        before += r.vatBeforeMinor;
        for (const t of r.taxInvoices) {
          console.log(`           ${t.number}  paid ${t.paidOn}  ${formatMoney(t.amountMinor, r.currency).padStart(14)}  VAT ${formatMoney(t.taxMinor, r.currency)}`);
          after += t.taxMinor;
          byMonth.set(t.paidOn.slice(0, 7), (byMonth.get(t.paidOn.slice(0, 7)) ?? 0) + t.taxMinor);
        }
      }
      const count = (x: BackfillRow["outcome"]) => rows.filter((r) => r.outcome === x).length;
      const changing = write ? count("changed") : count("would change");
      const tis = rows.filter((r) => r.outcome !== "left out").reduce((s, r) => s + r.taxInvoices.length, 0);
      console.log(`\n${rows.length} part-paid enrolment(s): ${changing} ${write ? "made" : "would become"} pro-formas with ${tis} tax invoice(s), ${count("left out")} left out. Nobody is emailed.`);
      console.log(`VAT on them: ${formatMoney(before, "AED")} on their invoices before → ${formatMoney(after, "AED")} on the tax invoices, by the month paid: ${[...byMonth].sort().map(([m, v]) => `${m} ${formatMoney(v, "AED")}`).join(" · ") || "—"}`);
      if (undoFile) console.log(`Undo file: ${undoFile}`);
      if (!write) console.log(`Nothing written. To do it: bun src/scripts/vat-on-payments-backfill.ts --write --expect ${changing}`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  await mongoose.disconnect();
}
