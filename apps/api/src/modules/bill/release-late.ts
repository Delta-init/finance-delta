import { Types } from "mongoose";
import { Bill } from "./bill.model";
import { resyncBillPaymentLine } from "./bill.service";
import { syncBillExpense } from "./bill-expense";
import { LateEntryModel } from "../late-entry/late-entry.model";

/**
 * Bills and bill payments no longer ask a manager about an old date (the user, 2026-11-11: "removal approval things
 * in Late Bills ( date of bill in past )"). What was asked before that and is still waiting is let go here: the bill's
 * or payment's own late entry is cleared, the request is withdrawn (it leaves the managers' Waiting list for good),
 * and each released payment is put in its account. Nothing approved or rejected is touched.
 *
 * `write: false` only lists what would be released. Used by scripts/release-late-bills.ts.
 */
export interface ReleasedLate { orgId: string; billId: string; billNumber: string; vendorName: string; what: "bill" | "payment"; paymentId?: string; amountMinor: number; currency: string }

export async function releaseWaitingBills(write: boolean): Promise<ReleasedLate[]> {
  const bills = await Bill.find({ $or: [{ "lateEntry.state": "pending" }, { "payments.lateEntry.state": "pending" }] })
    .select("organizationId billNumber vendorName totalMinor currency lateEntry payments._id payments.amountMinor payments.lateEntry")
    .lean<any[]>();
  const out: ReleasedLate[] = [];
  for (const b of bills) {
    const base = { orgId: String(b.organizationId), billId: String(b._id), billNumber: String(b.billNumber ?? ""), vendorName: String(b.vendorName ?? ""), currency: String(b.currency ?? "AED") };
    if (b.lateEntry?.state === "pending") out.push({ ...base, what: "bill", amountMinor: Number(b.totalMinor ?? 0) });
    for (const p of b.payments ?? []) {
      if (p.lateEntry?.state === "pending") out.push({ ...base, what: "payment", paymentId: String(p._id), amountMinor: Number(p.amountMinor ?? 0) });
    }
  }
  if (!write) return out;

  const now = new Date();
  for (const b of bills) {
    await Bill.updateOne({ _id: b._id, "lateEntry.state": "pending" }, { $set: { lateEntry: null } });
    await Bill.updateOne({ _id: b._id }, { $set: { "payments.$[p].lateEntry": null } }, { arrayFilters: [{ "p.lateEntry.state": "pending" }] });
  }
  await LateEntryModel.updateMany(
    { kind: { $in: ["bill", "bill_payment"] }, state: "pending" },
    { $set: { state: "withdrawn", decidedAt: now, decisionNote: "Bills no longer need a manager's approval for an old date (2026-11-11)" } },
  );
  for (const r of out) {
    if (r.what === "payment" && r.paymentId) await resyncBillPaymentLine(r.orgId, r.billId, r.paymentId);
  }
  for (const id of new Set(out.map((r) => `${r.orgId}|${r.billId}`))) {
    const [orgId, billId] = id.split("|") as [string, string];
    await syncBillExpense(orgId, new Types.ObjectId(billId));
  }
  return out;
}
