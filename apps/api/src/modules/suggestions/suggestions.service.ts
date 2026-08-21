import { Types, type Model } from "mongoose";
import { AppError } from "../../lib/http";
import { Invoice } from "../invoice/invoice.model";
import { Quotation } from "../quotation/quotation.model";
import { Bill } from "../bill/bill.model";
import { PurchaseOrder } from "../purchase-order/purchase-order.model";
import { CreditNote } from "../credit-note/credit-note.model";

/** Which collections + field path each suggestion type reads distinct values from.
 *  All are org-scoped and low-sensitivity (values the user has already entered). */
const FIELDS: Record<string, { path: string; models: Model<unknown>[] }> = {
  lineDescription: {
    path: "lineItems.description",
    models: [Invoice, Quotation, Bill, PurchaseOrder, CreditNote] as unknown as Model<unknown>[],
  },
  reference: { path: "reference", models: [Invoice, Bill] as unknown as Model<unknown>[] },
  notes: { path: "notes", models: [Invoice, Quotation, Bill, PurchaseOrder] as unknown as Model<unknown>[] },
  terms: { path: "terms", models: [Invoice, Quotation] as unknown as Model<unknown>[] },
};

export const SUGGESTION_FIELDS = Object.keys(FIELDS);

const LIMIT = 8;

export async function getSuggestions(orgId: string, field: string, q: string): Promise<string[]> {
  const def = FIELDS[field];
  if (!def) throw new AppError("VALIDATION_ERROR", `Invalid suggestion field '${field}'`);

  const oid = new Types.ObjectId(orgId);
  const sets = await Promise.all(
    def.models.map((m) => m.distinct(def.path, { organizationId: oid }) as Promise<unknown[]>),
  );

  // Dedupe case-insensitively, keep the first-seen casing.
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const v of sets.flat()) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) { seen.add(key); uniq.push(trimmed); }
  }

  const query = (q ?? "").trim().toLowerCase();
  const matched = query ? uniq.filter((v) => v.toLowerCase().includes(query)) : uniq;
  matched.sort((a, b) => {
    const aStarts = a.toLowerCase().startsWith(query) ? 0 : 1;
    const bStarts = b.toLowerCase().startsWith(query) ? 0 : 1;
    return aStarts - bStarts || a.localeCompare(b);
  });
  return matched.slice(0, LIMIT);
}
