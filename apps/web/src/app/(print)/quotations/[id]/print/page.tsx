"use client";

import { use, useEffect } from "react";
import { formatMoney, getPrintLabels } from "@delta/shared";
import { useQuotation } from "@/features/quotations/api";
import { QUOTE_STATUS_TONE } from "@/features/quotations/status";
import { useOrganization } from "@/features/organization/api";

const TONE_COLORS: Record<string, string> = {
  neutral: "#64748b",
  primary: "#2563eb",
  success: "#16a34a",
  warning: "#d97706",
  danger: "#dc2626",
};

export default function PrintQuotationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: q, isLoading } = useQuotation(id);
  const { data: org } = useOrganization();

  useEffect(() => {
    if (q) {
      document.title = `Quotation ${q.quoteNumber}`;
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [q]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-400">
        Preparing document…
      </div>
    );
  }
  if (!q) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-400">
        Quotation not found.
      </div>
    );
  }

  const statusColor = TONE_COLORS[QUOTE_STATUS_TONE[q.status]] ?? "#64748b";
  const L = getPrintLabels("en", org?.taxLabel);

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

      <div style={{ maxWidth: 740, margin: "0 auto", padding: "40px 32px" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 32, paddingBottom: 24, borderBottom: "2px solid #e2e8f0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 8, background: "#2563eb", color: "#fff", fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>Δ</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>Delta Finance</div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>{L.quotation}</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#2563eb" }}>{q.quoteNumber}</div>
            <div style={{ marginTop: 6, display: "inline-block", padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600, textTransform: "capitalize", background: statusColor + "20", color: statusColor }}>
              {q.status}
            </div>
          </div>
        </div>

        {/* Bill to / meta */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 32 }}>
          <div>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "#64748b", marginBottom: 4 }}>{L.quoteTo}</div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{q.customerName}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <MetaLine label={L.issueDate} value={q.issueDate} />
            <MetaLine label={L.expiryDate} value={q.expiryDate} />
            {q.currency !== "AED" && <MetaLine label={L.currency} value={q.currency} />}
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
            {q.lineItems.map((line, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #e2e8f0", background: i % 2 === 1 ? "#f8fafc" : "#fff" }}>
                <td style={{ padding: "8px 10px" }}>{line.description}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{line.quantity}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{formatMoney(line.unitPriceMinor, q.currency)}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{line.discountPct > 0 ? `${line.discountPct}%` : "—"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{line.taxPct > 0 ? `${line.taxPct}%` : "—"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600 }}>{formatMoney(line.lineTotalMinor, q.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 32 }}>
          <div style={{ width: 260, fontSize: 13 }}>
            <PrintTotalRow label={L.subtotal} value={formatMoney(q.subtotalMinor, q.currency)} />
            {q.discountTotalMinor > 0 && (
              <PrintTotalRow label={L.discount} value={`− ${formatMoney(q.discountTotalMinor, q.currency)}`} />
            )}
            {q.taxBreakdown?.length ? (
              q.taxBreakdown.map((t) => (
                <PrintTotalRow key={t.code} label={t.code} value={formatMoney(t.amountMinor, q.currency)} />
              ))
            ) : q.taxTotalMinor > 0 ? (
              <PrintTotalRow label={L.tax} value={formatMoney(q.taxTotalMinor, q.currency)} />
            ) : null}
            <PrintTotalRow label={L.total} value={formatMoney(q.totalMinor, q.currency)} strong />
          </div>
        </div>

        {/* Notes / Terms */}
        {(q.notes || q.terms) && (
          <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, fontSize: 12, color: "#64748b" }}>
            {q.notes && (
              <div><div style={{ fontWeight: 600, marginBottom: 4 }}>{L.notes}</div><div style={{ whiteSpace: "pre-wrap" }}>{q.notes}</div></div>
            )}
            {q.terms && (
              <div><div style={{ fontWeight: 600, marginBottom: 4 }}>{L.terms}</div><div style={{ whiteSpace: "pre-wrap" }}>{q.terms}</div></div>
            )}
          </div>
        )}

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

function PrintTotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderTop: strong ? "1px solid #cbd5e1" : undefined, marginTop: strong ? 4 : undefined, fontWeight: strong ? 700 : 400, fontSize: strong ? 14 : 12, color: strong ? "#111" : "#64748b" }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
