"use client";

import { use, useEffect } from "react";
import { formatMoney, getPrintLabels } from "@delta/shared";
import { useCreditNote } from "@/features/credit-notes/api";
import { useOrganization } from "@/features/organization/api";
import { PrintBrandMark } from "@/components/print/brand-mark";
import { PrintCloseButton } from "@/components/print/close-button";

const STATUS_COLOR: Record<string, string> = {
  draft: "#64748b",
  issued: "#2563eb",
  applied: "#16a34a",
  voided: "#dc2626",
};

export default function PrintCreditNotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: cn, isLoading } = useCreditNote(id);
  const { data: org } = useOrganization();

  useEffect(() => {
    if (cn) {
      document.title = `Credit Note ${cn.creditNoteNumber}`;
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [cn]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-400">
        Preparing document…
      </div>
    );
  }
  if (!cn) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-400">
        Credit note not found.
      </div>
    );
  }

  const statusColor = STATUS_COLOR[cn.status] ?? "#64748b";
  const remaining = cn.totalMinor - cn.amountAppliedMinor;
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
          <PrintBrandMark />
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>CREDIT NOTE</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#2563eb" }}>{cn.creditNoteNumber}</div>
            <div style={{ fontSize: 12, color: "#64748b" }}>Ref Invoice: {cn.invoiceNumber}</div>
            <div style={{ marginTop: 6, display: "inline-block", padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600, textTransform: "capitalize", background: statusColor + "20", color: statusColor }}>
              {cn.status}
            </div>
          </div>
        </div>

        {/* Customer / meta */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 32 }}>
          <div>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "#64748b", marginBottom: 4 }}>Credit To</div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{cn.customerName}</div>
          </div>
          <div style={{ textAlign: "right", fontSize: 12 }}>
            {cn.issuedAt && (
              <div style={{ marginBottom: 2 }}>
                <span style={{ color: "#64748b" }}>Issued: </span>
                <span style={{ fontWeight: 500 }}>{cn.issuedAt.slice(0, 10)}</span>
              </div>
            )}
            <div style={{ marginBottom: 2 }}>
              <span style={{ color: "#64748b" }}>Created: </span>
              <span style={{ fontWeight: 500 }}>{cn.createdAt.slice(0, 10)}</span>
            </div>
          </div>
        </div>

        {/* Reason */}
        <div style={{ background: "#fefce8", border: "1px solid #fef08a", borderRadius: 8, padding: "12px 16px", marginBottom: 24, fontSize: 13 }}>
          <span style={{ fontWeight: 600, color: "#854d0e" }}>Reason: </span>
          <span style={{ color: "#713f12" }}>{cn.reason}</span>
        </div>

        {/* Line items */}
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 24, fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#1e3a8a", color: "#fff" }}>
              {["Description", "Qty", "Unit Price", "Disc %", `${L.tax} %`, "Amount"].map((h, i) => (
                <th key={h} style={{ padding: "8px 10px", textAlign: i === 0 ? "left" : "right", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cn.lineItems.map((line, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #e2e8f0", background: i % 2 === 1 ? "#f8fafc" : "#fff" }}>
                <td style={{ padding: "8px 10px" }}>{line.description}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{line.quantity}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{formatMoney(line.unitPriceMinor, cn.currency)}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{line.discountPct > 0 ? `${line.discountPct}%` : "—"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{line.taxPct > 0 ? `${line.taxPct}%` : "—"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600 }}>{formatMoney(line.lineTotalMinor, cn.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 32 }}>
          <div style={{ width: 260, fontSize: 13 }}>
            <TRow label="Subtotal" value={formatMoney(cn.subtotalMinor, cn.currency)} />
            {cn.taxTotalMinor > 0 && (
              <TRow label={L.tax} value={formatMoney(cn.taxTotalMinor, cn.currency)} />
            )}
            <TRow label="Credit Total" value={formatMoney(cn.totalMinor, cn.currency)} strong />
            {cn.amountAppliedMinor > 0 && (
              <TRow label="Applied" value={`− ${formatMoney(cn.amountAppliedMinor, cn.currency)}`} />
            )}
            <TRow label="Remaining" value={formatMoney(remaining, cn.currency)} strong accent={remaining > 0} />
          </div>
        </div>

        {/* Print button */}
        <div className="no-print" style={{ display: "flex", gap: 8 }}>
          <button onClick={() => window.print()} style={{ padding: "8px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            Print / Save as PDF
          </button>
          <PrintCloseButton fallbackHref={`/credit-notes/${id}`} />
        </div>
      </div>
    </>
  );
}

function TRow({ label, value, strong, accent }: { label: string; value: string; strong?: boolean; accent?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderTop: strong ? "1px solid #cbd5e1" : undefined, marginTop: strong ? 4 : undefined, fontWeight: strong ? 700 : 400, fontSize: strong ? 14 : 12, color: accent ? "#dc2626" : strong ? "#111" : "#64748b" }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
