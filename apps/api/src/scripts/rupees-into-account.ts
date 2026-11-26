/**
 * Payments made in rupees that never reached the rupee account (the user, 2026-11-26, of an INR payment that sat
 * beside its account saying "give the amount received in INR to put it in the account" — with the rupees on it).
 *
 * An account in another currency than the invoice takes a payment only with the amount in its own currency. A payment
 * typed in rupees where it was taken — a CRM balance payment, a CS Portal course payment — had that amount on it
 * (`original`) and was still left out: only an enrolment's own payments used it. invoice.service uses it everywhere
 * since 2026-11-26; this puts in the ones recorded before: what the payment was made in becomes what landed, and its
 * line is made in the account — a credit, matched to the invoice — so the balance and the cash book show it.
 *
 * Lists what it would put in and, apart, what it can't: payments kept against such an account with no amount in its
 * currency on record at all — those need it typed on the payment (the pencil on the invoice). One waiting for a
 * manager to approve it being entered late is left; it goes in when it is approved. With --write, saves an undo file
 * first. --expect N refuses unless exactly N would be put in. --org <id> keeps to one organization.
 * --undo <file> takes out again what a run put in (one whose line a bank statement was reconciled against since, or
 * that was changed since, is left).
 * Run it from apps/api on the server, after the API with the fix is deployed:
 *
 *   bun src/scripts/rupees-into-account.ts
 *   bun src/scripts/rupees-into-account.ts --expect 7 --write
 *   bun src/scripts/rupees-into-account.ts --undo rupees-into-account-undo-….json
 */
import mongoose, { Types } from "mongoose";
import { readFileSync, writeFileSync } from "node:fs";

interface UndoRow {
  invoiceId: string; invoiceNumber: string; paymentId: string;
  /** As it was. */
  bankAmountMinor: number | null; bankCurrency: string; bankNote: string;
  /** What the run put in — a payment that no longer says this was changed since, and is left. */
  landedMinor: number;
}
export interface OutOfAccount {
  invoiceId: string; organizationId: string; invoiceNumber: string; customerName: string; invoiceCurrency: string;
  paymentId: string; paidOn: string; method: string; recordedMinor: number;
  accountId: string; accountName: string; accountCurrency: string;
  /** What would land, in the account's currency; absent: nothing on record says. */
  landsMinor?: number;
  /** Why it is left, when it is. */
  left?: string;
  before: { bankAmountMinor: number | null; bankCurrency: string; bankNote: string };
}

const money = (minor: number, cur: string) => `${cur} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: unknown) => new Date(d as string).toISOString().slice(0, 10);

/** Every payment kept against an account in another currency than its invoice, and not in it. */
export async function outOfAccount(orgId?: string): Promise<OutOfAccount[]> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { BankAccount } = await import("../modules/banking/bank-account.model");
  const { landingOf } = await import("../modules/invoice/payment-bank");
  const invoices = await (Invoice as mongoose.Model<any>).find({
    ...(orgId ? { organizationId: new Types.ObjectId(orgId) } : {}),
    status: { $ne: "void" },
    payments: { $elemMatch: { bankAccountId: { $ne: null }, bankTransactionId: null, bankNote: { $nin: ["", null] } } },
  }).select("organizationId invoiceNumber customerName currency payments").sort({ issueDate: 1, invoiceNumber: 1 }).lean<any[]>();
  const accounts = new Map<string, { _id: Types.ObjectId; accountName: string; currency: string } | null>();
  const accountOf = async (id: string) => {
    if (!accounts.has(id)) accounts.set(id, await (BankAccount as mongoose.Model<any>).findById(id).select("accountName currency").lean<any>());
    return accounts.get(id) ?? null;
  };
  const out: OutOfAccount[] = [];
  for (const inv of invoices) {
    const invoiceCurrency = String(inv.currency || "AED");
    for (const p of inv.payments ?? []) {
      if (!p.bankAccountId || p.bankTransactionId || !p.bankNote) continue;
      const account = await accountOf(String(p.bankAccountId));
      // Only an account in another currency: one that has gone, or a line that failed for another reason, is not this.
      if (!account || account.currency === invoiceCurrency) continue;
      const landing = landingOf(account as never, invoiceCurrency, { amountMinor: p.amountMinor ?? 0, chargesMinor: p.chargesMinor ?? 0, bankAmountMinor: p.bankAmountMinor ?? null }, p.original ?? null);
      out.push({
        invoiceId: String(inv._id), organizationId: String(inv.organizationId), invoiceNumber: inv.invoiceNumber, customerName: inv.customerName ?? "", invoiceCurrency,
        paymentId: String(p._id), paidOn: day(p.paidOn), method: String(p.method ?? ""), recordedMinor: p.amountMinor ?? 0,
        accountId: String(account._id), accountName: account.accountName, accountCurrency: account.currency,
        ...(landing.amountMinor !== undefined ? { landsMinor: landing.amountMinor } : {}),
        ...(landing.amountMinor !== undefined && p.lateEntry?.state === "pending" ? { left: "waiting for a manager to approve it being entered late — it goes in when approved" } : {}),
        before: { bankAmountMinor: p.bankAmountMinor ?? null, bankCurrency: String(p.bankCurrency ?? ""), bankNote: String(p.bankNote ?? "") },
      });
    }
  }
  return out;
}

export async function rupeesIntoAccount(opts: { orgId?: string; write: boolean; expect?: number; undoFile?: string }): Promise<{ lines: string[]; put: number; undoFile?: string }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { syncPaymentLine } = await import("../modules/invoice/payment-bank");
  const rows = await outOfAccount(opts.orgId);
  const can = rows.filter((r) => r.landsMinor !== undefined && !r.left);
  const waiting = rows.filter((r) => r.landsMinor !== undefined && r.left);
  const cannot = rows.filter((r) => r.landsMinor === undefined);
  const says = (r: OutOfAccount) => `${r.invoiceNumber} · ${r.customerName || "—"} · paid ${r.paidOn} · recorded ${money(r.recordedMinor, r.invoiceCurrency)}`;

  const lines: string[] = [];
  lines.push(`To put in (${can.length}):`);
  for (const r of can) lines.push(`  ${says(r)} → ${money(r.landsMinor!, r.accountCurrency)} into ${r.accountName}`);
  const totals = new Map<string, { name: string; currency: string; minor: number; n: number }>();
  for (const r of can) {
    const t = totals.get(r.accountId) ?? { name: r.accountName, currency: r.accountCurrency, minor: 0, n: 0 };
    t.minor += r.landsMinor!;
    t.n++;
    totals.set(r.accountId, t);
  }
  for (const t of totals.values()) lines.push(`  = ${t.n} payment${t.n === 1 ? "" : "s"}, ${money(t.minor, t.currency)} into ${t.name}`);
  if (waiting.length) {
    lines.push(`Left for now (${waiting.length}):`);
    for (const r of waiting) lines.push(`  ${says(r)} — ${r.left}`);
  }
  lines.push(`No amount in the account's currency on record (${cannot.length}) — type it on the payment (the pencil on the invoice):`);
  for (const r of cannot) lines.push(`  ${says(r)} · ${r.accountName} is in ${r.accountCurrency}`);

  if (opts.expect !== undefined && opts.expect !== can.length) throw new Error(`Expected ${opts.expect} to put in, found ${can.length} — nothing changed`);
  if (!opts.write || !can.length) return { lines, put: 0 };

  const undo: UndoRow[] = can.map((r) => ({ invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, paymentId: r.paymentId, ...r.before, landedMinor: r.landsMinor! }));
  const undoFile = opts.undoFile ?? `rupees-into-account-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(undoFile, JSON.stringify(undo, null, 2));
  if ((JSON.parse(readFileSync(undoFile, "utf8")) as UndoRow[]).length !== undo.length) throw new Error(`The undo file ${undoFile} didn't read back — nothing changed`);

  let put = 0;
  for (const r of can) {
    // Only a payment still as it was listed: one put in or changed meanwhile is left.
    const set = await (Invoice as mongoose.Model<any>).updateOne(
      { _id: r.invoiceId, payments: { $elemMatch: { _id: new Types.ObjectId(r.paymentId), bankTransactionId: null, bankNote: r.before.bankNote } } },
      { $set: { "payments.$.bankAmountMinor": r.landsMinor, "payments.$.bankCurrency": r.accountCurrency, "payments.$.bankNote": "" } },
    );
    if (!set.modifiedCount) { lines.push(`  ${r.invoiceNumber}: changed since it was listed — left`); continue; }
    await syncPaymentLine({ _id: new Types.ObjectId(r.invoiceId), organizationId: new Types.ObjectId(r.organizationId), invoiceNumber: r.invoiceNumber, customerName: r.customerName, currency: r.invoiceCurrency }, r.paymentId);
    const now = await (Invoice as mongoose.Model<any>).findOne({ _id: r.invoiceId }, { payments: { $elemMatch: { _id: new Types.ObjectId(r.paymentId) } } }).lean<any>();
    const p = now?.payments?.[0];
    if (p?.bankTransactionId) put++;
    else lines.push(`  ${r.invoiceNumber}: not put in — ${p?.bankNote || "no line was made"}`);
  }
  lines.push(`${put} of ${can.length} put in`);
  return { lines, put, undoFile };
}

export async function undoRupeesIntoAccount(file: string): Promise<string[]> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { assertLineMovable, syncPaymentLine } = await import("../modules/invoice/payment-bank");
  const rows = JSON.parse(readFileSync(file, "utf8")) as UndoRow[];
  const out: string[] = [];
  for (const u of rows) {
    const inv = await (Invoice as mongoose.Model<any>).findById(u.invoiceId).select("organizationId invoiceNumber customerName currency payments").lean<any>();
    const p = (inv?.payments ?? []).find((x: any) => String(x._id) === u.paymentId);
    if (!inv || !p) { out.push(`${u.invoiceNumber}: the payment has gone — left`); continue; }
    if (p.bankNote || Number(p.bankAmountMinor) !== u.landedMinor) { out.push(`${u.invoiceNumber}: changed since — left`); continue; }
    const refused = await assertLineMovable(String(inv.organizationId), p).then(() => "", (e: Error) => e.message);
    if (refused) { out.push(`${u.invoiceNumber}: ${refused} — left`); continue; }
    await (Invoice as mongoose.Model<any>).updateOne(
      { _id: inv._id, "payments._id": p._id },
      { $set: { "payments.$.bankAmountMinor": u.bankAmountMinor, "payments.$.bankCurrency": u.bankCurrency, "payments.$.bankNote": u.bankNote } },
    );
    // With its note back it has no line: the one made goes.
    await syncPaymentLine({ _id: inv._id, organizationId: inv.organizationId, invoiceNumber: inv.invoiceNumber, customerName: inv.customerName, currency: inv.currency }, u.paymentId);
    out.push(`${u.invoiceNumber}: taken out, as it was`);
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    if (arg("--undo")) {
      for (const l of await undoRupeesIntoAccount(arg("--undo"))) console.log(l);
    } else {
      const write = argv.includes("--write");
      if (arg("--org") && !Types.ObjectId.isValid(arg("--org"))) throw new Error("--org takes an organization id");
      const r = await rupeesIntoAccount({ orgId: arg("--org") || undefined, write, expect: arg("--expect") ? Number(arg("--expect")) : undefined });
      for (const l of r.lines) console.log(l);
      if (r.undoFile) console.log(`\nUndo file: ${r.undoFile}`);
      if (!write) console.log("\nNothing written. Check it, then run it again with --expect <the count to put in> --write.");
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  await mongoose.disconnect();
}
