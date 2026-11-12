/**
 * Pro-formas put back (the user, 2026-11-12: "why Pro-formas & tax invoices is nothing … can we backfill it").
 *
 * For a day (2026-11-11 → 12) enrolments were quote-based: a close was a quote, approval made ONE invoice with the
 * whole fee's VAT, and a backfill turned every pro-forma into an ordinary invoice. That was undone in the code (VAT is
 * to follow what is paid), but the data it left stayed as it was:
 *
 *   1. Every pro-forma lost its mark (`proforma` unset, `proformaUntil` set). Its payments still carry their tax
 *      invoices, but nothing finds them: Sales → Pro-formas & TIs is empty, the VAT report counts the whole invoice
 *      on its own date again, and a payment recorded since got no tax invoice.
 *   2. An enrolment approved part paid while it lasted is one invoice with all its VAT, and no tax invoice.
 *   3. A CS Portal course invoice raised part paid while it lasted, the same.
 *   4. The quotes made for enrolments are still in Quotations, where they now read as ordinary quotes — one could be
 *      converted into a second invoice — and the invoices still point at them.
 *
 * This puts all four right: the mark back with the day it had (from the quote backfill's own undo file where there is
 * one, else the invoice's first tax invoice), a tax invoice for every payment without one — numbered on from the last,
 * in the order paid, each with its share of the VAT exactly as a new one would get (payment-tax-invoice.ts taxShares)
 * — and the enrolment quotes and their links gone. Quotes made by hand are not touched. Nobody is emailed.
 *
 * `proformaUntil`, an invoice's `quote` and a quotation's `enrolment` are in no schema any more, and the models run
 * with strictQuery: a filter on them through a model would have them dropped and match EVERYTHING. So this reads and
 * writes through the driver's own collections.
 *
 * Reads and prints only, unless --write; --write saves an undo file first and adds to it as it goes. Run it from
 * apps/api on the server:
 *
 *   bun src/scripts/proforma-restore.ts                          # what it would do
 *   bun src/scripts/proforma-restore.ts --write --expect <code>  # <code> = the one the look printed
 *   bun src/scripts/proforma-restore.ts --undo <file>
 *
 * --marks-from <file>: the quote backfill's undo file (enrolment-quotes-backfill-undo-….json); the newest one in the
 * folder it is run from is used when this is left out. --since YYYY-MM-DD: the day quote-based enrolments began
 * (2026-11-11).
 */
import mongoose, { Types } from "mongoose";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { formatMoney } from "@delta/shared";

export type RestoreGroup = "was a pro-forma" | "approved as one invoice" | "course invoice";
export interface RestoreRow {
  group: RestoreGroup; invoice: string; customer: string; issued: string; currency: string;
  outcome: "would change" | "changed" | "left out"; detail: string; proformaAt: string; vatInvoiceMinor: number;
  taxInvoices: Array<{ number: string; paidOn: string; amountMinor: number; taxMinor: number; fresh: boolean }>;
}
export interface QuoteRow { quote: string; invoice: string; status: string; outcome: "would remove" | "removed" }
export interface RestoreResult { rows: RestoreRow[]; quotes: QuoteRow[]; links: number; code: string; marksFrom?: string; undoFile?: string }

interface Undo {
  at: string;
  /** Invoices given their mark back: what `proformaUntil` was. */
  marks: Array<{ id: string; number: string; proformaUntil: string }>;
  /** Invoices made pro-formas for the first time. */
  made: Array<{ id: string; number: string }>;
  /** Tax invoices given by this run. */
  taxInvoices: Array<{ invoiceId: string; paymentId: string; number: string }>;
  /** Tax invoices that were there, whose VAT this run worked out again: what it was. */
  retaxed: Array<{ invoiceId: string; paymentId: string; netMinor: number; taxMinor: number }>;
  /** Each quotation removed, whole (EJSON). */
  quotes: string[];
  /** Each invoice's link to its quote (EJSON). */
  quoteLinks: Array<{ invoiceId: string; quote: string }>;
}

const DEFAULT_SINCE = "2026-11-11";
const EJSON = mongoose.mongo.BSON.EJSON;
const day = (d: unknown) => (d ? new Date(d as Date).toISOString().slice(0, 10) : "");

/** The quote backfill's undo file in this folder, the newest — it holds the day each pro-forma began. */
export function findQuoteBackfillUndo(dir = "."): string | undefined {
  const found = readdirSync(dir).filter((f) => /^enrolment-quotes-backfill-undo-.*\.json$/.test(f)).sort();
  return found.length ? `${dir === "." ? "" : `${dir}/`}${found[found.length - 1]}` : undefined;
}

export async function restoreProformas(o: { write: boolean; expect?: string; since?: string; marksFrom?: string; undoFile?: string }): Promise<RestoreResult> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { Quotation } = await import("../modules/quotation/quotation.model");
  const { Organization } = await import("../modules/organization/organization.model");
  const { Sequence } = await import("../modules/sequence/sequence.model");
  const { nextNumber } = await import("../modules/sequence/sequence.service");
  const { taxShares } = await import("../modules/invoice/payment-tax-invoice");
  const { COURSE_INVOICE_SOURCE } = await import("../modules/tetra-deposit/course-invoice");
  // Not the models: see the note at the top.
  const invoices = Invoice.collection, quotations = Quotation.collection;

  const since = o.since ?? DEFAULT_SINCE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("--since: YYYY-MM-DD");
  const sinceAt = new Date(`${since}T00:00:00.000Z`);

  // The day each pro-forma began, as the quote backfill wrote it down before taking it off.
  const began = new Map<string, Date>();
  if (o.marksFrom) {
    const f = JSON.parse(readFileSync(o.marksFrom, "utf8")) as { proformas?: Array<{ invoiceId?: string; proformaAt?: string }> };
    if (!Array.isArray(f.proformas)) throw new Error(`${o.marksFrom} is not the quote backfill's undo file (no "proformas" in it)`);
    for (const p of f.proformas) if (p.invoiceId && p.proformaAt && !Number.isNaN(new Date(p.proformaAt).getTime())) began.set(String(p.invoiceId), new Date(p.proformaAt));
  }

  const on = (await Organization.find({ vatOnPayments: true }).select("_id").lean<Array<{ _id: Types.ObjectId }>>()).map((x) => x._id);

  type Plan = { doc: any; row: RestoreRow; taxes: number[]; at: Date; was: boolean };
  const rows: RestoreRow[] = [];
  const plans: Plan[] = [];
  const hasTi = (p: any) => Boolean(p?.taxInvoice?.number);
  const add = (doc: any, group: RestoreGroup, at: Date, was: boolean, detail: string) => {
    const cur = String(doc.currency ?? "AED");
    const row: RestoreRow = {
      group, invoice: String(doc.invoiceNumber), customer: String(doc.customerName ?? ""), issued: day(doc.issueDate), currency: cur, outcome: "would change",
      detail: `${detail} · ${formatMoney(doc.amountPaidMinor ?? 0, cur)} of ${formatMoney(doc.totalMinor ?? 0, cur)} paid`,
      proformaAt: at.toISOString(), vatInvoiceMinor: doc.taxTotalMinor ?? 0, taxInvoices: [],
    };
    rows.push(row);
    plans.push({ doc, row, taxes: taxShares(doc), at, was });
  };
  const leftOut = (doc: any, group: RestoreGroup, detail: string) => rows.push({
    group, invoice: String(doc.invoiceNumber), customer: String(doc.customerName ?? ""), issued: day(doc.issueDate), currency: String(doc.currency ?? "AED"),
    outcome: "left out", detail, proformaAt: "", vatInvoiceMinor: doc.taxTotalMinor ?? 0, taxInvoices: [],
  });

  // 1. The pro-formas the quote backfill made ordinary invoices — in any organization: they were pro-formas.
  const were = await invoices.find({ proformaUntil: { $exists: true }, "proforma.at": { $exists: false } }).sort({ issueDate: 1, invoiceNumber: 1 }).toArray();
  for (const doc of were) {
    const firstTi = ((doc.payments ?? []) as any[]).filter(hasTi).map((p) => p.taxInvoice.issuedAt).filter(Boolean).map((d) => new Date(d).getTime()).sort((a, b) => a - b)[0];
    const known = began.get(String(doc._id));
    const at = known ?? (firstTi ? new Date(firstTi) : new Date(doc.approval?.at ?? doc.proformaUntil));
    add(doc, "was a pro-forma", at, true, `pro-forma since ${day(at)}${known ? "" : firstTi ? " (the day of its first tax invoice)" : " (the day it was approved)"}`);
  }

  // 2. Enrolments approved part paid while approval made one invoice of them — where VAT on payments received is on.
  const approved = on.length ? await invoices.find({
    organizationId: { $in: on }, "approval.state": "approved", "approval.at": { $gte: sinceAt }, status: { $ne: "void" }, enrolment: { $ne: null },
    "proforma.at": { $exists: false }, proformaUntil: { $exists: false }, taxTotalMinor: { $gt: 0 },
  }).sort({ "approval.at": 1, invoiceNumber: 1 }).toArray() : [];
  for (const doc of approved) {
    const e = doc.enrolment ?? {};
    const total = doc.totalMinor ?? 0;
    const said = (e.declaredPayments?.length ?? 0) > 0 || typeof e.declaredPaidMinor === "number";
    const declared = e.declaredPayments?.length ? e.declaredPayments.reduce((s: number, p: any) => s + (p.amountMinor ?? 0), 0) : e.declaredPaidMinor ?? 0;
    if (said && declared >= total) continue;                                    // paid in full at the close: an invoice, as it is
    if (!said) { leftOut(doc, "approved as one invoice", "its close didn't say what was collected — check it by hand"); continue; }
    if (((doc.payments ?? []) as any[]).some(hasTi)) { leftOut(doc, "approved as one invoice", "a payment on it has a tax invoice already — check it by hand"); continue; }
    add(doc, "approved as one invoice", new Date(doc.approval.at), false, `approved ${day(doc.approval.at)}, ${formatMoney(declared, String(doc.currency ?? "AED"))} collected at the close`);
  }

  // 3. CS Portal course invoices raised part paid in the same days.
  const courses = on.length ? await invoices.find({
    organizationId: { $in: on }, "external.source": COURSE_INVOICE_SOURCE, createdAt: { $gte: sinceAt }, status: { $ne: "void" },
    "proforma.at": { $exists: false }, proformaUntil: { $exists: false }, taxTotalMinor: { $gt: 0 },
  }).sort({ createdAt: 1, invoiceNumber: 1 }).toArray() : [];
  for (const doc of courses) {
    const payments = (doc.payments ?? []) as any[];
    if (!payments.length || (payments[0].amountMinor ?? 0) >= (doc.totalMinor ?? 0)) continue;   // raised paid in full: an invoice, as it is
    if (payments.some(hasTi)) { leftOut(doc, "course invoice", "a payment on it has a tax invoice already — check it by hand"); continue; }
    add(doc, "course invoice", new Date(doc.createdAt), false, `raised ${day(doc.createdAt)} part paid`);
  }

  // Numbers for the payments without one: on from each organization's last, in the order paid across all of them.
  const queue = plans.flatMap((pl) => ((pl.doc.payments ?? []) as any[]).map((p, i) => ({ pl, p, i })).filter((x) => !hasTi(x.p)))
    .sort((a, b) => new Date(a.p.paidOn).getTime() - new Date(b.p.paidOn).getTime() || a.pl.row.invoice.localeCompare(b.pl.row.invoice) || a.i - b.i);
  const counters = new Map<string, number>();
  const predicted = new Map<unknown, string>();
  for (const { pl, p } of queue) {
    const k = String(pl.doc.organizationId);
    if (!counters.has(k)) counters.set(k, (await Sequence.findOne({ organizationId: pl.doc.organizationId, key: "tax_invoice" }).lean<any>())?.next ?? 0);
    const n = counters.get(k)! + 1;
    counters.set(k, n);
    predicted.set(p, `TI-${String(n).padStart(5, "0")}`);
  }
  const fill = (pl: Plan, numberOf: (p: any) => string) => {
    pl.row.taxInvoices = ((pl.doc.payments ?? []) as any[]).map((p, i) => ({
      number: hasTi(p) ? String(p.taxInvoice.number) : numberOf(p), paidOn: day(p.paidOn), amountMinor: p.amountMinor ?? 0, taxMinor: pl.taxes[i]!, fresh: !hasTi(p),
    }));
  };
  for (const pl of plans) fill(pl, (p) => predicted.get(p)!);

  // 4. The quotes made for enrolments, and the invoices pointing at one.
  const enrolmentQuotes = await quotations.find({ "enrolment.invoiceId": { $exists: true } }).sort({ quoteNumber: 1 }).toArray();
  const linked = await invoices.find({ "quote.id": { $exists: true } }).project({ invoiceNumber: 1, quote: 1 }).toArray();
  const numberOfInvoice = new Map<string, string>();
  const ids = enrolmentQuotes.map((q) => q.enrolment?.invoiceId).filter(Boolean);
  if (ids.length) for (const d of await invoices.find({ _id: { $in: ids } }).project({ invoiceNumber: 1 }).toArray()) numberOfInvoice.set(String(d._id), String(d.invoiceNumber));
  const quotes: QuoteRow[] = enrolmentQuotes.map((q) => ({
    quote: String(q.quoteNumber ?? ""), invoice: numberOfInvoice.get(String(q.enrolment?.invoiceId)) ?? "(its enrolment is gone)", status: String(q.status ?? ""), outcome: "would remove",
  }));

  const count = (g: RestoreGroup) => plans.filter((pl) => pl.row.group === g).length;
  const code = [count("was a pro-forma"), count("approved as one invoice"), count("course invoice"), queue.length, enrolmentQuotes.length, linked.length].join("-");
  const result: RestoreResult = { rows, quotes, links: linked.length, code, ...(o.marksFrom ? { marksFrom: o.marksFrom } : {}) };
  if (!o.write) return result;

  if (o.expect !== code) throw new Error(`--expect ${o.expect ?? "(none)"}, but it would be ${code} now — run it again without --write and check`);
  const undo: Undo = { at: new Date().toISOString(), marks: [], made: [], taxInvoices: [], retaxed: [], quotes: [], quoteLinks: [] };
  const undoFile = o.undoFile ?? `proforma-restore-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const save = () => {
    writeFileSync(undoFile, JSON.stringify(undo, null, 2));
    if (!Array.isArray((JSON.parse(readFileSync(undoFile, "utf8")) as Undo).marks)) throw new Error(`The undo file ${undoFile} didn't read back — stopped`);
  };
  save();

  // Numbers given for real, in the same order; each invoice written once all of its own are known.
  const given = new Map<unknown, string>();
  for (const { pl, p } of queue) given.set(p, await nextNumber(String(pl.doc.organizationId), "tax_invoice", "TI-"));
  const now = new Date();
  for (const pl of plans) {
    const payments = (pl.doc.payments ?? []) as any[];
    const set: Record<string, unknown> = { proforma: { at: pl.at } };
    const match: Record<string, unknown> = { _id: pl.doc._id, "proforma.at": { $exists: false }, ...(pl.was ? { proformaUntil: { $exists: true } } : {}) };
    const fresh: Undo["taxInvoices"] = [], retaxed: Undo["retaxed"] = [];
    payments.forEach((p, i) => {
      match[`payments.${i}._id`] = p._id;
      const taxMinor = pl.taxes[i]!, netMinor = (p.amountMinor ?? 0) - taxMinor;
      if (!hasTi(p)) {
        set[`payments.${i}.taxInvoice`] = { number: given.get(p), netMinor, taxMinor, issuedAt: now };
        fresh.push({ invoiceId: String(pl.doc._id), paymentId: String(p._id), number: given.get(p)! });
      } else if (p.taxInvoice.taxMinor !== taxMinor || p.taxInvoice.netMinor !== netMinor) {
        // Its number, the day it was issued and whether it was emailed stay; only what a payment since made of its VAT.
        set[`payments.${i}.taxInvoice.netMinor`] = netMinor;
        set[`payments.${i}.taxInvoice.taxMinor`] = taxMinor;
        retaxed.push({ invoiceId: String(pl.doc._id), paymentId: String(p._id), netMinor: p.taxInvoice.netMinor ?? 0, taxMinor: p.taxInvoice.taxMinor ?? 0 });
      }
    });
    match[`payments.${payments.length}`] = { $exists: false };
    // Written down before it is done: an undo file that knows of a change not made is harmless, the other way is not.
    if (pl.was) undo.marks.push({ id: String(pl.doc._id), number: pl.row.invoice, proformaUntil: new Date(pl.doc.proformaUntil).toISOString() });
    else undo.made.push({ id: String(pl.doc._id), number: pl.row.invoice });
    undo.taxInvoices.push(...fresh);
    undo.retaxed.push(...retaxed);
    save();
    const r = await invoices.updateOne(match, { $set: set, ...(pl.was ? { $unset: { proformaUntil: "" } } : {}) });
    if (!r.modifiedCount) { pl.row.outcome = "left out"; pl.row.detail = "changed since it was read — run it again"; continue; }
    pl.row.outcome = "changed";
    fill(pl, (p) => given.get(p)!);
  }

  for (let i = 0; i < enrolmentQuotes.length; i++) {
    const q = enrolmentQuotes[i]!;
    undo.quotes.push(EJSON.stringify(q, { relaxed: false }));
    save();
    const r = await quotations.deleteOne({ _id: q._id, "enrolment.invoiceId": { $exists: true } });
    if (r.deletedCount) quotes[i]!.outcome = "removed";
  }
  for (const d of linked) {
    undo.quoteLinks.push({ invoiceId: String(d._id), quote: EJSON.stringify(d.quote, { relaxed: false }) });
    save();
    await invoices.updateOne({ _id: d._id, "quote.id": { $exists: true } }, { $unset: { quote: "" } });
  }
  return { ...result, undoFile };
}

/** Puts back what a run changed, from its undo file. The tax invoice numbers it gave stay used. */
export async function undoRestoreProformas(file: string): Promise<{ marks: number; made: number; taxInvoices: number; quotes: number; links: number }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { Quotation } = await import("../modules/quotation/quotation.model");
  const invoices = Invoice.collection, quotations = Quotation.collection;
  const u = JSON.parse(readFileSync(file, "utf8")) as Undo;
  if (!Array.isArray(u.marks) || !Array.isArray(u.made)) throw new Error(`${file} is not this script's undo file`);
  const id = (s: string) => new Types.ObjectId(s);
  const done = { marks: 0, made: 0, taxInvoices: 0, quotes: 0, links: 0 };
  for (const t of u.taxInvoices) {
    const r = await invoices.updateOne({ _id: id(t.invoiceId), payments: { $elemMatch: { _id: id(t.paymentId), "taxInvoice.number": t.number } } }, { $unset: { "payments.$.taxInvoice": "" } });
    done.taxInvoices += r.modifiedCount;
  }
  for (const t of u.retaxed) {
    await invoices.updateOne({ _id: id(t.invoiceId), "payments._id": id(t.paymentId) }, { $set: { "payments.$.taxInvoice.netMinor": t.netMinor, "payments.$.taxInvoice.taxMinor": t.taxMinor } });
  }
  for (const m of u.marks) {
    const r = await invoices.updateOne({ _id: id(m.id), "proforma.at": { $exists: true } }, { $unset: { proforma: "" }, $set: { proformaUntil: new Date(m.proformaUntil) } });
    done.marks += r.modifiedCount;
  }
  for (const m of u.made) {
    const r = await invoices.updateOne({ _id: id(m.id), "proforma.at": { $exists: true } }, { $unset: { proforma: "" } });
    done.made += r.modifiedCount;
  }
  for (const s of u.quotes) {
    const q = EJSON.parse(s, { relaxed: false }) as { _id: Types.ObjectId };
    if (await quotations.findOne({ _id: q._id })) continue;
    await quotations.insertOne(q as never);
    done.quotes++;
  }
  for (const l of u.quoteLinks) {
    const r = await invoices.updateOne({ _id: id(l.invoiceId), "quote.id": { $exists: false } }, { $set: { quote: EJSON.parse(l.quote, { relaxed: false }) } });
    done.links += r.modifiedCount;
  }
  return done;
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    if (arg("--undo")) {
      const d = await undoRestoreProformas(arg("--undo"));
      console.log(`From ${arg("--undo")}: the mark taken off ${d.marks + d.made} invoice(s) again (${d.marks} as they were left, ${d.made} never pro-formas before), ${d.taxInvoices} tax invoice(s) taken off, ${d.quotes} quote(s) and ${d.links} link(s) put back.`);
    } else {
      const write = argv.includes("--write");
      const marksFrom = arg("--marks-from") || findQuoteBackfillUndo();
      const { rows, quotes, links, code, undoFile } = await restoreProformas({ write, expect: arg("--expect") || undefined, since: arg("--since") || undefined, marksFrom });
      console.log(marksFrom ? `The day each pro-forma began: from ${marksFrom}` : "No quote-backfill undo file here: the day each pro-forma began is taken from its first tax invoice.");
      const groups: RestoreGroup[] = ["was a pro-forma", "approved as one invoice", "course invoice"];
      let before = 0, after = 0, fresh = 0;
      const byMonth = new Map<string, number>();
      for (const g of groups) {
        const mine = rows.filter((r) => r.group === g);
        console.log(`\n── ${g === "was a pro-forma" ? "Pro-formas that lost their mark" : g === "approved as one invoice" ? "Enrolments approved part paid as one invoice" : "Course invoices raised part paid as one invoice"}: ${mine.length}`);
        for (const r of mine) {
          console.log(`${r.invoice.padEnd(10)} ${r.issued} ${r.customer.slice(0, 24).padEnd(24)} ${r.outcome.padEnd(12)} ${r.detail}`);
          if (r.outcome === "left out") continue;
          before += r.vatInvoiceMinor;
          for (const t of r.taxInvoices) {
            console.log(`           ${t.number}${t.fresh ? " NEW" : "    "}  paid ${t.paidOn}  ${formatMoney(t.amountMinor, r.currency).padStart(14)}  VAT ${formatMoney(t.taxMinor, r.currency)}`);
            after += t.taxMinor;
            if (t.fresh) fresh++;
            byMonth.set(t.paidOn.slice(0, 7), (byMonth.get(t.paidOn.slice(0, 7)) ?? 0) + t.taxMinor);
          }
        }
      }
      console.log(`\n── Enrolment quotes ${write ? "removed" : "to remove"}: ${quotes.length} (quotes made by hand are not touched); invoices pointing at one: ${links}`);
      for (const q of quotes) console.log(`${q.quote.padEnd(10)} ${q.invoice.padEnd(12)} ${q.status.padEnd(10)} ${q.outcome}`);
      const n = (x: RestoreRow["outcome"]) => rows.filter((r) => r.outcome === x).length;
      console.log(`\n${write ? n("changed") : n("would change")} invoice(s) ${write ? "are" : "would be"} pro-formas again, with ${fresh} new tax invoice(s); ${n("left out")} left out. Nobody is emailed.`);
      console.log(`VAT on them: ${formatMoney(before, "AED")} on their invoices' own dates now → ${formatMoney(after, "AED")} on the tax invoices, by the month paid: ${[...byMonth].sort().map(([m, v]) => `${m} ${formatMoney(v, "AED")}`).join(" · ") || "—"}`);
      if (undoFile) console.log(`Undo file: ${undoFile}`);
      if (!write) console.log(`Nothing written. To do it: bun src/scripts/proforma-restore.ts --write --expect ${code}`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  await mongoose.disconnect();
}
