import {
  buildInvoicePdf,
  invoicePdfName,
  type Invoice,
  type OrganizationSettings,
  type Customer,
} from "@delta/shared";
import { api } from "@/lib/api";

/**
 * Hand the invoice to somebody as a file.
 *
 * The drawing itself moved to shared, because it is done twice: here for a
 * download, and on the server for the copy attached to the email that carries
 * the invoice out. Two drawings of one document drift, and the one nobody is
 * looking at drifts first — so there is one, and this is the half of it that
 * belongs to a browser.
 */

/**
 * The logo an invoice's PDF is drawn with, as data — from the API, because only
 * the server can read an image from wherever the logo is kept. Null when it
 * cannot be had, and the PDF is drawn with the name alone, as it always was.
 */
export async function loadInvoiceLogo(invoiceId: string): Promise<string | null> {
  try {
    return (await api.get<{ dataUrl: string | null }>(`invoices/${invoiceId}/logo`)).dataUrl ?? null;
  } catch {
    return null;
  }
}

export async function downloadInvoicePdf(opts: {
  invoice: Invoice;
  org?: OrganizationSettings | null;
  customer?: Customer | null;
  bankAccount?: {
    accountName?: string; bankName?: string; accountNumber?: string;
    iban?: string; swift?: string; ifsc?: string; branch?: string;
  } | null;
}): Promise<void> {
  const logo = await loadInvoiceLogo(opts.invoice.id);
  buildInvoicePdf({ ...opts, logo }).save(invoicePdfName(opts.invoice.invoiceNumber));
}
