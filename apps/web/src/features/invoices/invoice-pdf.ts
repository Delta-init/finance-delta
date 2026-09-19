import {
  buildInvoicePdf,
  invoicePdfName,
  type Invoice,
  type OrganizationSettings,
  type Customer,
} from "@delta/shared";

/**
 * Hand the invoice to somebody as a file.
 *
 * The drawing itself moved to shared, because it is done twice: here for a
 * download, and on the server for the copy attached to the email that carries
 * the invoice out. Two drawings of one document drift, and the one nobody is
 * looking at drifts first — so there is one, and this is the half of it that
 * belongs to a browser.
 */
export function downloadInvoicePdf(opts: {
  invoice: Invoice;
  org?: OrganizationSettings | null;
  customer?: Customer | null;
  bankAccount?: {
    accountName?: string; bankName?: string; accountNumber?: string;
    iban?: string; swift?: string; ifsc?: string; branch?: string;
  } | null;
}): void {
  buildInvoicePdf(opts).save(invoicePdfName(opts.invoice.invoiceNumber));
}
