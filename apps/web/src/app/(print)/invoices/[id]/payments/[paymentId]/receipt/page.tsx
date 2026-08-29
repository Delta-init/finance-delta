"use client";

import { use, useEffect } from "react";
import { formatMoney } from "@delta/shared";
import { useInvoice } from "@/features/invoices/api";
import { PrintBrandMark } from "@/components/print/brand-mark";

export default function PaymentReceiptPage({
  params,
}: {
  params: Promise<{ id: string; paymentId: string }>;
}) {
  const { id, paymentId } = use(params);
  const { data: invoice, isLoading } = useInvoice(id);

  const payment = invoice?.payments.find((p) => p.id === paymentId);

  useEffect(() => {
    if (payment) {
      document.title = `Receipt — ${invoice?.invoiceNumber ?? ""}`;
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [payment, invoice?.invoiceNumber]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-400">
        Preparing receipt…
      </div>
    );
  }
  if (!invoice || !payment) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-400">
        Payment not found.
      </div>
    );
  }

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

      <div style={{ maxWidth: 520, margin: "40px auto", padding: "40px 32px", border: "1px solid #e2e8f0", borderRadius: 12 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
          <PrintBrandMark branding={invoice.branding} footerText={invoice.branding?.footerText} />
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: -0.5 }}>RECEIPT</div>
            <div style={{ fontSize: 12, color: "#64748b" }}>Ref: {invoice.invoiceNumber}</div>
          </div>
        </div>

        <div style={{ borderTop: "2px solid #2563eb", marginBottom: 24 }} />

        {/* Customer */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "#64748b", marginBottom: 4 }}>Received From</div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{invoice.customerName}</div>
        </div>

        {/* Payment details */}
        <div style={{ background: "#f8fafc", borderRadius: 8, padding: "16px 20px", marginBottom: 24 }}>
          <Row label="Amount" value={formatMoney(payment.amountMinor, invoice.currency)} large />
          <Row label="Date" value={payment.paidOn} />
          <Row label="Method" value={payment.method.replace("_", " ")} capitalize />
          {payment.accountName && <Row label="Account" value={payment.accountName} />}
          {payment.reference && <Row label="Reference" value={payment.reference} />}
          {payment.notes && <Row label="Notes" value={payment.notes} />}
        </div>

        {/* Invoice totals summary */}
        <div style={{ fontSize: 12, color: "#64748b", borderTop: "1px solid #e2e8f0", paddingTop: 16, marginBottom: 24 }}>
          <SummaryRow label="Invoice Total" value={formatMoney(invoice.totalMinor, invoice.currency)} />
          <SummaryRow label="Total Paid" value={formatMoney(invoice.amountPaidMinor, invoice.currency)} />
          <SummaryRow
            label="Balance Due"
            value={formatMoney(invoice.balanceMinor, invoice.currency)}
            accent={invoice.balanceMinor > 0}
            strong
          />
        </div>

        {invoice.balanceMinor === 0 && (
          <div style={{ textAlign: "center", padding: "12px", background: "#f0fdf4", borderRadius: 8, color: "#16a34a", fontWeight: 700, fontSize: 14, letterSpacing: 0.5, marginBottom: 24 }}>
            ✓ PAID IN FULL
          </div>
        )}

        {/* Print button */}
        <div className="no-print" style={{ display: "flex", gap: 8 }}>
          <button onClick={() => window.print()} style={{ padding: "8px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            Print / Save as PDF
          </button>
          <button onClick={() => window.close()} style={{ padding: "8px 16px", background: "#f1f5f9", color: "#111", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, large, capitalize }: { label: string; value: string; large?: boolean; capitalize?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "5px 0", borderBottom: "1px solid #e2e8f0" }}>
      <span style={{ fontSize: 12, color: "#64748b" }}>{label}</span>
      <span style={{ fontSize: large ? 20 : 13, fontWeight: large ? 700 : 500, color: large ? "#111" : "#374151", textTransform: capitalize ? "capitalize" : undefined }}>
        {value}
      </span>
    </div>
  );
}

function SummaryRow({ label, value, strong, accent }: { label: string; value: string; strong?: boolean; accent?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontWeight: strong ? 700 : 400, color: accent ? "#dc2626" : undefined }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
