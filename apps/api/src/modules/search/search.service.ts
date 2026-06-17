import { Invoice } from "../invoice/invoice.model";
import { Quotation } from "../quotation/quotation.model";
import { Customer } from "../customer/customer.model";

export interface SearchResult {
  invoices: { id: string; label: string; sub: string; href: string }[];
  quotations: { id: string; label: string; sub: string; href: string }[];
  customers: { id: string; label: string; sub: string; href: string }[];
}

export async function globalSearch(orgId: string, q: string): Promise<SearchResult> {
  if (!q || q.trim().length < 2) return { invoices: [], quotations: [], customers: [] };

  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const LIMIT = 8;

  const [invoices, quotations, customers] = await Promise.all([
    Invoice.find({ organizationId: orgId, $or: [{ invoiceNumber: re }, { customerName: re }] })
      .limit(LIMIT)
      .select("invoiceNumber customerName status"),
    Quotation.find({ organizationId: orgId, $or: [{ quoteNumber: re }, { customerName: re }] })
      .limit(LIMIT)
      .select("quoteNumber customerName status"),
    Customer.find({ organizationId: orgId, $or: [{ name: re }, { email: re }, { companyName: re }] })
      .limit(LIMIT)
      .select("name email companyName"),
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
      label: (d as unknown as { companyName?: string; name: string }).companyName || (d as unknown as { name: string }).name,
      sub: (d as unknown as { email: string }).email,
      href: `/customers/${d._id}`,
    })),
  };
}
