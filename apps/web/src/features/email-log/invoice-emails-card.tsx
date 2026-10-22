"use client";

import { useState } from "react";
import { ChevronRight, Mail, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EMAIL_KIND_LABEL, useInvoiceEmails } from "./api";
import { EmailStateBadge } from "./state-badge";

const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
    : "—";

/**
 * Every email sent about this invoice — the first send, resends, reminders, the salesperson's copy. At the foot of
 * the invoice and folded to one line — how many, and the latest — until opened (the user, 2026-10-22). A latest one
 * that did not go says so, with Resend, without opening it.
 */
export function InvoiceEmailsCard({ invoiceId, onResend }: { invoiceId: string; onResend?: () => void }) {
  const emails = useInvoiceEmails(invoiceId);
  const [open, setOpen] = useState(false);
  if (emails.isError) return null; // an older finance server has no log yet
  const rows = emails.data ?? [];
  const latest = rows[0];
  const failed = rows.some((r) => r.state !== "sent") && latest?.state !== "sent";

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
        >
          <ChevronRight className={`h-4 w-4 shrink-0 text-foreground-muted transition-transform ${open ? "rotate-90" : ""}`} />
          <Mail className="h-4 w-4 shrink-0" />
          <span className="font-semibold">Emails</span>
          <span className="text-foreground-muted">{emails.isLoading ? "…" : rows.length}</span>
          {!open && latest && (
            <span className="flex min-w-0 items-center gap-2 text-xs text-foreground-muted">
              <span className="truncate">· latest: {EMAIL_KIND_LABEL[latest.kind] ?? latest.kind}, {when(latest.at)}</span>
              <EmailStateBadge row={latest} />
            </span>
          )}
        </button>
        {failed && onResend && (
          <Button variant="outline" size="sm" onClick={onResend}>
            <RotateCcw className="h-3.5 w-3.5" /> Resend
          </Button>
        )}
      </div>
      {open && (
      <div className="border-t border-border px-5 pb-3 pt-1">
      {emails.isLoading ? (
        <p className="text-sm text-foreground-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-foreground-muted">No email has been sent for this invoice yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{EMAIL_KIND_LABEL[r.kind] ?? r.kind}</p>
                <p className="truncate text-xs text-foreground-muted">
                  {r.to.length ? `To ${r.to.join(", ")}` : "No address"} · {when(r.at)} · {r.actorName}
                </p>
                {r.error && r.state !== "sent" && <p className="text-xs text-danger">{r.error}</p>}
              </div>
              <EmailStateBadge row={r} />
            </li>
          ))}
        </ul>
      )}
      </div>
      )}
    </div>
  );
}
