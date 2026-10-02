"use client";

import { useEffect, useMemo, useState } from "react";
import { DELTA_LOGO_WEB } from "@delta/shared";

/**
 * The logo at the head of a printed document.
 *
 * All four printables — invoice, credit note, quotation, payment receipt —
 * carried the same hand-rolled blue square with a Δ in it. One component, so a
 * change to the branding does not mean finding four copies, and so an invoice
 * and its credit note cannot end up looking like they came from two companies.
 *
 * Which logo: the document's own, where it kept one when it was made; else the
 * organization's now, so a document made before there was a logo does not go
 * out without one; else Delta's. And the next of those whenever one will not
 * load, so a broken link never leaves a blank where the logo goes.
 *
 * Plain `<img>` rather than `next/image`: these pages are printed, and the
 * optimizer's lazy loading and srcset are a liability when the browser is
 * rasterising to PDF. A fixed height with `width: auto` keeps whatever aspect
 * ratio an organization's own logo happens to have.
 */
export function PrintBrandMark({
  branding,
  fallbackBranding,
  name = "Delta Finance",
  footerText,
}: {
  branding?: { logoUrl?: string | null } | null;
  /** The organization's branding now, for a document made before it had a logo. */
  fallbackBranding?: { logoUrl?: string | null } | null;
  /** The organization's name, shown under the logo. */
  name?: string;
  footerText?: string | null;
}) {
  const sources = useMemo(
    () => [...new Set([branding?.logoUrl, fallbackBranding?.logoUrl, DELTA_LOGO_WEB].map((s) => (s ?? "").trim()).filter(Boolean))],
    [branding?.logoUrl, fallbackBranding?.logoUrl],
  );
  const [at, setAt] = useState(0);
  const key = sources.join("|");
  useEffect(() => setAt(0), [key]);
  const src = sources[Math.min(at, sources.length - 1)];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <img
        src={src}
        alt={name}
        onError={() => setAt((i) => (i < sources.length - 1 ? i + 1 : i))}
        style={{ height: 34, width: "auto", maxWidth: 180, objectFit: "contain" }}
      />
      {footerText ? (
        <div style={{ fontSize: 12, color: "#64748b", maxWidth: 220 }}>{footerText}</div>
      ) : null}
    </div>
  );
}
