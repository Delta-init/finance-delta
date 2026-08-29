"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ReceiptText, FileText, Plus, ArrowRight, Clock, CheckCircle2, XCircle } from "lucide-react";
import type { Expense } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { useExpenses } from "@/features/expenses/api";
import { useInvoices } from "@/features/invoices/api";
import { useCan } from "@/lib/use-can";
import { PendingApprovals } from "@/components/dashboard/pending-approvals";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral",
  submitted: "warning",
  approved: "success",
  rejected: "danger",
  voided: "neutral",
};

/**
 * What somebody sees when the company overview is not theirs to look at.
 *
 * The dashboard is revenue, receivables and aging — a finance screen. Anybody
 * whose access is limited to their own records would get a page of refusals,
 * so they get their own work instead: what they have claimed, and where it has
 * got to.
 */
export function MyWorkspace({ name }: { name: string }) {
  const router = useRouter();
  const { can } = useCan();
  const canExpense = can("expense:write:own") || can("expense:create");
  const canInvoice = can("invoice:write:own") || can("invoice:write");

  const { data: expenses, isLoading: loadingExpenses } = useExpenses({
    page: 1,
    pageSize: 5,
    sort: "createdAt",
    dir: "desc",
  });
  const { data: invoices } = useInvoices({ page: 1, pageSize: 5, sort: "createdAt", dir: "desc" });

  const rows = expenses?.data ?? [];
  const counts = rows.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Welcome back, {name} 👋</h1>
          <p className="mt-0.5 text-sm text-foreground-muted">
            Your claims and your invoices. Nothing here is shared with anybody but an approver.
          </p>
        </div>
        <div className="flex gap-2">
          {canExpense && (
            <Button size="sm" onClick={() => router.push("/expenses/new")}>
              <Plus className="h-4 w-4" /> New claim
            </Button>
          )}
          {canInvoice && (
            <Button size="sm" variant="outline" onClick={() => router.push("/invoices/new")}>
              <Plus className="h-4 w-4" /> New invoice
            </Button>
          )}
        </div>
      </div>

      {/* An approver on a narrow role lands here too, and the queue is the
          reason they have an account. */}
      <PendingApprovals />

      {/* Where their claims have got to. Only the states that mean something
          to the claimant — a count of drafts they have forgotten to send is
          the single most useful thing this page can tell them. */}
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { key: "draft", label: "Not yet sent", icon: Clock, tone: "text-foreground-muted" },
          { key: "submitted", label: "Waiting on approval", icon: Clock, tone: "text-warning" },
          { key: "rejected", label: "Sent back to you", icon: XCircle, tone: "text-danger" },
        ].map((s) => (
          <div key={s.key} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-foreground-muted">
              <s.icon className={`h-3.5 w-3.5 ${s.tone}`} /> {s.label}
            </div>
            <p className="mt-2 text-2xl font-semibold">{counts[s.key] ?? 0}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Your recent claims"
          icon={ReceiptText}
          href="/expenses"
          empty={
            loadingExpenses
              ? "Loading…"
              : canExpense
                ? "You haven't claimed anything yet. Start one and attach the receipt."
                : "You haven't claimed anything yet."
          }
          rows={rows.map((e: Expense) => ({
            id: e.id,
            href: `/expenses/${e.id}`,
            label: e.description,
            sub: new Date(e.expenseDate).toLocaleDateString(),
            right: (
              <div className="flex items-center gap-2">
                <MoneyDisplay minor={e.totalMinor} currency={e.currency} />
                <Badge tone={STATUS_TONE[e.status] ?? "neutral"}>{e.status}</Badge>
              </div>
            ),
          }))}
        />

        {canInvoice && (
          <Panel
            title="Your recent invoices"
            icon={FileText}
            href="/invoices"
            empty="You haven't raised an invoice yet."
            rows={(invoices?.data ?? []).map((inv) => ({
              id: inv.id,
              href: `/invoices/${inv.id}`,
              label: inv.customerName,
              sub: inv.invoiceNumber,
              right: (
                <div className="flex items-center gap-2">
                  <MoneyDisplay minor={inv.totalMinor} currency={inv.currency} />
                  <Badge tone={inv.status === "paid" ? "success" : "neutral"}>{inv.status}</Badge>
                </div>
              ),
            }))}
          />
        )}
      </div>
    </div>
  );
}

function Panel({
  title,
  icon: Icon,
  href,
  rows,
  empty,
}: {
  title: string;
  icon: typeof ReceiptText;
  href: string;
  rows: { id: string; href: string; label: string; sub: string; right: React.ReactNode }[];
  empty: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Icon className="h-4 w-4 text-foreground-muted" />
        <h2 className="text-sm font-semibold">{title}</h2>
        <Link
          href={href}
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          See all <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-foreground-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={r.href} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-muted/50">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.label}</p>
                  <p className="text-xs text-foreground-muted">{r.sub}</p>
                </div>
                {r.right}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Nothing at all is theirs to see — a role with no read permissions yet. */
export function NoAccessYet({ name }: { name: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-muted">
        <CheckCircle2 className="h-7 w-7 text-foreground-subtle" />
      </div>
      <div>
        <h1 className="text-xl font-semibold">You&rsquo;re signed in, {name}</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-foreground-muted">
          Your account doesn&rsquo;t have access to anything yet. Ask an administrator to give you a
          role — until then there is nothing here for you to see.
        </p>
      </div>
    </div>
  );
}
