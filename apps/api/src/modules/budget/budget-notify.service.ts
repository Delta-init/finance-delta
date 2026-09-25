import { Types } from "mongoose";
import type { FundingRequest } from "@delta/shared";
import { env } from "../../config/env";
import { sendNotice } from "../../lib/email";
import { logger } from "../../lib/logger";
import { Role } from "../role/role.model";
import { User } from "../user/user.model";

/**
 * Telling finance a fund request arrived from another system.
 *
 * A request raised inside finance is seen by whoever opens Budgets. One handed
 * over by Media ERP comes from somebody with no login here and no way to chase
 * it, so without a notice it waits until someone happens to look.
 *
 * Nothing here may fail the request it reports: a mail outage must not turn
 * into Media ERP being told its request was refused.
 */

function money(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthName(period: string): string {
  return new Date(`${period}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

const SOURCE_LABELS: Record<string, string> = { "media-erp": "Media ERP" };

/**
 * Everyone who can approve it, found by the permission rather than by role
 * names — a custom role granting `budget:approve` is included without anybody
 * having to remember to.
 */
export async function notifyFundingApprovers(organizationId: string, request: FundingRequest): Promise<void> {
  try {
    const orgId = new Types.ObjectId(organizationId);
    const roles = await Role.find({
      organizationId: orgId,
      $or: [{ permissions: "budget:approve" }, { permissions: "*" }],
    }).select("_id");

    const approvers = roles.length
      ? await User.find({
          status: "active",
          memberships: {
            $elemMatch: { organizationId: orgId, roleId: { $in: roles.map((r) => r._id) }, status: { $nin: ["suspended", "invited"] } },
          },
        }).select("email")
      : [];
    const to = approvers.map((u) => u.email as string).filter(Boolean);

    if (to.length === 0) {
      // A line in the log, because a request nobody can approve otherwise sits
      // pending forever with nothing to say why.
      logger.warn(
        { organizationId, fundingRequestId: request.id },
        "Fund request received but the organization has nobody who can approve it",
      );
      return;
    }

    const from = SOURCE_LABELS[request.source] ?? request.source;
    await sendNotice({
      to,
      subject: `Fund request: ${request.title}`,
      title: "A fund request is waiting for you",
      lines: [
        `${request.requestedByName} (${from}) asked for ${money(request.amountMinor, request.currency)} from ${request.departmentName}'s ${monthName(request.period)} budget.`,
        ...(request.platform ? [`Platform: ${request.platform}`] : []),
        request.purpose.length > 300 ? `${request.purpose.slice(0, 297)}…` : request.purpose,
        "Approving it takes the amount off what the department has left for that month.",
      ],
      actionLabel: "Review it",
      actionUrl: `${env.WEB_ORIGIN}/budgets`,
    });
  } catch (err) {
    logger.error({ err, fundingRequestId: request.id }, "Could not notify fund request approvers");
  }
}
