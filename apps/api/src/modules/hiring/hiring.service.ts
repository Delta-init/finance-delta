import { Types } from "mongoose";
import type { ApproveHiringInput, RejectHiringInput } from "@delta/shared";
import { PayrollOrgLink } from "../payroll-mapping/org-link.model";
import { hrmsClient, type HrmsHiringRequest } from "../../lib/hrms-client";
import { User } from "../user/user.model";
import { AppError } from "../../lib/http";
import { HiringDecision } from "./hiring-decision.model";

/**
 * Hiring requests HR approved in HRMS that need finance's budget approval
 * (2026-10-15) — new headcount, or a replacement paid more than the person
 * leaving. Read live from HRMS, as salary advances and purchase requests are;
 * the decision is kept here (HiringDecision) before HRMS is told, so a lost
 * answer can be resent and Approvals can show it afterwards.
 */

export interface HiringRow extends HrmsHiringRequest {
  hrmsOrgId: string;
  hrmsOrgName: string;
  /** Decided here already, but HRMS never took the answer — deciding the same way resends it. */
  undelivered: { decision: "approved" | "rejected"; decidedByName: string; decidedAt: string } | null;
}

async function links(orgId: string) {
  return PayrollOrgLink.find({ organizationId: new Types.ObjectId(orgId), isActive: true }).select("hrmsOrgId hrmsOrgName").lean();
}

/*
 * Asked by every open sidebar each minute (Approvals' count), so HRMS's answer
 * is kept two minutes per HRMS organisation — failures included — and a
 * decision forgets it, as purchase requests do.
 */
const TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<HrmsHiringRequest[]> }>();
export function forgetHiringRequests(hrmsOrgId: string): void {
  cache.delete(hrmsOrgId);
}
export function hiringRequestsOf(hrmsOrgId: string): Promise<HrmsHiringRequest[]> {
  const hit = cache.get(hrmsOrgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = hrmsClient.hiringRequests(hrmsOrgId);
  cache.set(hrmsOrgId, { at: Date.now(), value });
  return value;
}

/** Everything waiting on finance, across every linked HRMS organisation, oldest HR approval first. */
export async function listWaiting(orgId: string): Promise<HiringRow[]> {
  if (!hrmsClient.isConfigured()) throw new AppError("CONFLICT", "The HRMS integration is not configured.");
  const rows: HiringRow[] = [];
  for (const link of await links(orgId)) {
    const hrmsOrgId = String(link.hrmsOrgId);
    const waiting = await hrmsClient.hiringRequests(hrmsOrgId);
    const decided = waiting.length
      ? await HiringDecision.find({ hrmsOrgId, requisitionId: { $in: waiting.map((r) => r._id) } }).lean()
      : [];
    const byId = new Map(decided.map((d) => [d.requisitionId, d]));
    for (const r of waiting) {
      const d = byId.get(r._id);
      rows.push({
        ...r,
        hrmsOrgId,
        hrmsOrgName: String(link.hrmsOrgName ?? ""),
        undelivered: d ? { decision: d.decision as "approved" | "rejected", decidedByName: d.decidedByName ?? "", decidedAt: d.decidedAt.toISOString() } : null,
      });
    }
  }
  return rows.sort((a, b) => String(a.hrApprovedAt ?? a.createdAt).localeCompare(String(b.hrApprovedAt ?? b.createdAt)));
}

async function requireRow(orgId: string, hrmsOrgId: string, id: string) {
  const link = (await links(orgId)).find((l) => String(l.hrmsOrgId) === hrmsOrgId);
  if (!link) throw new AppError("FORBIDDEN", "That organisation is not linked to this one.");
  const row = (await hrmsClient.hiringRequests(hrmsOrgId)).find((r) => r._id === id);
  return { link, row };
}

async function decide(orgId: string, userId: string, id: string, decision: "approved" | "rejected", input: ApproveHiringInput | RejectHiringInput) {
  const { link, row } = await requireRow(orgId, input.hrmsOrgId, id);
  let record = await HiringDecision.findOne({ hrmsOrgId: input.hrmsOrgId, requisitionId: id });
  if (record && record.decision !== decision) {
    throw new AppError("CONFLICT", `This request was already ${record.decision} here by ${record.decidedByName || "someone"} — it can't be ${decision} now.`);
  }
  if (record?.deliveredAt) return { decision, alreadyDone: true };
  if (!row) {
    throw new AppError("NOT_FOUND", "This hiring request is no longer waiting on finance in HRMS — it may have been decided or withdrawn.");
  }
  if (!record) {
    const me = await User.findById(userId).select("name").lean();
    record = await HiringDecision.create({
      organizationId: new Types.ObjectId(orgId),
      hrmsOrgId: input.hrmsOrgId,
      hrmsOrgName: String(link.hrmsOrgName ?? ""),
      requisitionId: id,
      decision,
      note: input.note ?? "",
      decidedById: new Types.ObjectId(userId),
      decidedByName: me?.name ?? "",
      decidedAt: new Date(),
      request: {
        title: row.title, type: row.type, headcount: row.headcount,
        salaryMin: row.salaryMin ?? undefined, salaryMax: row.salaryMax ?? undefined, currency: row.currency,
        department: row.department?.name ?? "", raisedBy: row.raisedBy?.name ?? "",
        hrApprovedAt: row.hrApprovedAt ? new Date(row.hrApprovedAt) : undefined,
      },
    });
  }
  try {
    const opts = { note: record.note || undefined, by: record.decidedByName || undefined };
    if (decision === "approved") await hrmsClient.approveHiring(input.hrmsOrgId, id, opts);
    else await hrmsClient.rejectHiring(input.hrmsOrgId, id, { ...opts, note: record.note });
  } catch (err) {
    throw new AppError(
      "UNAVAILABLE",
      `Recorded here, but HRMS could not be told (${(err as Error).message}). ${decision === "approved" ? "Approve" : "Reject"} it again to resend.`,
    );
  }
  await HiringDecision.updateOne({ _id: record._id }, { $set: { deliveredAt: new Date() } });
  forgetHiringRequests(input.hrmsOrgId);
  return { decision, alreadyDone: false };
}

export const approve = (orgId: string, userId: string, id: string, input: ApproveHiringInput) => decide(orgId, userId, id, "approved", input);
export const reject = (orgId: string, userId: string, id: string, input: RejectHiringInput) => decide(orgId, userId, id, "rejected", input);
