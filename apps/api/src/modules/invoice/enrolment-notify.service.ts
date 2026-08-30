import { Types } from "mongoose";
import { env } from "../../config/env";
import { sendNotice } from "../../lib/email";
import { logger } from "../../lib/logger";
import { User } from "../user/user.model";
import type { InvoiceDoc } from "./invoice.model";

/**
 * Telling people an enrolment moved.
 *
 * Without it an enrolment goes quiet the moment it is submitted: the
 * counsellor has no reason to open the application again, so an approval sits
 * unnoticed and a correction is never made. They are the one person who cannot
 * see the queue it went into.
 *
 * Nothing here may fail the decision it reports. An approval that went through
 * but could not be emailed is still an approval, and throwing would turn a
 * mail outage into a refusal to approve anything.
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

/** Let the counsellor know their enrolment was approved, or sent back and why. */
export async function notifyEnrolmentDecided(
  doc: InvoiceDoc,
  approverName: string,
  outcome: "approved" | "returned",
  reason?: string,
): Promise<void> {
  try {
    const to = await emailFor(doc.salespersonId);
    if (!to) return;

    const approved = outcome === "approved";
    const course = doc.enrolment?.course ?? "";
    await sendNotice({
      to: [to.email],
      subject: approved
        ? `Enrolment ${doc.invoiceNumber} approved`
        : `Enrolment ${doc.invoiceNumber} sent back`,
      title: approved ? "Your enrolment was approved" : "Your enrolment was sent back",
      lines: approved
        ? [
            `${doc.customerName}${course ? ` — ${course}` : ""}, ${money(doc.totalMinor ?? 0, doc.currency ?? "AED")}`,
            `Approved by ${approverName}. Accounts will send the invoice and record the payment.`,
          ]
        : [
            `${doc.customerName}${course ? ` — ${course}` : ""}, ${money(doc.totalMinor ?? 0, doc.currency ?? "AED")}`,
            // The reason is the point of the message; "sent back" on its own
            // means having to go and ask what was wrong with it.
            `${approverName} sent it back: ${reason ?? "no reason given"}`,
            "Correct it and submit it again.",
          ],
      actionLabel: approved ? "View the enrolment" : "Open and correct it",
      actionUrl: `${env.WEB_ORIGIN}/invoices/${doc._id}`,
    });
  } catch (err) {
    logger.error({ err, invoiceId: String(doc._id) }, "Could not send enrolment decision notice");
  }
}

/**
 * Tell whoever can approve that one is waiting.
 *
 * Found by asking which roles carry `invoice:write` and who holds them, rather
 * than by naming roles — a custom role granting it is included without anybody
 * having to remember to.
 */
export async function notifyApproversOfEnrolment(doc: InvoiceDoc): Promise<void> {
  try {
    const { Role } = await import("../role/role.model");
    const orgId = doc.organizationId as unknown as Types.ObjectId;

    const roles = await Role.find({
      organizationId: orgId,
      $or: [{ permissions: "invoice:write" }, { permissions: "*" }],
    }).select("_id");
    if (roles.length === 0) return;

    const approvers = await User.find({
      status: "active",
      memberships: { $elemMatch: { organizationId: orgId, roleId: { $in: roles.map((r) => r._id) } } },
    }).select("email");

    // Not the person who raised it: they know.
    const to = approvers
      .filter((u) => String(u._id) !== String(doc.salespersonId))
      .map((u) => u.email as string)
      .filter(Boolean);

    if (to.length === 0) {
      // A line in the log, because an enrolment nobody can approve otherwise
      // sits pending forever with nothing to say why.
      logger.warn(
        { organizationId: String(orgId), invoiceId: String(doc._id) },
        "Enrolment submitted but the organization has nobody who can approve it",
      );
      return;
    }

    const course = doc.enrolment?.course ?? "";
    await sendNotice({
      to,
      subject: `Enrolment ${doc.invoiceNumber} needs approval`,
      title: "An enrolment is waiting for you",
      lines: [
        `${doc.salespersonName} enrolled ${doc.customerName}${course ? ` on ${course}` : ""}`,
        money(doc.totalMinor ?? 0, doc.currency ?? "AED"),
      ],
      actionLabel: "Review it",
      actionUrl: `${env.WEB_ORIGIN}/invoices/${doc._id}`,
    });
  } catch (err) {
    logger.error({ err, invoiceId: String(doc._id) }, "Could not notify enrolment approvers");
  }
}
