import { Types } from "mongoose";
import { logger } from "../../lib/logger";
import { env } from "../../config/env";
import { sendNotice } from "../../lib/email";
import { User } from "../user/user.model";
import { Role } from "../role/role.model";
import { Organization } from "../organization/organization.model";
import { formatMinor } from "./money";

const oid = (id: string) => new Types.ObjectId(id);

/**
 * Telling the accounts department something about payroll happened.
 *
 * Each system notifies its own people, and only about events the other side
 * caused. Finance cannot email HR's staff — it has no addresses for them, and
 * the HRMS half does that from its side. What finance owns is the two things
 * its own people would otherwise have to keep a screen open to notice: a month
 * arriving from HR, and a payment that moved money without reaching HRMS.
 *
 * Every send is best-effort and never throws. A payroll must not fail because a
 * mail server did, and the caller has already done the thing being announced.
 */

/**
 * Who in this organization should hear about payroll.
 *
 * Derived from permissions rather than a list somebody maintains: the people
 * allowed to act on a payroll run are exactly the people who need telling, and
 * a separate list would drift the moment somebody changed roles.
 */
async function payrollRecipients(orgId: string, permission: string): Promise<string[]> {
  const roles = await Role.find({
    organizationId: oid(orgId),
    permissions: { $in: [permission, "*"] },
  })
    .select("_id")
    .lean();
  if (!roles.length) return [];

  const users = await User.find({
    status: "active",
    memberships: {
      $elemMatch: {
        organizationId: oid(orgId),
        roleId: { $in: roles.map((r) => r._id) },
        status: "active",
      },
    },
  })
    .select("email")
    .lean();

  return users.map((u) => u.email).filter(Boolean);
}

function runUrl(runId?: string): string | undefined {
  const base = env.WEB_ORIGIN.split(",")[0]?.trim();
  if (!base) return undefined;
  return runId ? `${base}/payroll/runs/${runId}` : `${base}/payroll/runs`;
}

/** A month HR has submitted and nobody here has imported yet. */
export async function notifyPayrollWaiting(
  orgId: string,
  batches: Array<{ period: string; hrmsOrgName: string; employeeCount: number; netTotal: number; currency: string }>,
): Promise<void> {
  try {
    if (!batches.length) return;
    const to = await payrollRecipients(orgId, "payroll:write");
    if (!to.length) return;

    const org = await Organization.findById(oid(orgId)).select("name").lean();
    const lines = batches.map(
      (b) =>
        `<strong>${b.period}</strong> from ${b.hrmsOrgName} — ${b.employeeCount} people, ` +
        `${b.currency} ${b.netTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })} net.`,
    );

    await sendNotice({
      to,
      subject:
        batches.length === 1
          ? `Payroll for ${batches[0]!.period} is waiting to be imported`
          : `${batches.length} payroll months are waiting to be imported`,
      title: "HR has handed over a payroll",
      lines: [
        `The following ${batches.length === 1 ? "month is" : "months are"} waiting in ${org?.name ?? "your organization"}:`,
        ...lines,
        "Importing it locks the month on HR's side and brings the figures in here.",
      ],
      actionLabel: "Open payroll",
      actionUrl: runUrl(),
    });
  } catch (err) {
    logger.error({ err }, "Could not send payroll-waiting notice");
  }
}

/**
 * The one that matters most: money left the bank and HRMS was never told.
 *
 * Invisible from either system on its own — finance shows a paid run, HR shows
 * issued payslips — so it is mailed rather than left to be noticed on a screen
 * by somebody who has no reason to look.
 */
export async function notifyPaymentNotSynced(
  orgId: string,
  opts: { runId: string; runNumber: string; paymentId: string; amountMinor: number; currency: string; error: string },
): Promise<void> {
  try {
    const to = await payrollRecipients(orgId, "payroll:write");
    if (!to.length) return;

    await sendNotice({
      to,
      subject: `Action needed: ${opts.runNumber} was paid but HRMS was not told`,
      title: "A payroll payment did not reach HRMS",
      lines: [
        `<strong>${formatMinor(opts.amountMinor, opts.currency)}</strong> was transferred and recorded against ` +
          `${opts.runNumber}, but HRMS could not be updated.`,
        `The reason given was: ${opts.error}`,
        "Employees will still see their payslips as issued until this succeeds. " +
          "Retrying is safe — nothing will be paid twice.",
      ],
      actionLabel: "Retry from the payroll run",
      actionUrl: runUrl(opts.runId),
    });
  } catch (err) {
    logger.error({ err }, "Could not send payment-not-synced notice");
  }
}
