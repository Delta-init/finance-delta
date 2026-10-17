import { Types } from "mongoose";
import type { CreateBillInput, UpdateBillInput, Bill as BillDTO, BillQuery, Paginated, RecordBillPaymentInput } from "@delta/shared";
import type { ParsedFile } from "../../middleware/upload";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { Bill, type BillDoc } from "./bill.model";
import { Vendor } from "../vendor/vendor.model";
import { nextNumber } from "../sequence/sequence.service";
import { notifyBillWaiting } from "./bill-notify.service";
import { assertDebitMovable, debitAccount, syncDebitLine } from "../banking/money-out";
import { paymentAccountsOf } from "../invoice/payment-bank";
import { isLatePending, lateView } from "../late-entry/late-entry.model";
import { lateForDate, openLateEntry, withdrawLateFor, type LateActor } from "../late-entry/late-entry.service";

function lineTotal(l: { quantity: number; unitPriceMinor: number; discountPct: number; taxPct: number }) {
  const sub = l.quantity * l.unitPriceMinor;
  const disc = Math.round(sub * l.discountPct / 100);
  const taxable = sub - disc;
  return taxable + Math.round(taxable * l.taxPct / 100);
}

/** Whole units with separators, for a message somebody has to read. */
function formatMinor(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateOnly(d: Date | undefined): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

function toDTO(doc: BillDoc): BillDTO {
  const d = doc as unknown as Record<string, unknown>;
  return {
    id: doc._id.toString(),
    billNumber: doc.billNumber,
    vendorId: String(doc.vendorId),
    vendorName: doc.vendorName,
    sourcePOId: d.sourcePOId ? String(d.sourcePOId) : undefined,
    sourcePONumber: (d.sourcePONumber as string) ?? undefined,
    billDate: dateOnly(doc.billDate as unknown as Date),
    dueDate: dateOnly(doc.dueDate as unknown as Date),
    status: doc.status as BillDTO["status"],
    approvalStatus: (d.approvalStatus as BillDTO["approvalStatus"]) ?? "not_required",
    currency: (doc.currency as string) ?? "AED",
    lineItems: (doc.lineItems as unknown as BillDTO["lineItems"]),
    subtotalMinor: (doc.subtotalMinor as number) ?? 0,
    taxTotalMinor: (doc.taxTotalMinor as number) ?? 0,
    totalMinor: (doc.totalMinor as number) ?? 0,
    amountPaidMinor: (doc.amountPaidMinor as number) ?? 0,
    balanceMinor: (doc.balanceMinor as number) ?? 0,
    payments: ((doc.payments as unknown[]) ?? []).map((p) => {
      const pm = p as {
        _id: { toString(): string };
        method: string;
        amountMinor: number;
        paidOn: Date;
        reference: string;
        accountName: string;
        bankAccountId?: { toString(): string } | null;
        bankTransactionId?: unknown;
        bankNote?: string;
        lateEntry?: unknown;
        notes: string;
        chargesMinor?: number;
        emi?: {
          bank?: string;
          tenureMonths?: number;
          monthlyAmountMinor?: number;
          interestPct?: number;
          processingFeeMinor?: number;
          transactionId?: string;
        };
        createdAt: Date;
      };
      return {
        id: pm._id.toString(),
        method: pm.method as BillDTO["payments"][0]["method"],
        amountMinor: pm.amountMinor,
        paidOn: dateOnly(pm.paidOn),
        reference: pm.reference ?? "",
        accountName: pm.accountName ?? "",
        bankAccountId: pm.bankAccountId ? pm.bankAccountId.toString() : undefined,
        inBank: pm.bankAccountId ? Boolean(pm.bankTransactionId) : undefined,
        bankNote: pm.bankNote || undefined,
        lateEntry: lateView(pm.lateEntry),
        notes: pm.notes ?? "",
        chargesMinor: pm.chargesMinor ?? 0,
        emi: pm.emi
          ? {
              bank: pm.emi.bank ?? "",
              tenureMonths: pm.emi.tenureMonths ?? 0,
              monthlyAmountMinor: pm.emi.monthlyAmountMinor ?? 0,
              interestPct: pm.emi.interestPct ?? 0,
              processingFeeMinor: pm.emi.processingFeeMinor ?? 0,
              transactionId: pm.emi.transactionId ?? "",
            }
          : undefined,
        createdAt: pm.createdAt?.toISOString() ?? new Date().toISOString(),
      };
    }),
    attachments: ((doc as unknown as Record<string, unknown>).attachments as unknown[] ?? []).map((a) => {
      const at = a as { _id: { toString(): string }; name: string; url: string; mimeType?: string; size?: number; createdAt?: Date };
      return {
        id: at._id.toString(),
        name: at.name,
        url: at.url,
        mimeType: at.mimeType ?? "",
        size: at.size ?? 0,
        uploadedAt: at.createdAt?.toISOString() ?? new Date().toISOString(),
      };
    }),
    lateEntry: lateView(d.lateEntry),
    notes: (doc.notes as string) ?? "",
    paymentTerms: (d.paymentTerms as string) ?? "",
    createdAt: doc.createdAt.toISOString(),
  };
}

const SORT = {
  number: "billNumber",
  vendor: "vendorName",
  billDate: "billDate",
  dueDate: "dueDate",
  status: "status",
  total: "totalMinor",
  balance: "balanceMinor",
  createdAt: "createdAt",
} as const;

export async function listBills(orgId: string, query: BillQuery): Promise<Paginated<BillDTO>> {
  const now = new Date();
  const and: Record<string, unknown>[] = [];
  const or = searchOr(query.q, ["billNumber", "vendorName"]);
  if (or) and.push({ $or: or });
  if (query.status) and.push({ status: query.status });
  if (query.vendorId) and.push({ vendorId: new Types.ObjectId(query.vendorId) });
  if (query.overdue) and.push({ status: { $in: ["approved", "partially_paid"] }, dueDate: { $lt: now } });
  if (query.dueFrom) and.push({ dueDate: { $gte: new Date(query.dueFrom) } });
  if (query.dueTo) and.push({ dueDate: { $lte: new Date(query.dueTo) } });

  const filter: Record<string, unknown> = { organizationId: orgId };
  if (and.length) filter.$and = and;

  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    Bill.find(filter).sort(sort).skip(skipFor(query.page, query.pageSize)).limit(query.pageSize),
    Bill.countDocuments(filter),
  ]);
  return { data: rows.map((r) => toDTO(r as unknown as BillDoc)), meta: pageMeta(total, query.page, query.pageSize) };
}

export async function getBill(orgId: string, id: string): Promise<BillDTO> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Bill not found");
  return toDTO(doc as unknown as BillDoc);
}

/** What the managers are shown of a bill, and of a payment on one, typed in late. */
const billLateInfo = (doc: any) => ({
  kind: "bill" as const, refId: doc._id, number: String(doc.billNumber ?? ""), title: String(doc.vendorName ?? ""),
  amountMinor: Number(doc.totalMinor ?? 0), currency: String(doc.currency ?? "AED"),
});
const paymentLateInfo = (doc: any, p: any) => ({
  kind: "bill_payment" as const, refId: doc._id, paymentId: p._id, number: String(doc.billNumber ?? ""),
  title: `${doc.vendorName ?? ""} · ${String(p.method ?? "").replace(/_/g, " ")}`, amountMinor: Number(p.amountMinor ?? 0), currency: String(doc.currency ?? "AED"),
});

/** Refused while a manager has still to approve the bill being entered late. */
function assertBillNotWaiting(doc: unknown, what: string): void {
  if (isLatePending((doc as { lateEntry?: unknown }).lateEntry)) {
    throw new AppError("CONFLICT", `This bill was entered late and is waiting for a manager — it can't be ${what} until one approves it`);
  }
}

export async function createBill(orgId: string, input: CreateBillInput, late?: LateActor): Promise<BillDTO> {
  const vendor = await Vendor.findOne({ _id: input.vendorId, organizationId: orgId });
  if (!vendor) throw new AppError("NOT_FOUND", "Vendor not found");

  const lines = input.lineItems.map((l) => ({ ...l, lineTotalMinor: lineTotal(l) }));
  const subtotalMinor = lines.reduce((s, l) => s + l.quantity * l.unitPriceMinor, 0);
  const taxTotalMinor = lines.reduce((s, l) => {
    const taxable = l.quantity * l.unitPriceMinor - Math.round(l.quantity * l.unitPriceMinor * l.discountPct / 100);
    return s + Math.round(taxable * l.taxPct / 100);
  }, 0);
  const totalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  const billNumber = await nextNumber(orgId, "bill", "BILL-");

  const lateNow = await lateForDate(orgId, late, input.billDate, null, null);
  const approvalStatus = input.requiresApproval ? "pending" : "not_required";
  const status = input.requiresApproval ? "pending_approval" : "approved";

  const doc = await Bill.create({
    organizationId: new Types.ObjectId(orgId),
    billNumber,
    vendorId: new Types.ObjectId(input.vendorId),
    vendorName: vendor.name,
    sourcePOId: input.sourcePOId ? new Types.ObjectId(input.sourcePOId) : undefined,
    billDate: new Date(input.billDate),
    dueDate: new Date(input.dueDate),
    currency: input.currency ?? (vendor.currency as string) ?? "AED",
    lineItems: lines,
    subtotalMinor,
    taxTotalMinor,
    totalMinor,
    balanceMinor: totalMinor,
    amountPaidMinor: 0,
    notes: input.notes ?? "",
    paymentTerms: input.paymentTerms ?? "",
    status,
    approvalStatus,
    lateEntry: lateNow.next ?? null,
  });
  if (lateNow.pending) await openLateEntry(orgId, lateNow.pending, billLateInfo(doc));
  // Held for approval: the accountants are told, as for every approval request.
  if (status === "pending_approval") {
    void notifyBillWaiting(orgId, {
      id: String(doc._id), billNumber, vendorName: doc.vendorName as string, totalMinor,
      currency: (doc.currency as string) ?? "AED", dueDate: doc.dueDate as Date,
    });
  }
  return toDTO(doc as unknown as BillDoc);
}

export async function updateBill(orgId: string, id: string, input: UpdateBillInput, late?: LateActor): Promise<BillDTO> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Bill not found");
  // A voided bill is a cancelled record and stays as it was. A paid one is
  // not: money having moved is a reason to get the bill right, not a reason to
  // leave it wrong. A vendor who re-issues a corrected invoice after a part
  // payment is ordinary, and the edit is the only way to record it.
  if (doc.status === "voided") throw new AppError("CONFLICT", "A voided bill can't be edited");

  if (input.vendorId && String(doc.vendorId) !== input.vendorId) {
    const vendor = await Vendor.findOne({ _id: input.vendorId, organizationId: orgId });
    if (!vendor) throw new AppError("NOT_FOUND", "Vendor not found");
    doc.vendorId = new Types.ObjectId(input.vendorId) as unknown as typeof doc.vendorId;
    doc.vendorName = vendor.name;
  }
  if (input.currency !== undefined) doc.currency = input.currency;
  // Its date moved: too far back and it waits for a manager; back within the days and it no longer does.
  const lateNow = input.billDate ? await lateForDate(orgId, late, input.billDate, doc.billDate as unknown as Date, (doc as any).lateEntry) : null;
  if (lateNow && lateNow.next !== undefined) (doc as any).lateEntry = lateNow.next;
  if (input.billDate) doc.billDate = new Date(input.billDate) as unknown as typeof doc.billDate;
  if (input.dueDate) doc.dueDate = new Date(input.dueDate) as unknown as typeof doc.dueDate;
  if (input.notes !== undefined) doc.notes = input.notes;
  if (input.paymentTerms !== undefined) (doc as unknown as Record<string, unknown>).paymentTerms = input.paymentTerms;

  if (input.lineItems) {
    const lines = input.lineItems.map((l) => ({ ...l, lineTotalMinor: lineTotal(l) }));
    const total = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
    const paid = (doc.amountPaidMinor as number) ?? 0;

    // Editing the bill below what has already gone out would make the vendor
    // owe money back, which a bill cannot express — its balance would go
    // negative and the books would quietly stop adding up. That situation is
    // real, but it is a vendor credit, not a smaller bill.
    if (total < paid) {
      throw new AppError(
        "CONFLICT",
        `This bill already has ${formatMinor(paid, doc.currency as string)} paid against it, so it cannot be reduced to ${formatMinor(total, doc.currency as string)}. Raise a vendor credit for the difference, or remove the payment first.`,
      );
    }

    doc.lineItems = lines as unknown as typeof doc.lineItems;
    doc.subtotalMinor = lines.reduce((s, l) => s + l.quantity * l.unitPriceMinor, 0);
    doc.taxTotalMinor = lines.reduce((s, l) => {
      const taxable = l.quantity * l.unitPriceMinor - Math.round(l.quantity * l.unitPriceMinor * l.discountPct / 100);
      return s + Math.round(taxable * l.taxPct / 100);
    }, 0);
    doc.totalMinor = total;
    doc.balanceMinor = total - paid;

    // The status describes what is outstanding, so changing the total changes
    // it: a part-paid bill edited down to what was paid is now settled, and one
    // edited up is owed again. Same rule recordBillPayment uses, so a bill
    // reaches a status the same way however it got there. Bills with nothing
    // paid keep whatever they had — approval state is not this function's
    // business.
    if (paid > 0) doc.status = doc.balanceMinor <= 0 ? "paid" : "partially_paid";
  }

  await doc.save();
  if (lateNow?.pending) await openLateEntry(orgId, lateNow.pending, billLateInfo(doc));
  else if (lateNow?.withdraw) await withdrawLateFor(orgId, "bill", doc._id);
  return toDTO(doc as unknown as BillDoc);
}

export async function approveBill(orgId: string, id: string): Promise<BillDTO> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Bill not found");
  if (doc.status !== "pending_approval") throw new AppError("CONFLICT", "Bill is not pending approval");
  assertBillNotWaiting(doc, "approved");
  doc.status = "approved";
  (doc as unknown as Record<string, unknown>).approvalStatus = "approved";
  await doc.save();
  return toDTO(doc as unknown as BillDoc);
}

export async function rejectBill(orgId: string, id: string): Promise<BillDTO> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Bill not found");
  if (doc.status !== "pending_approval") throw new AppError("CONFLICT", "Bill is not pending approval");
  doc.status = "draft";
  (doc as unknown as Record<string, unknown>).approvalStatus = "rejected";
  await doc.save();
  return toDTO(doc as unknown as BillDoc);
}

/* ── The Banking account a payment came out of, and its line there (2026-10-16) ─────────────────────────────── */

/** The account for a payment: the one named ("" for none), else the one it had, else its method's. Refused when named and not this organization's or closed. */
async function billPaymentAccount(orgId: string, method: string, named: string | undefined, had?: unknown): Promise<{ id: Types.ObjectId | null; name?: string }> {
  let id: string | null;
  if (named !== undefined) id = named || null;
  else if (had) id = String(had);
  else id = (await paymentAccountsOf(orgId))[method] ?? null;
  if (!id) return { id: null };
  const acc = await debitAccount(orgId, id, "");
  if ("note" in acc) {
    if (named) throw new AppError("VALIDATION_ERROR", acc.note);
    return { id: null };
  }
  return { id: new Types.ObjectId(acc.id), name: acc.name };
}

/** Brings one payment's money-out line into line with it. Never throws — what could not be done is said on the payment. */
async function syncBillPaymentLine(orgId: string, billId: unknown, paymentId: unknown): Promise<void> {
  const bill = await Bill.findOne({ _id: billId, organizationId: orgId }).lean<any>();
  const p = (bill?.payments ?? []).find((x: any) => String(x._id) === String(paymentId));
  if (!bill || !p) return;
  let note = "";
  let want: Parameters<typeof syncDebitLine>[2] = null;
  // Not while it waits for a manager to approve it being entered late.
  if (p.bankAccountId && !isLatePending(p.lateEntry)) {
    const acc = await debitAccount(orgId, String(p.bankAccountId), bill.currency ?? "AED");
    if ("note" in acc) note = acc.note;
    else {
      want = {
        accountId: acc.id,
        date: new Date(p.paidOn),
        amountMinor: p.amountMinor ?? 0,
        description: `${bill.billNumber} · ${bill.vendorName ?? ""}`.trim(),
        reference: String(p.reference || bill.billNumber),
        match: { type: "bill", referenceId: String(bill._id), referenceNumber: bill.billNumber },
      };
    }
  }
  try {
    const txId = await syncDebitLine(orgId, p.bankTransactionId, want);
    await Bill.updateOne({ _id: bill._id, "payments._id": p._id }, { $set: { "payments.$.bankTransactionId": txId, "payments.$.bankNote": note } });
  } catch (err) {
    await Bill.updateOne({ _id: bill._id, "payments._id": p._id }, { $set: { "payments.$.bankNote": `Not put in the account: ${(err as Error).message}`.slice(0, 300) } });
  }
}

/** For the backfill (scripts/bank-accounts-backfill.ts): one payment's line brought into line. */
export const resyncBillPaymentLine = (orgId: string, billId: string, paymentId: string) => syncBillPaymentLine(orgId, billId, paymentId);

/** The bill as saved, after its payments' lines. */
async function billDTO(orgId: string, id: unknown): Promise<BillDTO> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  return toDTO(doc as unknown as BillDoc);
}

export async function recordBillPayment(orgId: string, id: string, input: RecordBillPaymentInput, late?: LateActor): Promise<BillDTO> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Bill not found");
  if (!["approved", "partially_paid", "overdue"].includes(doc.status as string))
    throw new AppError("CONFLICT", "Bill must be approved or overdue to record a payment");
  assertBillNotWaiting(doc, "paid");

  const balance = (doc.balanceMinor as number) ?? 0;
  if (input.amountMinor > balance) throw new AppError("CONFLICT", "Payment exceeds outstanding balance");

  if (input.method === "easebuzz_emi" && (!input.emi || !input.emi.tenureMonths)) {
    throw new AppError("VALIDATION_ERROR", "EMI tenure is required for Easebuzz EMI payments");
  }

  const payment = {
    method: input.method,
    amountMinor: input.amountMinor,
    paidOn: new Date(input.paidOn),
    reference: input.reference ?? "",
    accountName: input.accountName ?? "",
    bankAccountId: null as Types.ObjectId | null,
    notes: input.notes ?? "",
    chargesMinor: input.chargesMinor ?? 0,
    emi:
      input.method === "easebuzz_emi" && input.emi
        ? {
            bank: input.emi.bank ?? "",
            tenureMonths: input.emi.tenureMonths,
            monthlyAmountMinor: input.emi.monthlyAmountMinor ?? 0,
            interestPct: input.emi.interestPct ?? 0,
            processingFeeMinor: input.emi.processingFeeMinor ?? 0,
            transactionId: input.emi.transactionId ?? "",
          }
        : undefined,
    createdAt: new Date(),
  };
  const acc = await billPaymentAccount(orgId, input.method, input.bankAccountId);
  payment.bankAccountId = acc.id;
  if (acc.name) payment.accountName = acc.name;
  const lateNow = await lateForDate(orgId, late, input.paidOn, null, null);
  (doc.payments as unknown[]).push({ ...payment, lateEntry: lateNow.next ?? null });
  doc.amountPaidMinor = ((doc.amountPaidMinor as number) ?? 0) + input.amountMinor;
  doc.balanceMinor = ((doc.balanceMinor as number) ?? 0) - input.amountMinor;
  doc.status = doc.balanceMinor <= 0 ? "paid" : "partially_paid";
  await doc.save();
  const added = (doc.payments as unknown as { _id: unknown }[]).at(-1);
  if (added && lateNow.pending) await openLateEntry(orgId, lateNow.pending, paymentLateInfo(doc, added));
  if (added) await syncBillPaymentLine(orgId, doc._id, added._id);
  return billDTO(orgId, doc._id);
}

export async function updateBillNotes(orgId: string, id: string, notes: string): Promise<BillDTO> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Bill not found");
  if (doc.status === "voided") throw new AppError("CONFLICT", "Cannot edit a voided bill");
  doc.notes = notes ?? "";
  await doc.save();
  return toDTO(doc as unknown as BillDoc);
}

export async function addBillAttachment(
  orgId: string,
  id: string,
  file: ParsedFile,
  name?: string,
): Promise<BillDTO> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Bill not found");

  const { uploadFile, storageConfigured } = await import("../../lib/storage");
  if (!storageConfigured()) throw new AppError("VALIDATION_ERROR", "File storage is not configured");

  const safe = file.originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `bills/${orgId}/${id}/att-${Date.now()}-${safe}`;
  const uploaded = await uploadFile({ key, buffer: file.buffer, mimeType: file.mimeType, originalName: file.originalName });

  const atts = (doc as unknown as { attachments: Array<Record<string, unknown>> }).attachments;
  atts.push({
    name: name?.trim() || file.originalName,
    url: uploaded.url,
    key: uploaded.key,
    mimeType: file.mimeType,
    size: uploaded.size,
  });
  await doc.save();
  return toDTO(doc as unknown as BillDoc);
}

export async function removeBillAttachment(orgId: string, id: string, attId: string): Promise<BillDTO> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Bill not found");

  const arr = (doc as unknown as {
    attachments: {
      id: (id: string) => { key?: string } | null;
      pull: (id: string) => void;
    };
  }).attachments;
  const target = arr.id(attId);
  if (!target) throw new AppError("NOT_FOUND", "Attachment not found");
  if (target.key) {
    const { deleteFile } = await import("../../lib/storage");
    await deleteFile(target.key);
  }
  arr.pull(attId);
  await doc.save();
  return toDTO(doc as unknown as BillDoc);
}

export async function updateBillPayment(
  orgId: string,
  id: string,
  paymentId: string,
  input: RecordBillPaymentInput,
  late?: LateActor,
): Promise<BillDTO> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Bill not found");
  if (doc.status === "voided") throw new AppError("CONFLICT", "Cannot edit a payment on a voided bill");

  const list = doc.payments as unknown as {
    id: (pid: string) => Record<string, unknown> | null;
  };
  const pm = list.id(paymentId);
  if (!pm) throw new AppError("NOT_FOUND", "Payment not found");

  if (input.method === "easebuzz_emi" && (!input.emi || !input.emi.tenureMonths)) {
    throw new AppError("VALIDATION_ERROR", "EMI tenure is required for Easebuzz EMI payments");
  }

  const others = (doc.payments as unknown as { amountMinor: number; _id: { toString(): string } }[])
    .filter((p) => p._id.toString() !== paymentId)
    .reduce((s, p) => s + (p.amountMinor ?? 0), 0);
  const newPaid = others + input.amountMinor;
  if (newPaid > ((doc.totalMinor as number) ?? 0)) {
    throw new AppError("CONFLICT", `Total payments would exceed the bill total of ${(doc.totalMinor as number) ?? 0}`);
  }

  const p = pm as Record<string, unknown>;
  const before = { amountMinor: p.amountMinor, paidOn: p.paidOn };
  // Its date moved too far back: it waits for a manager again, out of its account meanwhile.
  const lateNow = await lateForDate(orgId, late, input.paidOn, p.paidOn as Date, p.lateEntry as never);
  if (lateNow.pending) await assertDebitMovable(orgId, p.bankTransactionId);
  if (lateNow.next !== undefined) p.lateEntry = lateNow.next;
  p.method = input.method;
  p.amountMinor = input.amountMinor;
  p.paidOn = new Date(input.paidOn);
  p.reference = input.reference ?? "";
  p.accountName = input.accountName ?? "";
  const acc = await billPaymentAccount(orgId, input.method, input.bankAccountId, p.bankAccountId);
  const moves = String(p.bankAccountId ?? "") !== String(acc.id ?? "") || before.amountMinor !== input.amountMinor
    || new Date(before.paidOn as Date).getTime() !== new Date(input.paidOn).getTime();
  if (moves) await assertDebitMovable(orgId, p.bankTransactionId);
  p.bankAccountId = acc.id;
  if (acc.name) p.accountName = acc.name;
  p.notes = input.notes ?? "";
  p.chargesMinor = input.chargesMinor ?? 0;
  p.emi =
    input.method === "easebuzz_emi" && input.emi
      ? {
          bank: input.emi.bank ?? "",
          tenureMonths: input.emi.tenureMonths,
          monthlyAmountMinor: input.emi.monthlyAmountMinor ?? 0,
          interestPct: input.emi.interestPct ?? 0,
          processingFeeMinor: input.emi.processingFeeMinor ?? 0,
          transactionId: input.emi.transactionId ?? "",
        }
      : undefined;

  doc.amountPaidMinor = newPaid;
  doc.balanceMinor = ((doc.totalMinor as number) ?? 0) - newPaid;
  doc.status = doc.balanceMinor <= 0 ? "paid" : "partially_paid";
  await doc.save();
  if (lateNow.pending) await openLateEntry(orgId, lateNow.pending, paymentLateInfo(doc, p));
  else if (lateNow.withdraw) await withdrawLateFor(orgId, "bill_payment", doc._id, paymentId);
  await syncBillPaymentLine(orgId, doc._id, paymentId);
  return billDTO(orgId, doc._id);
}

/**
 * Remove a payment recorded on a bill by mistake (the user, 2026-10-16: "bill
 * also can't delete") — the wrong bill, a duplicate. Without it a bill with a
 * payment could never be deleted, since deleting asks for its payments to go
 * first. The bill's paid total, balance and status are worked out again from
 * what is left: back to approved when nothing is.
 */
export async function deleteBillPayment(orgId: string, id: string, paymentId: string): Promise<BillDTO> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Bill not found");
  if (doc.status === "voided") throw new AppError("CONFLICT", "Cannot delete a payment on a voided bill");
  const list = doc.payments as unknown as { id: (pid: string) => ({ deleteOne: () => void }) | null };
  const pm = list.id(paymentId);
  if (!pm) throw new AppError("NOT_FOUND", "Payment not found");
  const line = (pm as unknown as { bankTransactionId?: unknown }).bankTransactionId;
  await assertDebitMovable(orgId, line);
  pm.deleteOne();
  const paid = (doc.payments as unknown as { amountMinor?: number }[]).reduce((s, p) => s + (p.amountMinor ?? 0), 0);
  doc.amountPaidMinor = paid;
  doc.balanceMinor = ((doc.totalMinor as number) ?? 0) - paid;
  doc.status = paid === 0 ? "approved" : doc.balanceMinor <= 0 ? "paid" : "partially_paid";
  await doc.save();
  if (line) await syncDebitLine(orgId, line, null);
  await withdrawLateFor(orgId, "bill_payment", doc._id, paymentId);
  return toDTO(doc as unknown as BillDoc);
}

export async function voidBill(orgId: string, id: string): Promise<BillDTO> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Bill not found");
  if (["paid", "voided"].includes(doc.status as string))
    throw new AppError("CONFLICT", "Cannot void a paid or already voided bill");
  doc.status = "voided";
  await doc.save();
  await withdrawLateFor(orgId, "bill", doc._id);
  await withdrawLateFor(orgId, "bill_payment", doc._id);
  return toDTO(doc as unknown as BillDoc);
}

/**
 * Removing a bill outright, which voiding does not do.
 *
 * Voiding is the right answer for a bill that was real and then wasn't: it
 * stays in the book, marked, because the book is a record. Deleting is for the
 * ones that were never real in the first place — typed twice, entered against
 * the wrong vendor, left behind by a test — where a permanent voided row is
 * filing clutter rather than an audit trail.
 *
 * The test is what has happened to the bill, not what it is called. An invoice
 * can be a draft and that is the natural "not real yet" state to key on, but a
 * bill has no such state: `createBill` opens it at `approved`, or at
 * `pending_approval` when approval is on, and nothing ever writes `draft`. So
 * keying on status would have meant a bill entered by mistake could never be
 * removed, which is the case this exists for.
 *
 * What does matter is money and references. A bill with a payment against it
 * stays, whatever its status, because the payment is a real event and deleting
 * the bill would strand it — that alone rules out the paid and part-paid ones.
 * A bill a purchase order was converted into stays, because the PO is marked
 * billed and would be left pointing at nothing. A vendor credit raised against
 * a bill pins it likewise. Everything else can go.
 */
export async function deleteBill(orgId: string, id: string): Promise<void> {
  const doc = await Bill.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Bill not found");

  const payments = (doc.payments as unknown as unknown[]) ?? [];
  if (payments.length > 0) {
    throw new AppError(
      "CONFLICT",
      "This bill has payments recorded against it. Remove them first, or void it instead.",
    );
  }

  const objectId = new Types.ObjectId(id);
  const [{ PurchaseOrder }, { VendorCredit }] = await Promise.all([
    import("../purchase-order/purchase-order.model"),
    import("../vendor-credit/vendor-credit.model"),
  ]);
  const [fromPO, credited] = await Promise.all([
    PurchaseOrder.exists({ organizationId: orgId, sourceBillId: objectId }),
    VendorCredit.exists({ organizationId: orgId, sourceBillId: objectId }),
  ]);
  if (fromPO) {
    throw new AppError(
      "CONFLICT",
      "A purchase order was converted into this bill, so it cannot be deleted",
    );
  }
  if (credited) {
    throw new AppError("CONFLICT", "A vendor credit refers to this bill, so it cannot be deleted");
  }

  await doc.deleteOne();
  await withdrawLateFor(orgId, "bill", doc._id);
}
