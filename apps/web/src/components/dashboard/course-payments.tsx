"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, Clock, GraduationCap, HandCoins, Undo2 } from "lucide-react";
import { formatMoney, describeOverdue, type MoneyByCurrency } from "@delta/shared";
import { MoneyDisplay } from "@/components/ui/money";
import { useInvoices, useInvoiceSummary } from "@/features/invoices/api";

/**
 * What a counsellor is still owed, and what is stuck with them.
 *
 * The screen they landed on counted expense claims, which somebody taking
 * enrolments cannot file — so it showed three zeroes and told them nothing.
 * These are the four things that actually decide their day.
 *
 * Figures come from an aggregate over all their invoices rather than from a
 * page of results: the counsellor with two hundred enrolments is precisely the
 * one for whom a page would under-report.
 */
export function CoursePayments() {
  const { data: summary, isLoading } = useInvoiceSummary();

  // Oldest due first: the one nobody has chased for longest is the one to ring.
  const { data: unpaid } = useInvoices({
    status: "overdue",
    page: 1,
    pageSize: 6,
    sort: "due",
    dir: "asc",
  });

  if (isLoading || !summary) return null;

  const rows = unpaid?.data ?? [];
  const nothing =
    summary.outstanding.length === 0 &&
    summary.collectedNotRecorded.length === 0 &&
    summary.awaitingApproval === 0 &&
    summary.returned === 0;

  if (nothing) return null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MoneyCard
          label="Still owed on your courses"
          icon={GraduationCap}
          amounts={summary.outstanding}
        />
        <MoneyCard label="Overdue" icon={AlertTriangle} amounts={summary.overdue} tone="danger" />
        <MoneyCard
          label="Collected, not yet recorded"
          icon={HandCoins}
          amounts={summary.collectedNotRecorded}
          hint="Accounts records these. Nothing for you to do."
        />
        <CountCard
          label={summary.returned > 0 ? "Sent back to you" : "Waiting for approval"}
          icon={summary.returned > 0 ? Undo2 : Clock}
          count={summary.returned > 0 ? summary.returned : summary.awaitingApproval}
          tone={summary.returned > 0 ? "danger" : "warning"}
          hint={
            summary.returned > 0
              ? "Correct these and submit them again."
              : "An approver has to look before these can go out."
          }
        />
      </div>

      {rows.length > 0 && (
        <div className="rounded-lg border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3">
            <AlertTriangle className="h-4 w-4 text-danger" />
            <h2 className="text-sm font-semibold">Courses awaiting payment</h2>
            <Link
              href="/invoices?status=overdue"
              className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              See all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <ul className="divide-y divide-border">
            {rows.map((inv) => (
              <li key={inv.id}>
                <Link
                  href={`/invoices/${inv.id}`}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-surface-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{inv.customerName}</p>
                    <p className="truncate text-xs text-foreground-muted">
                      {inv.enrolment?.course ? `${inv.enrolment.course} · ` : ""}
                      {inv.invoiceNumber} · {describeOverdue(inv.dueDate)}
                    </p>
                  </div>
                  <div className="text-right">
                    <MoneyDisplay
                      minor={inv.balanceMinor}
                      currency={inv.currency}
                      className="font-semibold text-danger"
                    />
                    {inv.amountPaidMinor > 0 && (
                      <p className="text-[11px] text-foreground-muted">
                        {formatMoney(inv.amountPaidMinor, inv.currency)} of{" "}
                        {formatMoney(inv.totalMinor, inv.currency)} paid
                      </p>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MoneyCard({
  label,
  icon: Icon,
  amounts,
  tone,
  hint,
}: {
  label: string;
  icon: typeof GraduationCap;
  amounts: MoneyByCurrency[];
  tone?: "danger";
  hint?: string;
}) {
  // Nothing owed is worth saying plainly rather than leaving a blank card.
  const empty = amounts.length === 0;
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-foreground-muted">
        <Icon className={`h-3.5 w-3.5 ${tone === "danger" ? "text-danger" : ""}`} /> {label}
      </div>
      {empty ? (
        <p className="mt-2 text-2xl font-semibold text-foreground-subtle">—</p>
      ) : (
        <div className="mt-2 space-y-0.5">
          {/* One line per currency. Adding dirhams to rupees would not be a
              rounder number, it would be a wrong one. */}
          {amounts.map((a) => (
            <div key={a.currency} className="flex items-baseline gap-2">
              <span className={`text-2xl font-semibold ${tone === "danger" ? "text-danger" : ""}`}>
                {formatMoney(a.minor, a.currency)}
              </span>
              <span className="text-xs text-foreground-muted">
                {a.count} {a.count === 1 ? "student" : "students"}
              </span>
            </div>
          ))}
        </div>
      )}
      {hint && !empty && <p className="mt-1.5 text-[11px] text-foreground-muted">{hint}</p>}
    </div>
  );
}

function CountCard({
  label,
  icon: Icon,
  count,
  tone,
  hint,
}: {
  label: string;
  icon: typeof Clock;
  count: number;
  tone: "danger" | "warning";
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-foreground-muted">
        <Icon className={`h-3.5 w-3.5 ${tone === "danger" ? "text-danger" : "text-warning"}`} /> {label}
      </div>
      <p className={`mt-2 text-2xl font-semibold ${count > 0 && tone === "danger" ? "text-danger" : ""}`}>
        {count}
      </p>
      {count > 0 && <p className="mt-1.5 text-[11px] text-foreground-muted">{hint}</p>}
    </div>
  );
}
