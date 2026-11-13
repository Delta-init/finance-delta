/**
 * Only payments in the invoice's own currency carry VAT (the user, 2026-11-13: "INR payment doesn't have the VAT",
 * then "only AED payments carry VAT") — for the payments in another currency recorded before that rule
 * (invoice/payment-tax-invoice.ts), which were given VAT like any other. Named for its first case, rupees.
 *
 * A payment in another currency is one by INR Transfer, or one typed in another currency where it was taken (a CRM
 * close with its currency and rate, rupees in CS Portal). For each, in every organization:
 *
 *   1. what was paid is noted on the payment (`original`) — from the CS Portal request it came from, else the close's
 *      own figure, else what landed in a bank account of that currency. No money figure changes; it is what the
 *      screens show.
 *   2. on a pro-forma, it is marked free of VAT: its tax invoice keeps its number and carries none, and the other
 *      payments carry the VAT of their own amounts only;
 *   3. an invoice paid in full, all of it in other currencies, has its VAT taken off (the total stays);
 *   4. an ordinary invoice only partly paid so, or still owing, becomes a pro-forma (2026-11-13: "why VAT added" on
 *      two such invoices) — one invoice cannot say "VAT on part of it", so each of its payments gets its own tax
 *      invoice, numbered on from the last in the order paid: none on the other currency, the VAT of their own
 *      amounts on the rest. Where the organization does not have VAT on payments received on, it is listed and
 *      left as it is.
 *
 * An invoice that is itself in rupees (Bangalore) has what was paid noted, and its VAT never touched.
 *
 * Reads and prints only, unless --write; --write saves an undo file first and adds to it as it goes. Nobody is
 * emailed. Run it from apps/api on the server:
 *
 *   bun src/scripts/inr-payments-no-vat.ts                           # what it would do
 *   bun src/scripts/inr-payments-no-vat.ts --write --expect <code>   # <code> as the look printed it
 *   bun src/scripts/inr-payments-no-vat.ts --rupees-only             # only step 1 (add --write --expect <code>)
 *   bun src/scripts/inr-payments-no-vat.ts --undo <file>
 */
import mongoose from "mongoose";
import { readFileSync, writeFileSync } from "node:fs";
import { formatMoney, paidCurrency } from "@delta/shared";

export interface RupeeRow {
  invoice: string; kind: "pro-forma" | "invoice"; outcome: "would change" | "changed" | "left as it is" | "nothing to do";
  detail: string; rupeesNoted: number; vatBeforeMinor: number; vatAfterMinor: number;
  /** The day its VAT is counted on, for the month it comes off: each TI's paid day, or the invoice's date. */
  byDay: Array<{ day: string; lessMinor: number }>;
  taxInvoices: Array<{ number: string; beforeMinor: number; afterMinor: number; /** Issued by this run, on an invoice it made a pro-forma. */ fresh?: boolean }>;
  /** An ordinary invoice this run makes a pro-forma. */
  madeProforma?: boolean;
  currency: string;
}
type Change = { id: string; number: string; guard: Record<string, unknown>; set: Record<string, unknown>; before: Record<string, unknown>; absent: string[] };

const day = (d: unknown) => new Date(d as Date).toISOString().slice(0, 10);
const EJSON = () => mongoose.mongo.BSON.EJSON;

export async function correctRupeePayments(o: { write: boolean; expect?: string; rupeesOnly?: boolean; undoFile?: string }): Promise<{ rows: RupeeRow[]; code: string; undoFile?: string }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { TetraDepositModel } = await import("../modules/tetra-deposit/tetra-deposit.model");
  const { rupeesTyped } = await import("../modules/tetra-deposit/course-invoice");
  const { RUPEE_METHODS, stripVatForOtherCurrency, taxShares } = await import("../modules/invoice/payment-tax-invoice");

  // CS Portal requests typed in rupees, by the reference their payment carries.
  const requests = await TetraDepositModel.find({ amountCurrency: "INR", amountOriginal: { $gt: 0 } })
    .select("externalId amountOriginal amountCurrency amountMinor currency academy decision.approvedAmountMinor").lean<any[]>();
  const typed = new Map<string, any>(requests.map((r) => [`tetra:${r.externalId}`, r]));

  const docs = await Invoice.collection.find({
    status: { $ne: "void" },
    $or: [
      { "payments.method": { $in: [...RUPEE_METHODS] } }, { "payments.original.currency": { $exists: true } }, { "enrolment.declaredPayments.original.currency": { $exists: true } },
      ...(typed.size ? [{ "payments.externalRef": { $in: [...typed.keys()] } }] : []),
    ],
  }).sort({ issueDate: 1, invoiceNumber: 1 }).toArray();

  const { Organization } = await import("../modules/organization/organization.model");
  const { Sequence } = await import("../modules/sequence/sequence.model");
  const { nextNumber } = await import("../modules/sequence/sequence.service");
  // Where a part-paid enrolment is a pro-forma at all: only there can an ordinary invoice be made one.
  const proformaOrgs = new Set((await Organization.find({ vatOnPayments: true }).select("_id").lean<any[]>()).map((x) => String(x._id)));

  const rows: RupeeRow[] = [];
  const changes: Change[] = [];
  /** Ordinary invoices to make pro-formas: each payment's VAT, its tax invoice numbered once every one is known. */
  const converts: Array<{ d: any; ch: Change; row: RupeeRow; shares: number[] }> = [];
  for (const d of docs as any[]) {
    const cur = String(d.currency ?? "AED");
    const own = cur.toUpperCase();
    const payments: any[] = d.payments ?? [];
    // What each payment was made in, where that was stated and is not on the payment yet: the CS Portal request it
    // came from, else the close's own entry for it (same amount and method), else a bank account of its currency.
    const declared: any[] = (d.enrolment?.declaredPayments ?? []).filter((x: any) => x.original?.currency && String(x.original.currency).toUpperCase() !== own && Number(x.original.amountMinor) > 0);
    const usedDeclared = new Set<number>();
    const found = payments.map((p) => {
      if (p.original?.currency) return undefined;
      const amount = Number(p.amountMinor) || 0;
      const fromRequest = own !== "INR" && typed.has(String(p.externalRef ?? "")) ? rupeesTyped(typed.get(String(p.externalRef)), amount) : undefined;
      if (fromRequest) return fromRequest;
      const di = declared.findIndex((x, k) => !usedDeclared.has(k) && x.amountMinor === amount && x.method === p.method);
      if (di >= 0) {
        usedDeclared.add(di);
        return { currency: String(declared[di].original.currency).toUpperCase(), amountMinor: Number(declared[di].original.amountMinor), rate: Number(declared[di].original.rate) || amount / Number(declared[di].original.amountMinor) };
      }
      const paidIn = paidCurrency(p, own);
      return paidIn && String(p.bankCurrency ?? "").toUpperCase() === paidIn && Number(p.bankAmountMinor) > 0 && amount > 0
        ? { currency: paidIn, amountMinor: Number(p.bankAmountMinor), rate: amount / Number(p.bankAmountMinor) } : undefined;
    });
    // In another currency: as the payment says, or will say once what was found is noted on it.
    const isRupee = (p: any) => paidCurrency({ ...p, original: p.original?.currency ? p.original : found[payments.indexOf(p)] }, own) !== null;
    if (!payments.some(isRupee)) continue;
    const proforma = Boolean(d.proforma?.at);
    const row: RupeeRow = {
      invoice: String(d.invoiceNumber), kind: proforma ? "pro-forma" : "invoice", outcome: "nothing to do", detail: "", rupeesNoted: 0,
      vatBeforeMinor: 0, vatAfterMinor: 0, byDay: [], taxInvoices: [], currency: cur,
    };
    const ch: Change = { id: String(d._id), number: row.invoice, guard: {}, set: {}, before: {}, absent: [] };
    const put = (path: string, value: unknown, had: unknown) => {
      ch.set[path] = value;
      if (had === undefined) ch.absent.push(path); else ch.before[path] = had;
    };

    // 1. What was paid, on each such payment that does not say it yet.
    payments.forEach((p, i) => {
      const original = found[i];
      if (!original) return;
      put(`payments.${i}.original`, original, undefined);
      ch.guard[`payments.${i}._id`] = p._id;
      row.rupeesNoted++;
    });

    // 2–4. The VAT — never on an invoice that is itself in rupees.
    const tax = Number(d.taxTotalMinor) || 0;
    const notes: string[] = [];
    const vatRule = !o.rupeesOnly && own !== "INR";
    if (vatRule && proforma) {
      const next = payments.map((p) => ({ ...p, vatFree: p.vatFree === true || isRupee(p) }));
      const shares = taxShares({ ...d, payments: next });
      payments.forEach((p, i) => {
        if (isRupee(p) && p.vatFree !== true) { put(`payments.${i}.vatFree`, true, p.vatFree ?? undefined); ch.guard[`payments.${i}._id`] = p._id; }
        const ti = p.taxInvoice;
        if (!ti?.number) return;
        const was = Number(ti.taxMinor) || 0, now = shares[i]!;
        row.vatBeforeMinor += was; row.vatAfterMinor += now;
        if (was === now && Number(ti.netMinor) === (Number(p.amountMinor) || 0) - now) return;
        put(`payments.${i}.taxInvoice.taxMinor`, now, ti.taxMinor ?? undefined);
        put(`payments.${i}.taxInvoice.netMinor`, (Number(p.amountMinor) || 0) - now, ti.netMinor ?? undefined);
        ch.guard[`payments.${i}._id`] = p._id;
        row.taxInvoices.push({ number: String(ti.number), beforeMinor: was, afterMinor: now });
        if (was !== now) row.byDay.push({ day: day(p.paidOn), lessMinor: was - now });
      });
    } else if (vatRule) {
      row.vatBeforeMinor = tax; row.vatAfterMinor = tax;
      const allRupees = payments.length > 0 && payments.every(isRupee);
      const paidInFull = (Number(d.balanceMinor) || 0) <= 0;
      if (tax > 0 && allRupees && paidInFull) {
        const sets: Record<string, unknown> = {};
        const stripped = stripVatForOtherCurrency({ ...d, set: (path: string, value: unknown) => { sets[path] = value; } });
        if (stripped) {
          for (const [path, value] of Object.entries(sets)) put(path, value, d[path] ?? undefined);
          payments.forEach((p, i) => { if (p.vatFree !== true) { put(`payments.${i}.vatFree`, true, p.vatFree ?? undefined); ch.guard[`payments.${i}._id`] = p._id; } });
          row.vatAfterMinor = 0;
          row.byDay.push({ day: day(d.issueDate), lessMinor: tax });
        }
      }
      // Not taken off the invoice — part of it in the invoice's own currency, still owing, or priced before tax:
      // a pro-forma from here on, the VAT on each payment's own tax invoice.
      if (tax > 0 && row.vatAfterMinor === tax) {
        if (proformaOrgs.has(String(d.organizationId))) {
          const next = payments.map((p) => ({ ...p, vatFree: p.vatFree === true || isRupee(p) }));
          const shares = taxShares({ ...d, payments: next });
          put("proforma", { at: new Date(d.approval?.at ?? d.createdAt ?? d.issueDate) }, undefined);
          payments.forEach((p, i) => {
            if (isRupee(p) && p.vatFree !== true) put(`payments.${i}.vatFree`, true, p.vatFree ?? undefined);
            ch.guard[`payments.${i}._id`] = p._id;
          });
          converts.push({ d, ch, row, shares });
          row.madeProforma = true;
          row.vatAfterMinor = shares.reduce((t, x) => t + x, 0);
          // Off the day the invoice was dated; back on the days its dirhams were paid.
          row.byDay.push({ day: day(d.issueDate), lessMinor: tax });
          payments.forEach((p, i) => { if (shares[i]! > 0) row.byDay.push({ day: day(p.paidOn), lessMinor: -shares[i]! }); });
        } else {
          notes.push(`${!allRupees ? "only part of it was paid in another currency" : !paidInFull ? "not paid in full yet" : "priced before tax"}, and its organization does not have VAT on payments received on`);
        }
      }
    }

    const touched = Object.keys(ch.set).length > 0;
    if (touched) changes.push(ch);
    const left = notes.length > 0;
    row.outcome = touched ? (o.write ? "changed" : "would change") : left ? "left as it is" : "nothing to do";
    row.detail = [
      row.rupeesNoted ? `what was paid noted on ${row.rupeesNoted} payment${row.rupeesNoted === 1 ? "" : "s"}` : "",
      row.madeProforma ? "becomes a pro-forma, each payment its own tax invoice" : "",
      row.vatBeforeMinor !== row.vatAfterMinor ? `VAT ${formatMoney(row.vatBeforeMinor, cur)} → ${formatMoney(row.vatAfterMinor, cur)}` : "",
      left ? `VAT left as it is: ${notes.join("; ")}` : "",
    ].filter(Boolean).join(" · ");
    if (touched || left) rows.push(row);
  }

  // The new pro-formas' tax invoices: numbered on from each organization's last, in the order paid across them all.
  const queue = converts.flatMap((c) => (c.d.payments as any[]).map((p, i) => ({ c, p, i })))
    .sort((a, b) => new Date(a.p.paidOn).getTime() - new Date(b.p.paidOn).getTime() || a.c.row.invoice.localeCompare(b.c.row.invoice) || a.i - b.i);
  const counters = new Map<string, number>();
  const predicted = new Map<unknown, string>();
  for (const { c, p } of queue) {
    const k = String(c.d.organizationId);
    if (!counters.has(k)) counters.set(k, (await Sequence.findOne({ organizationId: c.d.organizationId, key: "tax_invoice" }).lean<any>())?.next ?? 0);
    counters.set(k, counters.get(k)! + 1);
    predicted.set(p, `TI-${String(counters.get(k)).padStart(5, "0")}`);
  }
  const listed = (numberOf: (p: any) => string) => {
    for (const c of converts) {
      c.row.taxInvoices = (c.d.payments as any[]).map((p, i) => ({ number: numberOf(p), beforeMinor: 0, afterMinor: c.shares[i]!, fresh: true }));
    }
  };
  listed((p) => predicted.get(p)!);

  const count = (f: (r: RupeeRow) => boolean) => rows.filter(f).length;
  const code = [
    rows.reduce((s, r) => s + r.rupeesNoted, 0),
    rows.reduce((s, r) => s + r.taxInvoices.filter((t) => !t.fresh).length, 0),
    count((r) => r.kind === "invoice" && !r.madeProforma && r.vatBeforeMinor !== r.vatAfterMinor),
    count((r) => r.madeProforma === true),
    count((r) => /left as it is/.test(r.detail)),
  ].join("-");
  if (!o.write) return { rows, code };
  if (o.expect !== code) throw new Error(`--expect ${o.expect ?? "(none)"} is not what there is now (${code}) — look again before writing`);
  if (!changes.length) return { rows, code };

  // Now that it is certain: the numbers themselves (never given back, as any tax invoice's), on each payment.
  const given = new Map<unknown, string>();
  for (const { c, p } of queue) given.set(p, await nextNumber(String(c.d.organizationId), "tax_invoice", "TI-"));
  const now = new Date();
  for (const c of converts) {
    (c.d.payments as any[]).forEach((p, i) => {
      const taxMinor = c.shares[i]!;
      c.ch.set[`payments.${i}.taxInvoice`] = { number: given.get(p), netMinor: (Number(p.amountMinor) || 0) - taxMinor, taxMinor, issuedAt: now };
      c.ch.absent.push(`payments.${i}.taxInvoice`);
    });
  }
  listed((p) => given.get(p)!);

  const undoFile = o.undoFile ?? `inr-payments-no-vat-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const done: Change[] = [];
  const save = () => writeFileSync(undoFile, EJSON().stringify({ invoices: done }, undefined, 2, { relaxed: false }));
  save();
  for (const ch of changes) {
    const r = await Invoice.collection.updateOne({ _id: new mongoose.Types.ObjectId(ch.id), ...ch.guard }, { $set: ch.set });
    if (!r.matchedCount) throw new Error(`Invoice ${ch.number} changed while this ran — nothing more was written; ${done.length} done so far are in ${undoFile}`);
    done.push(ch);
    save();
  }
  return { rows, code, undoFile };
}

/** Puts back what a --write changed, from its undo file. */
export async function undoRupeeCorrection(file: string): Promise<number> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { invoices } = EJSON().parse(readFileSync(file, "utf8"), { relaxed: false }) as { invoices: Change[] };
  let n = 0;
  for (const ch of [...invoices].reverse()) {
    const unset = Object.fromEntries(ch.absent.map((p) => [p, ""]));
    const r = await Invoice.collection.updateOne({ _id: new mongoose.Types.ObjectId(ch.id) }, {
      ...(Object.keys(ch.before).length ? { $set: ch.before } : {}),
      ...(ch.absent.length ? { $unset: unset } : {}),
    });
    n += r.matchedCount;
  }
  return n;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    const undo = arg("--undo");
    if (undo) {
      console.log(`${await undoRupeeCorrection(undo)} invoice(s) put back as they were, from ${undo}`);
    } else {
      const write = args.includes("--write"), rupeesOnly = args.includes("--rupees-only");
      const { rows, code, undoFile } = await correctRupeePayments({ write, expect: arg("--expect"), rupeesOnly });
      for (const r of rows) {
        console.log(`${r.invoice.padEnd(12)} ${r.kind.padEnd(9)} ${r.outcome.padEnd(14)} ${r.detail}`);
        for (const t of r.taxInvoices) {
          console.log(`${" ".repeat(13)}${t.number}${t.fresh ? " (new)" : ""}: VAT ${t.fresh ? "" : `${formatMoney(t.beforeMinor, r.currency)} → `}${formatMoney(t.afterMinor, r.currency)}`);
        }
      }
      const byMonth = new Map<string, number>();
      for (const r of rows) for (const b of r.byDay) byMonth.set(`${b.day.slice(0, 7)} ${r.currency}`, (byMonth.get(`${b.day.slice(0, 7)} ${r.currency}`) ?? 0) + b.lessMinor);
      if (byMonth.size) {
        console.log(`\nOutput VAT ${write ? "is" : "would be"} lower by (a minus: higher):`);
        for (const [k, v] of [...byMonth].sort()) console.log(`  ${k.slice(0, 7)}  ${formatMoney(v, k.slice(8))}`);
      }
      const changing = rows.filter((r) => r.outcome === "changed" || r.outcome === "would change").length;
      console.log(`\n${rows.length} invoice(s) with payments in another currency: ${changing} ${write ? "changed" : "would change"}, ${rows.filter((r) => r.madeProforma).length} of them ${write ? "made" : "to be made"} pro-formas, ${rows.filter((r) => /left as it is/.test(r.detail)).length} with VAT left as it is.${rupeesOnly ? " Amounts only — no VAT touched." : ""} Nobody is emailed.`);
      if (!write && changing) console.log(`To write:  bun src/scripts/inr-payments-no-vat.ts ${rupeesOnly ? "--rupees-only " : ""}--write --expect ${code}`);
      if (undoFile) console.log(`Undo file: ${undoFile}  (bun src/scripts/inr-payments-no-vat.ts --undo ${undoFile})`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
