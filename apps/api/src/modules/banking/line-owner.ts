import { Types } from "mongoose";

/**
 * Which record a bank line belongs to — the one that made it and keeps it in step: an expense paid from the account,
 * a bill payment, an invoice payment (or its bank charges), a payroll payment (or its reversal). Null for a line
 * somebody typed or imported, even when it was matched to a record by hand.
 *
 * Unmatching such a line used to clear its link and let it be deleted while its record still pointed at it — the next
 * sync made it again (2026-11-11). It is changed from its record instead.
 */
export async function lineOwner(orgId: string, txId: unknown): Promise<string | null> {
  const id = new Types.ObjectId(String(txId));
  const org = new Types.ObjectId(orgId);
  const [{ Expense }, { Bill }, { Invoice }, { PayrollRun }] = await Promise.all([
    import("../expense/expense.model"), import("../bill/bill.model"), import("../invoice/invoice.model"), import("../payroll/payroll-run.model"),
  ]);
  const e = await Expense.findOne({ organizationId: org, bankTransactionId: id }).select("expenseNumber").lean<any>();
  if (e) return `expense ${e.expenseNumber ?? ""}`.trim();
  const b = await Bill.findOne({ organizationId: org, "payments.bankTransactionId": id }).select("billNumber").lean<any>();
  if (b) return `a payment on bill ${b.billNumber ?? ""}`.trim();
  const i = await Invoice.findOne({ organizationId: org, $or: [{ "payments.bankTransactionId": id }, { "payments.bankChargesTransactionId": id }] })
    .select("invoiceNumber").lean<any>();
  if (i) return `a payment on invoice ${i.invoiceNumber ?? ""}`.trim();
  const p = await PayrollRun.findOne({ organizationId: org, $or: [{ "payments.bankTransactionId": id }, { "payments.reversalTransactionId": id }] })
    .select("runNumber").lean<any>();
  if (p) return `payroll ${p.runNumber ?? ""}`.trim();
  return null;
}
