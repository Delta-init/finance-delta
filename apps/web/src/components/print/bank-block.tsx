import type { BankAccount, PrintLabels } from "@delta/shared";

/**
 * Where to send the money, and anything else the reader needs.
 *
 * One block with two columns rather than three stacked sections. Bank details,
 * a note and terms answer two different questions — where the money goes, and
 * what else applies — and standing them side by side is both how the document
 * is read and how it fits: three headings running down the page used to push
 * the total off the bottom of it.
 *
 * Only the fields that have been filled in are printed: which of IFSC, SWIFT
 * and IBAN applies depends on where the account is held, and printing empty
 * labels for the other two makes an invoice look like it is missing something.
 * A column with nothing in it is left out entirely and the other takes the
 * width, because half a box with nothing beside it reads as something missing.
 */
export function PrintBankBlock({
  account,
  labels: L,
  notes,
  terms,
}: {
  account?: BankAccount | null;
  labels: PrintLabels;
  notes?: string;
  terms?: string;
}) {
  const rows: Array<[string, string]> = (
    account
      ? ([
          [L.accountName, account.accountName],
          [L.bankName, account.bankName],
          [L.branch, account.branch],
          [L.accountNumber, account.accountNumber],
          [L.ifsc, account.ifsc],
          [L.swift, account.swift],
          [L.iban, account.iban],
        ] as Array<[string, string | undefined]>)
      : []
  ).filter(([, v]) => (v ?? "").trim().length > 0) as Array<[string, string]>;

  const note = notes?.trim() ?? "";
  const term = terms?.trim() ?? "";
  const hasBank = rows.length > 0;
  const hasSaid = Boolean(note || term);
  if (!hasBank && !hasSaid) return null;

  const heading: React.CSSProperties = {
    fontWeight: 600,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#334155",
    marginBottom: 8,
  };

  return (
    <div
      style={{
        marginBottom: 24,
        border: "1px solid #e2e8f0",
        borderRadius: 6,
        display: "grid",
        gridTemplateColumns: hasBank && hasSaid ? "1fr 1fr" : "1fr",
      }}
    >
      {hasBank && (
        // Right-aligned against the divider, as account details sit on a
        // printed invoice: the labels vary in length and a ragged left edge is
        // less noticeable than a ragged right one next to a rule.
        <div style={{ padding: "12px 14px", textAlign: "right" }}>
          <div style={heading}>{L.bankDetails}</div>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: "#475569" }}>
            {rows.map(([label, value]) => (
              <div key={label}>
                {label.toUpperCase()} : <span style={{ fontWeight: 600, color: "#0f172a" }}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasSaid && (
        <div
          style={{
            padding: "12px 14px",
            borderLeft: hasBank ? "1px solid #e2e8f0" : undefined,
          }}
        >
          <div style={heading}>{L.notes}</div>
          {note && (
            <div style={{ fontSize: 13, color: "#0f172a", whiteSpace: "pre-wrap" }}>{note}</div>
          )}
          {/* The terms sit under the note, smaller and quieter. They are a
              condition rather than a message, and giving them their own
              heading made two paragraphs out of what is read as one. */}
          {term && (
            <div
              style={{
                marginTop: note ? 4 : 0,
                fontSize: 11,
                color: "#94a3b8",
                whiteSpace: "pre-wrap",
              }}
            >
              {term}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
