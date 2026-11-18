import { Types } from "mongoose";
import { formatMoney, normalizeReference, referenceProblem } from "@delta/shared";
import { AppError } from "../../lib/http";
import { Invoice } from "./invoice.model";

/*
 * A client's payment's reference is its own (the user, 2026-11-18: "enter the payment reference when approving … a
 * unique code … mandatory"): wherever money in is recorded on an invoice — typed on the invoice, approved from a
 * close, a CRM balance payment or a CS Portal course payment — the reference is required unless it was cash
 * (`referenceProblem`), and one already on another payment in the organisation is refused, saying which, so one
 * transfer is never counted twice. Case and spaces don't count. A voided invoice's payments don't hold theirs.
 * Payments recorded before 2026-11-18 keep what they have — duplicates among them stay — but their references count.
 */

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches a stored reference equal to `norm` whatever its case and spacing. */
const referenceRe = (norm: string) => new RegExp(`^\\s*${[...norm].map(escapeRe).join("\\s*")}\\s*$`, "i");

/** Required unless cash — the API's own check, whatever the form did. */
export function requireReference(method: string | null | undefined, reference: unknown): void {
  const problem = referenceProblem(method, reference);
  if (problem) throw new AppError("VALIDATION_ERROR", problem);
}

/** Refused when another payment in the organisation already has this reference (`exceptPaymentId`: the one being edited). */
export async function assertReferenceFree(orgId: string, reference: unknown, exceptPaymentId?: string): Promise<void> {
  const norm = normalizeReference(reference);
  if (!norm) return;
  const rx = referenceRe(norm);
  const except = exceptPaymentId && Types.ObjectId.isValid(exceptPaymentId) ? new Types.ObjectId(exceptPaymentId) : null;
  const hit = await Invoice.findOne({
    organizationId: new Types.ObjectId(orgId),
    status: { $ne: "void" },
    payments: { $elemMatch: { reference: rx, ...(except ? { _id: { $ne: except } } : {}) } },
  }).select("invoiceNumber currency payments._id payments.reference payments.amountMinor payments.paidOn").lean<{
    invoiceNumber?: string; currency?: string; payments?: Array<{ _id: Types.ObjectId; reference?: string; amountMinor: number; paidOn?: Date }>;
  }>();
  if (!hit) return;
  const p = (hit.payments ?? []).find((x) => rx.test(x.reference ?? "") && (!except || !x._id.equals(except)));
  const what = p ? `a payment of ${formatMoney(p.amountMinor, hit.currency ?? "AED")}${p.paidOn ? ` on ${new Date(p.paidOn).toISOString().slice(0, 10)}` : ""}` : "a payment";
  throw new AppError("CONFLICT", `Reference ${String(reference).trim()} is already on ${hit.invoiceNumber ?? "another invoice"} — ${what}. Each payment's reference must be its own: check the statement.`);
}

/** Two of the same among references given together (a close's payments approved at once): the repeated one, else null. */
export function repeatedReference(references: unknown[]): string | null {
  const seen = new Set<string>();
  for (const r of references) {
    const n = normalizeReference(r);
    if (!n) continue;
    if (seen.has(n)) return String(r).trim();
    seen.add(n);
  }
  return null;
}
