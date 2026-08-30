import type { BankAccount, PrintLabels } from "@delta/shared";

/**
 * Where to send the money.
 *
 * Only the fields that have been filled in are printed: which of IFSC, SWIFT
 * and IBAN applies depends on where the account is held, and printing empty
 * labels for the other two makes an invoice look like it is missing something.
 * No nominated account in Settings means no block at all.
 */
export function PrintBankBlock({
  account,
  labels: L,
}: {
  account?: BankAccount | null;
  labels: PrintLabels;
}) {
  if (!account) return null;

  const rows: Array<[string, string]> = [
    [L.accountName, account.accountName],
    [L.bankName, account.bankName],
    [L.branch, account.branch],
    [L.accountNumber, account.accountNumber],
    [L.ifsc, account.ifsc],
    [L.swift, account.swift],
    [L.iban, account.iban],
  ].filter(([, v]) => (v ?? "").trim().length > 0) as Array<[string, string]>;

  if (rows.length === 0) return null;

  return (
    <div style={{ marginBottom: 24, border: "1px solid #e2e8f0", borderRadius: 6, padding: "12px 14px" }}>
      <div style={{ fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#64748b", marginBottom: 8 }}>
        {L.bankDetails}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "4px 24px", fontSize: 12 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "flex", gap: 6 }}>
            <span style={{ color: "#64748b", whiteSpace: "nowrap" }}>{label}:</span>
            <span style={{ fontWeight: 600 }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
