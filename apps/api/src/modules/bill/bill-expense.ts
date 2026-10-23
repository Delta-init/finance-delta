import { Types } from "mongoose";
import { logger } from "../../lib/logger";
import { Bill } from "./bill.model";
import { Expense } from "../expense/expense.model";
import { nextNumber } from "../sequence/sequence.service";
import { resolveExpenseCategory } from "../expense-category/expense-category.service";

/*
 * A bill's own expense (the user, 2026-10-23: "when a bill is created it will also create an expense, with category
 * and subcategory, and expenses can see the bills"). One per bill, made when the bill is and kept in step with it —
 * its date, vendor, amount, VAT, category, and where it stands: waiting for approval with the bill, approved, rejected
 * or voided with it, paid once the bill is paid in full. It is the bill's, never edited on its own.
 *
 * It is not money of its own. The bill's payments already put their lines in Banking, so this one never has a bank
 * account or a line; and the reports that count bills (P&L "Supplier bills", cash flow, the Daily Report, the
 * dashboard, VAT, payments made) leave it out — BILL_EXPENSE below — so a bill is counted once. The Expenses list and
 * Expense by category show it, filed under its category.
 */

/** What the reports that count bills themselves leave out of their expenses. */
export const NOT_A_BILL_EXPENSE = { "source.kind": { $ne: "bill" } } as const;

/** Until someone gives it one: the bill's expense of a bill from before categories, or one made from a purchase order. */
const UNFILED = { category: "other_unclassified", subcategory: "pending_classification" };

const keyOf = (billId: unknown) => `bill:${String(billId)}`;

/** The expense's standing, from the bill's. */
function statusOf(bill: { status?: string | null; approvalStatus?: string | null }): "draft" | "submitted" | "approved" | "rejected" | "voided" {
  if (bill.status === "voided") return "voided";
  if (bill.approvalStatus === "rejected") return "rejected";
  if (bill.status === "pending_approval") return "submitted";
  if (bill.status === "draft") return "draft";
  return "approved";
}

/** Paid in full: on the day of its last payment (a credit applied with no payment: the bill's date). */
function paidOnOf(bill: any): Date | null {
  if (bill.status !== "paid") return null;
  const days = ((bill.payments ?? []) as { paidOn?: Date }[]).map((p) => (p.paidOn ? new Date(p.paidOn).getTime() : 0)).filter(Boolean);
  return days.length ? new Date(Math.max(...days)) : new Date(bill.billDate);
}

/**
 * Makes or brings the bill's expense into line with it; gone with the bill. Never throws — the bill is saved whatever
 * becomes of its expense, and the next change to the bill tries again.
 */
export async function syncBillExpense(orgId: string, billId: unknown): Promise<void> {
  try {
    const org = new Types.ObjectId(orgId);
    const bill = await Bill.findOne({ _id: billId, organizationId: org }).lean<any>();
    const key = keyOf(billId);
    if (!bill) {
      await Expense.deleteOne({ organizationId: org, "source.key": key });
      return;
    }
    const cat = await resolveExpenseCategory(orgId, bill.category || UNFILED.category, bill.category ? bill.subcategory : UNFILED.subcategory)
      .catch(() => resolveExpenseCategory(orgId, UNFILED.category, UNFILED.subcategory));
    const totalMinor = Number(bill.totalMinor) || 0;
    const taxMinor = Number(bill.taxTotalMinor) || 0;
    const fields = {
      category: cat.category,
      categoryName: cat.categoryName,
      subcategory: cat.subcategory,
      subcategoryName: cat.subcategoryName,
      description: `${bill.vendorName ?? "Vendor"} — ${bill.billNumber}`.slice(0, 300),
      expenseDate: new Date(bill.billDate),
      amountMinor: totalMinor - taxMinor,
      taxMinor,
      taxPct: 0,
      taxInclusive: false,
      totalMinor,
      currency: bill.currency ?? "AED",
      status: statusOf(bill),
      paidOn: paidOnOf(bill),
      dueDate: bill.dueDate ? new Date(bill.dueDate) : undefined,
      reference: String(bill.billNumber),
      // Never in Banking on its own: the bill's payments are.
      bankAccountId: null,
      bankTransactionId: null,
      paymentAccount: "",
      notes: `From bill ${bill.billNumber}${bill.vendorName ? ` (${bill.vendorName})` : ""} — it follows the bill; change it there.`,
      source: { kind: "bill", key, billId: bill._id, billNumber: bill.billNumber },
    };
    let exp = await Expense.findOne({ organizationId: org, "source.key": key });
    if (exp) {
      exp.set(fields);
      if (exp.isModified()) await exp.save();
    } else {
      exp = await Expense.create({
        organizationId: org,
        expenseNumber: await nextNumber(orgId, "expense", "EXP-"),
        ...fields,
        ...(bill.createdById ? { submittedById: bill.createdById } : {}),
        submittedByName: bill.createdByName || "From a bill",
      }).catch(async (err) => {
        // Two changes to one bill at once: the other made it.
        if ((err as { code?: number }).code === 11000) return Expense.findOne({ organizationId: org, "source.key": key });
        throw err;
      });
    }
    if (exp && (String(bill.expenseId ?? "") !== String(exp._id) || bill.expenseNumber !== exp.expenseNumber)) {
      await Bill.updateOne({ _id: bill._id }, { $set: { expenseId: exp._id, expenseNumber: exp.expenseNumber } });
    }
  } catch (err) {
    logger.warn({ billId: String(billId), err: (err as Error).message }, "A bill's expense could not be kept in step");
  }
}

/** The bill an expense is, when it is one — for the guards in expense.service. */
export function billOfExpense(doc: unknown): { billId: string; billNumber: string } | null {
  const s = (doc as { source?: { kind?: string; billId?: unknown; billNumber?: string } } | null)?.source;
  return s?.kind === "bill" ? { billId: String(s.billId ?? ""), billNumber: String(s.billNumber ?? "") } : null;
}
