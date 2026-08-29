import { logoFor } from "@delta/shared";

/**
 * The logo at the head of a printed document.
 *
 * All four printables — invoice, credit note, quotation, payment receipt —
 * carried the same hand-rolled blue square with a Δ in it. One component, so a
 * change to the branding does not mean finding four copies, and so an invoice
 * and its credit note cannot end up looking like they came from two companies.
 *
 * Plain `<img>` rather than `next/image`: these pages are printed, and the
 * optimizer's lazy loading and srcset are a liability when the browser is
 * rasterising to PDF. A fixed height with `width: auto` keeps whatever aspect
 * ratio an organization's own logo happens to have.
 */
export function PrintBrandMark({
  branding,
  name = "Delta Finance",
  footerText,
}: {
  branding?: { logoUrl?: string | null } | null;
  /** The organization's name, shown under the logo. */
  name?: string;
  footerText?: string | null;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <img
        src={logoFor(branding)}
        alt={name}
        style={{ height: 34, width: "auto", maxWidth: 180, objectFit: "contain" }}
      />
      {footerText ? (
        <div style={{ fontSize: 12, color: "#64748b", maxWidth: 220 }}>{footerText}</div>
      ) : null}
    </div>
  );
}
