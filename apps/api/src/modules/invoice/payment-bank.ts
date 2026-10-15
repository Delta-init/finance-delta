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
 * finance records itself (at an enrolment's approval, a course payment or a balance payment from Tetra Commission or a
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
 */

type Account = { _id: Types.ObjectId; accountName: string; currency: string; accountType?: string; isActive?: boolean };
type StoredPayment = {
  _id: Types.ObjectId; method: string; amountMinor: number; chargesMinor?: number; paidOn: Date; reference?: string;
  receiptNumber?: string; bankAccountId?: Types.ObjectId | null; bankTransactionId?: Types.ObjectId | null;
  bankAmountMinor?: number | null; bankCurrency?: string; bankNote?: string;
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

/** Whether a payment's line may move: not once a bank statement was reconciled against it (a tin's may). */
export async function assertLineMovable(orgId: string, p: StoredPayment | undefined | null): Promise<void> {
  if (!p?.bankTransactionId) return;
  const tx = await BankTransaction.findOne({ _id: p.bankTransactionId, organizationId: oid(orgId) }).select("isReconciled accountId accountName").lean<any>();
  if (!tx?.isReconciled) return;
  const acc = await BankAccount.findById(tx.accountId).select("accountType").lean<any>();
  if (acc?.accountType === "petty_cash") return;
  throw new AppError("CONFLICT", `This payment's line in ${tx.accountName} has been reconciled against a bank statement — its account, amount and date can't change now`);
}

async function removeLine(orgId: string, txId: Types.ObjectId | null | undefined): Promise<void> {
  if (!txId) return;
  const tx = await BankTransaction.findOneAndDelete({ _id: txId, organizationId: oid(orgId) }).lean<any>();
  if (tx) await recalculateRunningBalances(orgId, tx.accountId);
}

/** The line a payment should have, or null. */
function wantedLine(inv: InvoiceLike, p: StoredPayment) {
  if (!p.bankAccountId || p.bankNote || !(Number(p.bankAmountMinor) > 0)) return null;
  const method = paymentMethodLabel(p.method) || p.method;
  return {
    accountId: String(p.bankAccountId),
    amountMinor: Number(p.bankAmountMinor),
    date: new Date(p.paidOn),
    description: `${inv.invoiceNumber}${inv.customerName ? ` · ${inv.customerName}` : ""} · ${method}`.slice(0, 300),
    reference: String(p.receiptNumber || p.reference || inv.invoiceNumber).slice(0, 200),
  };
}

/**
 * Brings a payment's line in its account into line with the payment: made, moved, changed or removed. Called after the
 * invoice is saved. Never throws once the payment is saved — a line that could not be written is said on the payment.
 */
export async function syncPaymentLine(inv: InvoiceLike, paymentId: unknown): Promise<void> {
  const orgId = String(inv.organizationId);
  const { Invoice } = await import("./invoice.model");
  const fresh = await Invoice.findById(inv._id).select("organizationId invoiceNumber customerName currency payments").lean<any>();
  const p: StoredPayment | undefined = (fresh?.payments ?? []).find((x: any) => String(x._id) === String(paymentId));
  if (!fresh || !p) return;
  const want = wantedLine(fresh, p);
  try {
    const have = p.bankTransactionId
      ? await BankTransaction.findOne({ _id: p.bankTransactionId, organizationId: oid(orgId) }).lean<any>()
      : null;
    if (have && want && String(have.accountId) === want.accountId && have.amountMinor === want.amountMinor
      && new Date(have.date).getTime() === want.date.getTime()) {
      if (have.description !== want.description || have.reference !== want.reference) {
        await BankTransaction.updateOne({ _id: have._id }, { $set: { description: want.description, reference: want.reference } });
      }
      return;
    }
    if (have) await removeLine(orgId, have._id);
    let txId: Types.ObjectId | null = null;
    if (want) {
      const account = await BankAccount.findOne({ _id: oid(want.accountId), organizationId: oid(orgId) }).select("accountName currency").lean<any>();
      if (account) {
        const tx = await BankTransaction.create({
          organizationId: oid(orgId), accountId: account._id, accountName: account.accountName, currency: account.currency,
          date: want.date, description: want.description, reference: want.reference,
          amountMinor: want.amountMinor, type: "credit", runningBalanceMinor: 0, source: "manual", status: "matched",
          matches: [{ type: "invoice", referenceId: String(fresh._id), referenceNumber: fresh.invoiceNumber, amountMinor: want.amountMinor }],
          notes: `Payment on invoice ${fresh.invoiceNumber} — it moves with the payment`,
        });
        await recalculateRunningBalances(orgId, account._id);
        txId = tx._id;
      }
    }
    const note = want && !txId ? "The account has gone — pick another" : undefined;
    await Invoice.updateOne({ _id: fresh._id, "payments._id": p._id }, {
      $set: { "payments.$.bankTransactionId": txId, ...(note ? { "payments.$.bankNote": note } : {}) },
    });
    // The caller's copy too, so what it answers says where the payment is.
    const mine = ((inv.payments as { _id: unknown; set?: (k: string, v: unknown) => void }[] | undefined) ?? []).find((x) => String(x._id) === String(p._id));
    if (mine?.set) {
      mine.set("bankTransactionId", txId);
      if (note) mine.set("bankNote", note);
    }
  } catch (err) {
    const { logger } = await import("../../lib/logger");
    logger.error({ err, invoiceId: String(fresh._id), paymentId: String(paymentId) }, "Could not put the payment in its bank account");
    await Invoice.updateOne({ _id: fresh._id, "payments._id": p._id }, {
      $set: { "payments.$.bankNote": `Not put in the account: ${(err as Error).message}`.slice(0, 300) },
    }).catch(() => undefined);
  }
}

/** A deleted payment's line goes with it. */
export async function removePaymentLine(orgId: string, p: StoredPayment | undefined | null): Promise<void> {
  if (p?.bankTransactionId) await removeLine(orgId, p.bankTransactionId);
}
