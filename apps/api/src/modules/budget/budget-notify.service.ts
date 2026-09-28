import { Types } from "mongoose";
import type { FundingRequest } from "@delta/shared";
import { env } from "../../config/env";
import { sendNotice } from "../../lib/email";
import { logger } from "../../lib/logger";
import { Role } from "../role/role.model";
import { User } from "../user/user.model";
import { withAccountants } from "../../lib/approval-recipients";

/**
 * Telling people a fund request is waiting.
 *
 * A request raised inside finance is seen by whoever opens Budgets. One handed
 * over by Media ERP comes from somebody with no login here and no way to chase
 * it, so without a notice it waits until someone happens to look. And the
 * accountants are told of every request, wherever it came from.
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
 * Tell people a fund request is waiting.
 *
 * One from another system (Media ERP) goes to everyone who can approve it —
 * found by the permission rather than by role names, so a custom role granting
 * `budget:approve` is included without anybody having to remember to. Every
 * request, from anywhere, also goes to the accountants; for a top-up raised
 * here they are the only ones told, as nobody was before.
 */
export async function notifyFundRequestWaiting(
  organizationId: string,
  request: FundingRequest,
  opts: { includeApprovers: boolean; requesterId?: string },
): Promise<void> {
  try {
    const orgId = new Types.ObjectId(organizationId);
    const roles = opts.includeApprovers
      ? await Role.find({
          organizationId: orgId,
          $or: [{ permissions: "budget:approve" }, { permissions: "*" }],
        }).select("_id")
      : [];

    const approvers = roles.length
      ? await User.find({
          status: "active",
          memberships: {
            $elemMatch: { organizationId: orgId, roleId: { $in: roles.map((r) => r._id) }, status: { $nin: ["suspended", "invited"] } },
          },
        }).select("email")
      : [];
    const excluded = opts.requesterId ? [opts.requesterId] : [];
    const to = await withAccountants(
      orgId,
      approvers.filter((u) => !excluded.includes(String(u._id))).map((u) => u.email as string).filter(Boolean),
      excluded,
    );

    if (to.length === 0) {
      // A line in the log, because a request nobody can approve otherwise sits
      // pending forever with nothing to say why. A top-up in an organization
      // with no accountants is not that: its approvers were never mailed.
      if (!opts.includeApprovers) return;
      logger.warn(
        { organizationId, fundingRequestId: request.id },
        "Fund request received but the organization has nobody who can approve it",
      );
      return;
    }

    const from = SOURCE_LABELS[request.source] ?? (request.source === "finance" ? "" : request.source);
    const drawdown = request.kind === "drawdown";
    await sendNotice({
      to,
      subject: `Fund request: ${request.title}`,
      title: "A fund request is waiting for approval",
      lines: [
        drawdown
          ? `${request.requestedByName}${from ? ` (${from})` : ""} asked for ${money(request.amountMinor, request.currency)} from ${request.departmentName}'s ${monthName(request.period)} budget.`
          : `${request.requestedByName} asked for ${money(request.amountMinor, request.currency)} more for ${request.departmentName}'s ${monthName(request.period)} budget.`,
        ...(request.platform ? [`Platform: ${request.platform}`] : []),
        request.purpose.length > 300 ? `${request.purpose.slice(0, 297)}…` : request.purpose,
        drawdown
          ? "Approving it takes the amount off what the department has left for that month."
          : "Approving it adds the amount to the department's month.",
      ],
      actionLabel: "Review it",
      actionUrl: `${env.WEB_ORIGIN}/approvals`,
    });
  } catch (err) {
    logger.error({ err, fundingRequestId: request.id }, "Could not notify fund request approvers");
  }
}
