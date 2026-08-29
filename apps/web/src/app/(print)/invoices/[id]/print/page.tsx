"use client";

import { use, useEffect } from "react";
import { formatMoney, getPrintLabels } from "@delta/shared";
import { useInvoice } from "@/features/invoices/api";
import { INVOICE_STATUS_TONE } from "@/features/invoices/status";
import { useOrganization } from "@/features/organization/api";
import { PrintBrandMark } from "@/components/print/brand-mark";

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

  useEffect(() => {
    if (invoice) {
      document.title = `Invoice ${invoice.invoiceNumber}`;
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
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
          <div>
            <PrintBrandMark branding={invoice.branding} footerText={invoice.branding?.footerText} />
          </div>
          <div style={{ textAlign: isRtl ? "left" : "right" }}>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>{L.invoice}</div>
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
          </div>
          <div style={{ textAlign: isRtl ? "left" : "right" }}>
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
              {[L.description, L.qty, L.unitPrice, L.discount, L.tax, L.amount].map((h, i) => (
                <th key={h} style={{ padding: "8px 10px", textAlign: i === 0 ? "left" : "right", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.map((line, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #e2e8f0", background: i % 2 === 1 ? "#f8fafc" : "#fff" }}>
                <td style={{ padding: "8px 10px" }}>{line.description}</td>
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
            <PrintTotalRow label={L.subtotal} value={formatMoney(invoice.subtotalMinor, invoice.currency)} />
            {invoice.discountTotalMinor > 0 && (
              <PrintTotalRow label={L.discount} value={`− ${formatMoney(invoice.discountTotalMinor, invoice.currency)}`} />
            )}
            {invoice.taxBreakdown.map((t) => (
              <PrintTotalRow key={t.code} label={`${L.tax} (${t.code})`} value={formatMoney(t.amountMinor, invoice.currency)} />
            ))}
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
          <button onClick={() => window.print()} style={{ padding: "8px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            {L.print}
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
