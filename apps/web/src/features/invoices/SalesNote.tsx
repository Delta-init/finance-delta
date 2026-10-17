"use client";

import { MessageSquareText } from "lucide-react";

/**
 * The note the sales person wrote at the close (the owner, 2026-10-17), kept
 * up to date from the CRM. For the people here only: it is never printed on
 * the client's invoice — the invoice's own Notes are.
 */
export function SalesNote({ note, updatedAt }: { note?: string; updatedAt?: string }) {
  if (!note) return null;
  const when = updatedAt
    ? new Date(updatedAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" })
    : null;
  return (
    <div className="rounded-lg border border-primary/30 bg-primary-50 p-3">
      <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-foreground">
        <MessageSquareText className="h-3.5 w-3.5 text-primary-600" />
        Note from sales
        <span className="font-normal text-foreground-muted">
          · internal, not on the client&apos;s invoice{when ? ` · updated ${when}` : ""}
        </span>
      </p>
      <p className="whitespace-pre-wrap break-words text-sm">{note}</p>
    </div>
  );
}
