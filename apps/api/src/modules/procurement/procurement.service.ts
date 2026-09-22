import { Types } from "mongoose";
import { PayrollOrgLink } from "../payroll-mapping/org-link.model";
import { hrmsClient, type HrmsProcurementRequest } from "../../lib/hrms-client";
import { createPO } from "../purchase-order/purchase-order.service";
import { AppError } from "../../lib/http";

/**
 * Purchase requests HR has approved, and the money decision on them.
 *
 * Nothing is mirrored here. The request belongs to HRMS and is read live, the
 * same way payroll batches are — a local copy would be one more thing to keep
 * in step, and the only question finance actually answers is yes or no. What
 * does get written on this side is the purchase order an approval produces,
 * which is finance's own record and always was.
 */

/** The HRMS organisations this finance org is linked to. */
async function linkedOrgIds(orgId: string): Promise<string[]> {
  const links = await PayrollOrgLink.find({ organizationId: new Types.ObjectId(orgId) }).select("hrmsOrgId").lean();
  return links.map((l) => String(l.hrmsOrgId));
}

export interface ProcurementRow extends HrmsProcurementRequest {
  /** Which HRMS organisation it came from — needed to send the answer back. */
  hrmsOrgId: string;
}

/** Everything waiting on finance, across every linked HRMS organisation. */
export async function listWaiting(orgId: string): Promise<ProcurementRow[]> {
  if (!hrmsClient.isConfigured()) throw new AppError("CONFLICT", "The HRMS integration is not configured.");
  const out: ProcurementRow[] = [];
  for (const hrmsOrgId of await linkedOrgIds(orgId)) {
    const rows = await hrmsClient.procurementRequests(hrmsOrgId);
    out.push(...rows.map((r) => ({ ...r, hrmsOrgId })));
  }
  // Soonest needed first; a request with no date sorts last rather than first.
  return out.sort((a, b) => (a.neededBy ?? "9999").localeCompare(b.neededBy ?? "9999"));
}

async function requireRow(orgId: string, hrmsOrgId: string, requestId: string): Promise<HrmsProcurementRequest> {
  if (!(await linkedOrgIds(orgId)).includes(hrmsOrgId)) {
    throw new AppError("FORBIDDEN", "That organisation is not linked to this one.");
  }
  const row = (await hrmsClient.procurementRequests(hrmsOrgId)).find((r) => r._id === requestId);
  if (!row) throw new AppError("NOT_FOUND", "That request is no longer waiting for a decision.");
  return row;
}

/**
 * Approve one, raising the purchase order it becomes.
 *
 * The order is created first. If HRMS cannot be reached afterwards the order
 * exists and the request stays waiting, which somebody can see and settle; the
 * other way round leaves HR told it was approved with nothing ordered, and no
 * sign anything is missing.
 */
export async function approve(
  orgId: string,
  input: { hrmsOrgId: string; requestId: string; vendorId: string; note?: string },
) {
  const row = await requireRow(orgId, input.hrmsOrgId, input.requestId);

  // HR enters whole currency units; money is stored here in minor units.
  const totalMinor = Math.round((row.estimatedCost || 0) * 100);
  const quantity = Math.max(1, row.quantity || 1);
  const po = await createPO(orgId, {
    vendorId: input.vendorId,
    issueDate: new Date().toISOString(),
    currency: row.currency || "AED",
    lineItems: [{
      description: row.item,
      quantity,
      unitPriceMinor: Math.round(totalMinor / quantity),
      discountPct: 0,
      taxPct: 0,
    }],
    notes: [row.justification, input.note].filter(Boolean).join(" — "),
  } as never);

  await hrmsClient.approveProcurement(input.hrmsOrgId, input.requestId, {
    purchaseOrderRef: po.poNumber,
    note: input.note,
  });
  return { purchaseOrder: po };
}

export async function reject(orgId: string, input: { hrmsOrgId: string; requestId: string; note?: string }) {
  await requireRow(orgId, input.hrmsOrgId, input.requestId);
  await hrmsClient.rejectProcurement(input.hrmsOrgId, input.requestId, { note: input.note });
  return { rejected: true };
}
