import { hasPermission } from "@delta/shared";
import { Invoice } from "../invoice/invoice.model";
import { Quotation } from "../quotation/quotation.model";
import { Customer } from "../customer/customer.model";
import type { AuthContext } from "../../middleware/auth";
import { scopeFilter, type Scope } from "../../lib/ownership";

export interface SearchResult {
  invoices: { id: string; label: string; sub: string; href: string }[];
  quotations: { id: string; label: string; sub: string; href: string }[];
  customers: { id: string; label: string; sub: string; href: string }[];
}

const EMPTY: SearchResult = { invoices: [], quotations: [], customers: [] };

/**
 * What this caller may search, per collection.
 *
 * Search reaches across modules that each have their own permission, and it is
 * the only place they are queried together — so it has to ask the same
 * questions the individual list endpoints ask. Returning a record here that
 * the caller could not open is a leak whether or not the link works: the
 * invoice number and the customer's name are already in the result.
 */
function visibility(auth: AuthContext): {
  invoices: Scope | null;
  quotations: boolean;
  customers: boolean;
} {
  const can = (p: string) => auth.isSuperAdmin || hasPermission(auth.permissions, p as never);

  let invoices: Scope | null = null;
  if (can("invoice:read")) invoices = { all: true };
  else if (can("invoice:read:own")) invoices = { all: false, userId: auth.userId };

  return {
    invoices,
    quotations: can("quotation:read"),
    customers: can("customer:read"),
  };
}

export async function globalSearch(auth: AuthContext, q: string): Promise<SearchResult> {
  if (!q || q.trim().length < 2) return EMPTY;

  const orgId = auth.organizationId;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const LIMIT = 8;
  const vis = visibility(auth);

  const [invoices, quotations, customers] = await Promise.all([
    vis.invoices
      ? Invoice.find({
          organizationId: orgId,
          ...scopeFilter(vis.invoices, "salespersonId"),
          $or: [{ invoiceNumber: re }, { customerName: re }],
        })
          .limit(LIMIT)
          .select("invoiceNumber customerName status")
      : Promise.resolve([]),
    vis.quotations
      ? Quotation.find({ organizationId: orgId, $or: [{ quoteNumber: re }, { customerName: re }] })
          .limit(LIMIT)
          .select("quoteNumber customerName status")
      : Promise.resolve([]),
    vis.customers
      ? Customer.find({
          organizationId: orgId,
          $or: [{ name: re }, { email: re }, { companyName: re }],
        })
          .limit(LIMIT)
          .select("name email companyName")
      : Promise.resolve([]),
  ]);

  return {
    invoices: invoices.map((d) => ({
      id: String(d._id),
      label: (d as unknown as { invoiceNumber: string }).invoiceNumber,
      sub: (d as unknown as { customerName: string }).customerName,
      href: `/invoices/${d._id}`,
    })),
    quotations: quotations.map((d) => ({
      id: String(d._id),
      label: (d as unknown as { quoteNumber: string }).quoteNumber,
      sub: (d as unknown as { customerName: string }).customerName,
      href: `/quotations/${d._id}`,
    })),
    customers: customers.map((d) => ({
      id: String(d._id),
      label:
        (d as unknown as { companyName?: string; name: string }).companyName ||
        (d as unknown as { name: string }).name,
      sub: (d as unknown as { email: string }).email,
      href: `/customers/${d._id}`,
    })),
  };
}
