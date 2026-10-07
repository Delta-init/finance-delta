import { env } from "../../config/env";
import { sendNotice } from "../../lib/email";
import { logger } from "../../lib/logger";
import { withAccountants } from "../../lib/approval-recipients";

/**
 * A bill held for approval, told to the accountants.
 *
 * Until now a bill entered with approval switched on waited in "pending
 * approval" with nobody told; it surfaced only when somebody opened Bills.
 * The accountants hear about every approval request, and this is one.
 *
 * Never fails the bill it reports: a mail outage is not a reason to lose the
 * bill somebody just entered.
 */
export async function notifyBillWaiting(
  orgId: string,
  bill: { id: string; billNumber: string; vendorName: string; totalMinor: number; currency: string; dueDate?: string | Date | null },
): Promise<void> {
  try {
    const to = await withAccountants(orgId, []);
    if (!to.length) return;
    const amount = `${bill.currency} ${(bill.totalMinor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    await sendNotice({
      log: { organizationId: orgId, kind: "bill_notice", ref: { type: "bill", id: bill.id, label: bill.billNumber } },
      to,
      subject: `Bill ${bill.billNumber} needs approval`,
      title: "A bill is waiting for approval",
      lines: [
        `${bill.vendorName} — ${amount}`,
        ...(bill.dueDate ? [`Due ${new Date(bill.dueDate).toISOString().slice(0, 10)}`] : []),
      ],
      actionLabel: "Review it",
      actionUrl: `${env.WEB_ORIGIN}/bills/${bill.id}`,
    });
  } catch (err) {
    logger.error({ err, billId: bill.id }, "Could not send bill-waiting notice");
  }
}
