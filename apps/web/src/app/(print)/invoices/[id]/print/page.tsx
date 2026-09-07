"use client";

import { use, useEffect } from "react";
import { formatMoney, getPrintLabels, formatOrgAddress, taxNumberLabel, displayTaxSplit, type Invoice } from "@delta/shared";
import { useInvoice } from "@/features/invoices/api";
import { INVOICE_STATUS_TONE } from "@/features/invoices/status";
import { useOrganization } from "@/features/organization/api";
import { PrintBrandMark } from "@/components/print/brand-mark";
import { PrintSellerBlock } from "@/components/print/seller-block";
import { PrintBankBlock } from "@/components/print/bank-block";
import { useCustomer } from "@/features/customers/api";
import { useBankAccount } from "@/features/banking/api";
import { downloadInvoicePdf } from "@/features/invoices/invoice-pdf";

const TONE_COLORS: Record<string, string> = {
  neutral: "#64748b",
  primary: "#2563eb",
  success: "#16a34a",
  warning: "#d97706",
  danger: "#dc2626",
};

export default function PrintInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: invoice, isLoading } = useInvoice(id);
  const { data: org } = useOrganization();
  // The client's address and registration: the invoice stores only their name.
  // Read live, so editing a customer changes how an already-issued invoice
  // reprints. Snapshotting it at issue would be more correct and is worth
  // doing, but it is a change to the invoice record rather than to this page.
  const { data: customer } = useCustomer(invoice?.customerId);
  const { data: bankAccount } = useBankAccount(org?.invoiceDefaults?.bankAccountId || undefined);

  // No print dialog. Opening a document should not put a decision in front of
  // somebody who only wanted the file — the button below hands them the PDF.
  useEffect(() => {
    if (invoice) document.title = `Invoice ${invoice.invoiceNumber}`;
  }, [invoice]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-400">
        Preparing document…
      </div>
    );
  }
  if (!invoice) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-400">
        Invoice not found.
      </div>
    );
  }

  const statusColor = TONE_COLORS[INVOICE_STATUS_TONE[invoice.status]] ?? "#64748b";
  const L = getPrintLabels(invoice.locale, org?.taxLabel);
  const isRtl = invoice.locale === "ar";

  // "TAX INVOICE" is a claim about the seller: only an organization with a tax
  // registration may head a document that way. An explicit title in Settings
  // wins, for the organizations that word it differently.
  const registered =
    Boolean(org?.taxRegistrationNumber?.trim()) && org?.taxSystem !== "none";
  const docTitle = org?.invoiceDefaults?.title?.trim() || (registered ? L.taxInvoice : L.invoice);

  // HSN/SAC is an Indian requirement, so the column appears only under GST —
  // an empty column on a dirham invoice reads as something left unfilled.
  const showHsn = org?.taxSystem === "gst";

  /*
   * The figures as they are printed.
   *
   * On a rupee invoice everything is written whole, and rounding each part on
   * its own leaves the column a rupee short of its own total — so the taxes are
   * rounded and the taxable value is what is left. Elsewhere this changes
   * nothing at all.
   */
  const shown = displayTaxSplit(invoice.totalMinor, invoice.taxBreakdown, invoice.currency);

  const billToLines = formatOrgAddress(
    customer
      ? {
          line1: customer.billingAddress.street,
          city: customer.billingAddress.city,
          state: customer.billingAddress.state,
          postcode: customer.billingAddress.zip,
          country: customer.billingAddress.country,
        }
      : null,
  );

  return (
    <>
      <style>{`
        @media print {
          @page { margin: 20mm; size: A4; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .no-print { display: none !important; }
        }
        body { font-family: system-ui, sans-serif; color: #111; background: #fff; margin: 0; }
      `}</style>

      <div dir={isRtl ? "rtl" : "ltr"} style={{ maxWidth: 740, margin: "0 auto", padding: "40px 32px" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 32, paddingBottom: 24, borderBottom: "2px solid #e2e8f0" }}>
          <div style={{ maxWidth: 380 }}>
            <PrintBrandMark branding={invoice.branding} footerText={invoice.branding?.footerText} />
            <PrintSellerBlock org={org} />
          </div>
          <div style={{ textAlign: isRtl ? "left" : "right" }}>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>{docTitle}</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#2563eb" }}>{invoice.invoiceNumber}</div>
            <div style={{ marginTop: 6, display: "inline-block", padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600, textTransform: "capitalize", background: statusColor + "20", color: statusColor }}>
              {invoice.status}
            </div>
          </div>
        </div>

        {/* Bill to / meta */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 32 }}>
          <div>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "#64748b", marginBottom: 4 }}>{L.billTo}</div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{invoice.customerName}</div>
            <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.5, marginTop: 2 }}>
              {billToLines.map((l) => (
                <div key={l}>{l}</div>
              ))}
              {customer?.vatNumber ? (
                <div style={{ marginTop: 2 }}>
                  <span style={{ color: "#64748b" }}>{taxNumberLabel(org?.taxSystem)}: </span>
                  <span style={{ fontWeight: 600, color: "#111" }}>{customer.vatNumber}</span>
                </div>
              ) : null}
            </div>
          </div>
          <div style={{ textAlign: isRtl ? "left" : "right" }}>
            {/* What was actually bought. The invoice has carried these since
                enrolments existed; only the line description showed them, and
                a client reading "Course Fee" could not tell which course. */}
            {invoice.enrolment && (
              <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid #f1f5f9" }}>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "#64748b" }}>Course</div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{invoice.enrolment.course}</div>
                <div style={{ display: "flex", gap: 20, justifyContent: isRtl ? "flex-start" : "flex-end", marginTop: 6 }}>
                  {invoice.enrolment.language ? (
                    <div>
                      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1, color: "#64748b" }}>Language</div>
                      <div style={{ fontSize: 12 }}>{invoice.enrolment.language}</div>
                    </div>
                  ) : null}
                  {invoice.enrolment.meetingBy ? (
                    <div>
                      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1, color: "#64748b" }}>Counsellor</div>
                      <div style={{ fontSize: 12 }}>{invoice.enrolment.meetingBy}</div>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
            <MetaLine label={L.salesperson} value={invoice.salespersonName} />
            {invoice.reference && <MetaLine label={L.reference} value={invoice.reference} />}
            <MetaLine label={L.issueDate} value={invoice.issueDate} />
            <MetaLine label={L.dueDate} value={invoice.dueDate} />
          </div>
        </div>

        {/* Line items */}
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 24, fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#1e3a8a", color: "#fff" }}>
              {(showHsn
                ? [L.description, L.hsnSac, L.qty, L.unitPrice, L.discount, L.tax, L.amount]
                : [L.description, L.qty, L.unitPrice, L.discount, L.tax, L.amount]
              ).map((h, i) => (
                <th key={h} style={{ padding: "8px 10px", textAlign: i === 0 ? "left" : "right", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.map((line, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #e2e8f0", background: i % 2 === 1 ? "#f8fafc" : "#fff" }}>
                <td style={{ padding: "8px 10px" }}>{line.description}</td>
                {showHsn && (
                  <td style={{ padding: "8px 10px", textAlign: "right" }}>{line.hsnSac || "—"}</td>
                )}
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{line.quantity}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{formatMoney(line.unitPriceMinor, invoice.currency)}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{line.discountPct > 0 ? `${line.discountPct}%` : "—"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>
                  {line.taxes.length > 0 ? line.taxes.map((t) => `${t.code} ${t.rate}%`).join(", ") : "—"}
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600 }}>{formatMoney(line.lineTotalMinor, invoice.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 32 }}>
          <div style={{ width: 260, fontSize: 13 }}>
            <PrintTotalRow label={L.subtotal} value={formatMoney(shown.taxableMinor, invoice.currency)} />
            {invoice.discountTotalMinor > 0 && (
              <PrintTotalRow label={L.discount} value={`− ${formatMoney(invoice.discountTotalMinor, invoice.currency)}`} />
            )}
            {shown.taxes.map((t) => (
              <PrintTotalRow key={t.code} label={`${L.tax} (${t.code})`} value={formatMoney(t.amountMinor, invoice.currency)} />
            ))}
            {invoice.roundOffMinor !== 0 && (
              <PrintTotalRow
                label={L.roundOff}
                value={`${invoice.roundOffMinor < 0 ? "− " : "+ "}${formatMoney(Math.abs(invoice.roundOffMinor), invoice.currency)}`}
              />
            )}
            <PrintTotalRow label={L.total} value={formatMoney(invoice.totalMinor, invoice.currency)} strong />
            {invoice.amountPaidMinor > 0 && (
              <PrintTotalRow label={L.paid} value={`− ${formatMoney(invoice.amountPaidMinor, invoice.currency)}`} />
            )}
            <PrintTotalRow
              label={L.balanceDue}
              value={formatMoney(invoice.balanceMinor, invoice.currency)}
              strong
              accent={invoice.balanceMinor > 0}
            />
          </div>
        </div>

        {/* Payments */}
        {invoice.payments.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontWeight: 600, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "#64748b", marginBottom: 8 }}>{L.paymentHistory}</div>
            {invoice.payments.map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", borderBottom: "1px solid #f1f5f9" }}>
                <span>{p.paidOn} — {p.method.replace("_", " ")}{p.reference ? ` (${p.reference})` : ""}</span>
                <span style={{ fontWeight: 600, color: "#16a34a" }}>{formatMoney(p.amountMinor, invoice.currency)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Tax details — a GST requirement, and the same summary Zoho prints.
            The per-rate split of what has been received, plus what the invoice
            was raised for and what is still outstanding. */}
        {showHsn && invoice.taxBreakdown.length > 0 && (
          <TaxDetailsTable invoice={invoice} />
        )}

        <PrintBankBlock account={bankAccount} labels={L} />

        {/* Notes / Terms */}
        {(invoice.notes || invoice.terms) && (
          <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, fontSize: 12, color: "#64748b" }}>
            {invoice.notes && (
              <div><div style={{ fontWeight: 600, marginBottom: 4 }}>{L.notes}</div><div style={{ whiteSpace: "pre-wrap" }}>{invoice.notes}</div></div>
            )}
            {invoice.terms && (
              <div><div style={{ fontWeight: 600, marginBottom: 4 }}>{L.terms}</div><div style={{ whiteSpace: "pre-wrap" }}>{invoice.terms}</div></div>
            )}
          </div>
        )}

        {/* Print button — hidden in print */}
        <div className="no-print" style={{ marginTop: 32, display: "flex", gap: 8 }}>
          <button
            onClick={() => downloadInvoicePdf({ invoice, org, customer, bankAccount })}
            style={{ padding: "8px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}
          >
            Download PDF
          </button>
          <button onClick={() => window.close()} style={{ padding: "8px 16px", background: "#f1f5f9", color: "#111", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
            {L.close}
          </button>
        </div>
      </div>
    </>
  );
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ fontSize: 12, marginBottom: 2 }}>
      <span style={{ color: "#64748b" }}>{label}: </span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function PrintTotalRow({
  label,
  value,
  strong,
  accent,
}: {
  label: string;
  value: string;
  strong?: boolean;
  accent?: boolean;
}) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      padding: "4px 0",
      borderTop: strong ? "1px solid #cbd5e1" : undefined,
      marginTop: strong ? 4 : undefined,
      fontWeight: strong ? 700 : 400,
      fontSize: strong ? 14 : 12,
      color: accent ? "#dc2626" : strong ? "#111" : "#64748b",
    }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}


/**
 * The GST tax-details summary.
 *
 * Columns are whatever tax codes the invoice actually carries, so CGST/SGST
 * within a state and IGST across one both come out right without this knowing
 * which it is looking at.
 *
 * Three rows, because three different figures get asked about. What the
 * invoice was raised for; what has been received against it, split across the
 * same codes in the proportion they were charged, which is how the payment
 * carries its tax; and what is left. A summary that showed only one of them
 * answers a third of the question.
 */
function TaxDetailsTable({ invoice }: { invoice: Invoice }) {
  const codes = invoice.taxBreakdown.map((t) => t.code);

  // Rates come off the lines, where they are recorded per code.
  const rateOf = new Map<string, number>();
  for (const line of invoice.lineItems) {
    for (const t of line.taxes ?? []) if (!rateOf.has(t.code)) rateOf.set(t.code, t.rate);
  }
  const totalRate = codes.reduce((sum, c) => sum + (rateOf.get(c) ?? 0), 0);
  const label = totalRate > 0
    ? `GST ${totalRate}% (${codes.map((c) => `${rateOf.get(c) ?? 0}%`).join(" + ")})`
    : codes.join(" + ");

  const paid = invoice.amountPaidMinor;
  const total = invoice.totalMinor;
  // Proportional, so the parts of a part payment still add up to it.
  const share = (amount: number) => (total > 0 ? Math.round((paid * amount) / total) : 0);

  // Printed whole on a rupee invoice, and made to add up the same way the
  // totals block does.
  const invoiced = displayTaxSplit(total, invoice.taxBreakdown, invoice.currency);
  const received = displayTaxSplit(
    paid,
    invoice.taxBreakdown.map((t) => ({ code: t.code, amountMinor: share(t.amountMinor) })),
    invoice.currency,
  );

  const cell: React.CSSProperties = { padding: "6px 10px", textAlign: "right", fontSize: 11 };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, color: "#fff" };

  return (
    <div style={{ marginBottom: 24 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #e2e8f0" }}>
        <thead>
          <tr style={{ background: "#1e293b" }}>
            <th style={{ ...head, textAlign: "left" }}>Tax Details</th>
            <th style={head}>Taxable</th>
            {codes.map((c) => (
              <th key={c} style={head}>{c}</th>
            ))}
            <th style={head}>Total</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
            <td style={{ ...cell, textAlign: "left" }}>{label} — invoiced</td>
            <td style={cell}>{formatMoney(invoiced.taxableMinor, invoice.currency)}</td>
            {invoiced.taxes.map((t) => (
              <td key={t.code} style={cell}>{formatMoney(t.amountMinor, invoice.currency)}</td>
            ))}
            <td style={{ ...cell, fontWeight: 600 }}>{formatMoney(total, invoice.currency)}</td>
          </tr>
          {paid > 0 && (
            <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
              <td style={{ ...cell, textAlign: "left" }}>{label} — received</td>
              <td style={cell}>{formatMoney(received.taxableMinor, invoice.currency)}</td>
              {received.taxes.map((t) => (
                <td key={t.code} style={cell}>{formatMoney(t.amountMinor, invoice.currency)}</td>
              ))}
              <td style={{ ...cell, fontWeight: 600 }}>{formatMoney(paid, invoice.currency)}</td>
            </tr>
          )}
          <tr style={{ background: "#f8fafc" }}>
            <td style={{ ...cell, textAlign: "left", fontWeight: 600 }} colSpan={codes.length + 2}>
              Balance
            </td>
            <td style={{ ...cell, fontWeight: 700 }}>{formatMoney(invoice.balanceMinor, invoice.currency)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
