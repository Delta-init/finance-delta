"use client";

import type { ReactNode } from "react";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";
import { paneClick, paneHref } from "./split-view";

/**
 * A salesperson's name that opens their page (Reports → Salespeople → them) in the split pane (the user, 2026-11-07).
 * By their finance login (`userId` — what invoices, expenses and commission records hold) or by the people report's
 * own row id (`personId`). Ctrl/Cmd-click opens the page itself in a new tab. Plain text for anyone who can't read the
 * people report (payroll:read) — the page would only refuse them — and when there is nobody to open.
 */
export function SalespersonLink({ userId, personId, name, className, children }: {
  userId?: string | null;
  personId?: string | null;
  name?: string | null;
  className?: string;
  children?: ReactNode;
}) {
  const { can } = useCan();
  const id = personId || (userId ? `login-${userId}` : "");
  const label = children ?? name ?? "—";
  if (!id || !can("payroll:read")) return <span className={className}>{label}</span>;
  return (
    <a
      href={paneHref("salesperson", id)}
      onClick={paneClick("salesperson", id)}
      title={name ? `Open ${name}'s page beside this one` : "Open their page beside this one"}
      className={cn("cursor-pointer text-primary hover:underline", className)}
    >
      {label}
    </a>
  );
}
