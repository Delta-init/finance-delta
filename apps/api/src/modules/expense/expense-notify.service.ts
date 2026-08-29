import { Types } from "mongoose";
import { env } from "../../config/env";
import { sendNotice } from "../../lib/email";
import { logger } from "../../lib/logger";
import { User } from "../user/user.model";
import type { ExpenseDoc } from "./expense.model";

/**
 * Telling somebody what happened to the claim they sent.
 *
 * Without this a claim goes quiet: the claimant has no reason to open the
 * application again, so an approval sits unnoticed and a rejection is never
 * acted on. They are the one person who cannot see the queue it went into.
 *
 * Nothing here is allowed to fail the decision it is reporting. An approval
 * that went through but could not be emailed is an approval; throwing would
 * turn a mail outage into a refusal to approve anything.
 */

function money(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

async function emailFor(userId: unknown): Promise<{ email: string; name: string } | null> {
  try {
    const user = await User.findById(new Types.ObjectId(String(userId))).select("email name status");
    if (!user?.email || user.status !== "active") return null;
    return { email: user.email, name: user.name };
  } catch {
    return null;
  }
}

/** Let the claimant know their claim was approved. */
export async function notifyExpenseApproved(doc: ExpenseDoc, approverName: string): Promise<void> {
  try {
    const to = await emailFor(doc.submittedById);
    if (!to) return;
    await sendNotice({
      to: [to.email],
      subject: `Expense ${doc.expenseNumber} approved`,
      title: "Your claim was approved",
      lines: [
        `${doc.description} — ${money(doc.totalMinor as number, doc.currency as string)}`,
        `Approved by ${approverName}.`,
      ],
      actionLabel: "View the claim",
      actionUrl: `${env.WEB_ORIGIN}/expenses/${doc._id}`,
    });
  } catch (err) {
    logger.error({ err, expenseId: String(doc._id) }, "Could not send approval notice");
  }
}

/**
 * Let the claimant know it came back, and why.
 *
 * The reason is the point of the message. "Rejected" on its own means they
 * have to ask somebody what was wrong with it.
 */
export async function notifyExpenseRejected(
  doc: ExpenseDoc,
  approverName: string,
  reason: string,
): Promise<void> {
  try {
    const to = await emailFor(doc.submittedById);
    if (!to) return;
    await sendNotice({
      to: [to.email],
      subject: `Expense ${doc.expenseNumber} sent back`,
      title: "Your claim was sent back",
      lines: [
        `${doc.description} — ${money(doc.totalMinor as number, doc.currency as string)}`,
        `${approverName} sent it back: ${reason}`,
        "You can correct it and submit it again.",
      ],
      actionLabel: "Open the claim",
      actionUrl: `${env.WEB_ORIGIN}/expenses/${doc._id}`,
    });
  } catch (err) {
    logger.error({ err, expenseId: String(doc._id) }, "Could not send rejection notice");
  }
}

/**
 * Tell the approvers that something is waiting.
 *
 * Sent when a claim is submitted, because nothing else would: an approver has
 * no reason to look at a queue they do not know has anything in it.
 *
 * Finding them means asking which roles carry the permission and who holds
 * those roles — the permission is the definition of an approver, so a custom
 * role granting it is included without anybody having to remember to.
 */
export async function notifyApproversOfSubmission(doc: ExpenseDoc): Promise<void> {
  try {
    const { Role } = await import("../role/role.model");
    const orgId = doc.organizationId as unknown as Types.ObjectId;

    const roles = await Role.find({
      organizationId: orgId,
      $or: [{ permissions: "expense:approve" }, { permissions: "*" }],
    }).select("_id");
    if (roles.length === 0) return;

    const approvers = await User.find({
      status: "active",
      memberships: {
        $elemMatch: { organizationId: orgId, roleId: { $in: roles.map((r) => r._id) } },
      },
    }).select("email");

    // Not the person who submitted it: they know.
    const recipients = approvers
      .filter((u) => String(u._id) !== String(doc.submittedById))
      .map((u) => u.email as string)
      .filter(Boolean);

    if (recipients.length === 0) {
      // Worth a line in the log. A claim nobody can approve will otherwise sit
      // in "submitted" indefinitely with no indication why.
      logger.warn(
        { organizationId: String(orgId), expenseId: String(doc._id) },
        "Expense submitted but the organization has nobody who can approve it",
      );
      return;
    }

    await sendNotice({
      to: recipients,
      subject: `Expense ${doc.expenseNumber} needs approval`,
      title: "A claim is waiting for you",
      lines: [
        `${doc.submittedByName} submitted ${doc.description}`,
        money(doc.totalMinor as number, doc.currency as string),
      ],
      actionLabel: "Review it",
      actionUrl: `${env.WEB_ORIGIN}/expenses/${doc._id}`,
    });
  } catch (err) {
    logger.error({ err, expenseId: String(doc._id) }, "Could not notify approvers");
  }
}
