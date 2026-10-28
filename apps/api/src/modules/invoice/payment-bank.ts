import { Types } from "mongoose";
import { paymentMethodLabel } from "@delta/shared";
import { AppError } from "../../lib/http";
import { BankAccount } from "../banking/bank-account.model";
import { BankTransaction } from "../banking/bank-transaction.model";
import { recalculateRunningBalances } from "../banking/banking.service";
import { Organization } from "../organization/organization.model";

/*
 * Where an invoice payment lands, and its line in that account (the user, 2026-10-16: "INR payment will go under the
 * bank Yaroon Bank … Tabby, Tamara, Smart invoice, Card — Bank Account, and Cash to Petty cash … show in bank").
 *
 * Each organization says which of its Banking accounts each payment method goes into (Settings → Where payments go,
 * `paymentAccounts`). A payment takes its method's account unless it was given one — or none — and every payment
 * finance records itself (at an enrolment's approval, a course payment or a balance payment from CS Portal or a
 * CRM) takes it the same way. Accounts change it whenever they like, after approval too.
 *
 * A payment with an account has its own line in it: a credit, matched to the invoice (as a payroll payment's debit is
 * matched to its run), so the account's balance and cash book show it. The line follows the payment — edited, it
 * moves; deleted, it goes — unless a bank statement has been reconciled against it (a petty-cash tin's count can be
 * redone, so a tin's line still moves).
 *
 * What lands: the payment less its charges, in the invoice's currency. An account in another currency (an INR account
 * for an AED invoice) needs the amount in its own currency — given on the payment, or the original the CRM kept at the
 * close — and without one the payment keeps the account but stays out of it, saying why (`bankNote`).
 *
 * Shown as two lines when there are charges (the user, 2026-10-16: "show as two lines, one the actual amount and the
 * charges minus"): a credit of the full payment, as the invoice shows it, and a debit of its charges — so each line
 * matches the invoice, and the balance still moves by what landed. In an account in another currency the charges are
 * taken at the payment's own rate (what landed over the payment less charges).
 */

type Account = { _id: Types.ObjectId; accountName: string; currency: string; accountType?: string; isActive?: boolean };
type StoredPayment = {
  _id: Types.ObjectId; method: string; amountMinor: number; chargesMinor?: number; paidOn: Date; reference?: string;
  receiptNumber?: string; bankAccountId?: Types.ObjectId | null; bankTransactionId?: Types.ObjectId | null;
  bankChargesTransactionId?: Types.ObjectId | null;
  bankAmountMinor?: number | null; bankCurrency?: string; bankNote?: string; lateEntry?: { state?: string } | null;
};
type InvoiceLike = { _id: Types.ObjectId; organizationId: Types.ObjectId; invoiceNumber: string; customerName?: string; currency?: string; payments?: unknown };

const oid = (v: unknown) => new Types.ObjectId(String(v));

/** The organization's account for each payment method, by method. */
export async function paymentAccountsOf(orgId: string): Promise<Record<string, string>> {
  const org = await Organization.findById(orgId).select("paymentAccounts").lean<{ paymentAccounts?: Record<string, string> }>();
  return { ...(org?.paymentAccounts ?? {}) };
}

async function accountById(orgId: string, id: string): Promise<Account | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  return BankAccount.findOne({ _id: oid(id), organizationId: oid(orgId) }).select("accountName currency accountType isActive").lean<Account>();
}

/**
 * The account a payment goes into: the one named (`""` for none), else its method's (`defaults`, read once per call
 * site). One named that is not this organization's, or is closed, is refused; a method's that has gone is ignored.
 */
export async function resolvePaymentAccount(
  orgId: string, method: string, named: string | undefined, defaults?: Record<string, string>,
): Promise<Account | null> {
  if (named !== undefined) {
    if (named === "") return null;
    const acc = await accountById(orgId, named);
    if (!acc) throw new AppError("VALIDATION_ERROR", "That bank account is not one of this organization's");
    if (acc.isActive === false) throw new AppError("VALIDATION_ERROR", `${acc.accountName} is closed`);
    return acc;
  }
  const id = (defaults ?? (await paymentAccountsOf(orgId)))[method];
  if (!id) return null;
  const acc = await accountById(orgId, id);
  return acc && acc.isActive !== false ? acc : null;
}

/**
 * What lands in the account, in its currency, or why nothing can: the payment less charges when the account is in the
 * invoice's currency; else the amount given in the account's currency (`bankAmountMinor`), or the close's original
 * when that was in the account's currency.
 */
export function landingOf(
  account: Account, invoiceCurrency: string,
  p: { amountMinor: number; chargesMinor?: number; bankAmountMinor?: number | null },
  original?: { currency?: string; amountMinor?: number } | null,
): { amountMinor: number; note?: undefined } | { amountMinor?: undefined; note: string } {
  if (account.currency === invoiceCurrency) {
    if (p.bankAmountMinor && p.bankAmountMinor > 0) return { amountMinor: p.bankAmountMinor };
    return { amountMinor: Math.max(0, p.amountMinor - (p.chargesMinor ?? 0)) };
  }
  if (p.bankAmountMinor && p.bankAmountMinor > 0) return { amountMinor: p.bankAmountMinor };
  if (original?.currency === account.currency && Number(original.amountMinor) > 0) return { amountMinor: Number(original.amountMinor) };
  return { note: `${account.accountName} is in ${account.currency} — give the amount received in ${account.currency} to put it in the account` };
}

/** Stamps the account on a payment that is about to be saved: its name, and what will land (or why nothing will). */
export function stampAccount(
  target: Record<string, unknown>, account: Account | null, invoiceCurrency: string, original?: { currency?: string; amountMinor?: number } | null,
): void {
  if (!account) {
    target.bankAccountId = null;
    target.bankNote = "";
    return;
  }
  target.bankAccountId = account._id;
  target.accountName = account.accountName;
  const landing = landingOf(account, invoiceCurrency, target as never, original);
  target.bankCurrency = account.currency;
  if (landing.amountMinor !== undefined) {
    target.bankAmountMinor = landing.amountMinor;
    target.bankNote = "";
  } else {
    target.bankNote = landing.note;
  }
}

/** Whether a payment's lines may move: not once a bank statement was reconciled against either (a tin's may). */
export async function assertLineMovable(orgId: string, p: StoredPayment | undefined | null): Promise<void> {
  for (const id of [p?.bankTransactionId, p?.bankChargesTransactionId]) {
    if (!id) continue;
    const tx = await BankTransaction.findOne({ _id: id, organizationId: oid(orgId) }).select("isReconciled accountId accountName").lean<any>();
    if (!tx?.isReconciled) continue;
    const acc = await BankAccount.findById(tx.accountId).select("accountType").lean<any>();
    if (acc?.accountType === "petty_cash") continue;
    throw new AppError("CONFLICT", `This payment's line in ${tx.accountName} has been reconciled against a bank statement — its account, amount and date can't change now`);
  }
}

async function removeLine(orgId: string, txId: Types.ObjectId | null | undefined): Promise<void> {
  if (!txId) return;
  const tx = await BankTransaction.findOneAndDelete({ _id: txId, organizationId: oid(orgId) }).lean<any>();
  if (tx) await recalculateRunningBalances(orgId, tx.accountId);
}

/** The lines a payment should have, or null: its full credit, and its charges' debit (null when it has none). */
function wantedLines(inv: InvoiceLike, p: StoredPayment) {
  if (!p.bankAccountId || p.bankNote || !(Number(p.bankAmountMinor) > 0)) return null;
  // Not while it waits for a manager to approve it being entered late.
  if (p.lateEntry?.state === "pending") return null;
  const method = paymentMethodLabel(p.method) || p.method;
  const landed = Number(p.bankAmountMinor);
  const charges = Number(p.chargesMinor) || 0;
  const net = p.amountMinor - charges;
  // In the account's currency: as given when it is the payment's own; else at the payment's rate.
  const chargesHere = charges > 0 ? (landed === net ? charges : net > 0 ? Math.round((charges * landed) / net) : 0) : 0;
  const base = `${inv.invoiceNumber}${inv.customerName ? ` · ${inv.customerName}` : ""} · ${method}`;
  const reference = String(p.receiptNumber || p.reference || inv.invoiceNumber).slice(0, 200);
  return {
    accountId: String(p.bankAccountId),
    date: new Date(p.paidOn),
    credit: { amountMinor: landed + chargesHere, description: base.slice(0, 300), reference },
    debit: chargesHere > 0 ? { amountMinor: chargesHere, description: `${base} charges`.slice(0, 300), reference } : null,
  };
}

type Line = { amountMinor: number; description: string; reference: string };

/** One of a payment's lines brought into line: kept, its words updated, or removed and made again. Returns its id. */
async function syncOne(
  orgId: string, invoice: { _id: unknown; invoiceNumber: string }, haveId: Types.ObjectId | null | undefined,
  want: { accountId: string; date: Date } | null, line: Line | null, type: "credit" | "debit",
): Promise<{ id: Types.ObjectId | null; changed: boolean; missingAccount: boolean }> {
  const have = haveId ? await BankTransaction.findOne({ _id: haveId, organizationId: oid(orgId) }).lean<any>() : null;
  // Signed, as the account keeps it: a debit is negative (as payroll's is), so the balance moves by what landed.
  const signed = line ? (type === "debit" ? -line.amountMinor : line.amountMinor) : 0;
  if (have && want && line && String(have.accountId) === want.accountId && have.amountMinor === signed
    && have.type === type && new Date(have.date).getTime() === want.date.getTime()) {
    if (have.description !== line.description || have.reference !== line.reference) {
      await BankTransaction.updateOne({ _id: have._id }, { $set: { description: line.description, reference: line.reference } });
    }
    return { id: have._id, changed: false, missingAccount: false };
  }
  if (have) await removeLine(orgId, have._id);
  if (!want || !line) return { id: null, changed: !!have, missingAccount: false };
  const account = await BankAccount.findOne({ _id: oid(want.accountId), organizationId: oid(orgId) }).select("accountName currency").lean<any>();
  if (!account) return { id: null, changed: true, missingAccount: true };
  const tx = await BankTransaction.create({
    organizationId: oid(orgId), accountId: account._id, accountName: account.accountName, currency: account.currency,
    date: want.date, description: line.description, reference: line.reference,
    amountMinor: signed, type, runningBalanceMinor: 0, source: "manual", status: "matched",
    matches: [{ type: "invoice", referenceId: String(invoice._id), referenceNumber: invoice.invoiceNumber, amountMinor: line.amountMinor }],
    notes: type === "credit"
      ? `Payment on invoice ${invoice.invoiceNumber} — it moves with the payment`
      : `Charges on the payment on invoice ${invoice.invoiceNumber} — they move with the payment`,
  });
  return { id: tx._id, changed: true, missingAccount: false };
}

/**
 * Brings a payment's lines in its account into line with the payment — its full credit and its charges' debit: made,
 * moved, changed or removed. Called after the invoice is saved. Never throws once the payment is saved — a line that
 * could not be written is said on the payment. Returns whether anything changed (the backfill counts it).
 */
export async function syncPaymentLine(inv: InvoiceLike, paymentId: unknown): Promise<boolean> {
  const orgId = String(inv.organizationId);
  const { Invoice } = await import("./invoice.model");
  const fresh = await Invoice.findById(inv._id).select("organizationId invoiceNumber customerName currency payments").lean<any>();
  const p: StoredPayment | undefined = (fresh?.payments ?? []).find((x: any) => String(x._id) === String(paymentId));
  if (!fresh || !p) return false;
  const want = wantedLines(fresh, p);
  try {
    const credit = await syncOne(orgId, fresh, p.bankTransactionId, want, want?.credit ?? null, "credit");
    const debit = await syncOne(orgId, fresh, p.bankChargesTransactionId, want, want?.debit ?? null, "debit");
    const changed = credit.changed || debit.changed;
    if (changed && want) {
      const account = await BankAccount.findOne({ _id: oid(want.accountId), organizationId: oid(orgId) }).select("_id").lean<any>();
      if (account) await recalculateRunningBalances(orgId, account._id);
    }
    const note = want && !credit.id ? "The account has gone — pick another" : undefined;
    if (changed || String(p.bankTransactionId ?? "") !== String(credit.id ?? "") || String(p.bankChargesTransactionId ?? "") !== String(debit.id ?? "")) {
      await Invoice.updateOne({ _id: fresh._id, "payments._id": p._id }, {
        $set: { "payments.$.bankTransactionId": credit.id, "payments.$.bankChargesTransactionId": debit.id, ...(note ? { "payments.$.bankNote": note } : {}) },
      });
    }
    // The caller's copy too, so what it answers says where the payment is.
    const mine = ((inv.payments as { _id: unknown; set?: (k: string, v: unknown) => void }[] | undefined) ?? []).find((x) => String(x._id) === String(p._id));
    if (mine?.set) {
      mine.set("bankTransactionId", credit.id);
      mine.set("bankChargesTransactionId", debit.id);
      if (note) mine.set("bankNote", note);
    }
    return changed;
  } catch (err) {
    const { logger } = await import("../../lib/logger");
    logger.error({ err, invoiceId: String(fresh._id), paymentId: String(paymentId) }, "Could not put the payment in its bank account");
    await Invoice.updateOne({ _id: fresh._id, "payments._id": p._id }, {
      $set: { "payments.$.bankNote": `Not put in the account: ${(err as Error).message}`.slice(0, 300) },
    }).catch(() => undefined);
    return false;
  }
}

/** A deleted payment's lines go with it — its credit and its charges' debit. */
export async function removePaymentLine(orgId: string, p: StoredPayment | undefined | null): Promise<void> {
  if (p?.bankTransactionId) await removeLine(orgId, p.bankTransactionId);
  if (p?.bankChargesTransactionId) await removeLine(orgId, p.bankChargesTransactionId);
}
