"use client";

import { Mail, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EMAIL_KIND_LABEL, useInvoiceEmails } from "./api";
import { EmailStateBadge } from "./state-badge";

const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
    : "—";

/** Every email sent about this invoice — the first send, resends, reminders, the salesperson's copy. */
export function InvoiceEmailsCard({ invoiceId, onResend }: { invoiceId: string; onResend?: () => void }) {
  const emails = useInvoiceEmails(invoiceId);
  if (emails.isError) return null; // an older finance server has no log yet
  const rows = emails.data ?? [];
  const failed = rows.some((r) => r.state !== "sent") && rows[0]?.state !== "sent";

  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Mail className="h-4 w-4" /> Emails <span className="font-normal text-foreground-muted">{rows.length}</span>
        </h3>
        {failed && onResend && (
          <Button variant="outline" size="sm" onClick={onResend}>
            <RotateCcw className="h-3.5 w-3.5" /> Resend
          </Button>
        )}
      </div>
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
  );
}
