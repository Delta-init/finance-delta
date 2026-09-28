"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { ArrowRight, ClipboardCheck, GraduationCap, Undo2, WalletCards } from "lucide-react";
import { describeOverdue, type ApprovalGroup, type FundingRequest, type Invoice } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { MoneyDisplay } from "@/components/ui/money";
import { useTableQuery } from "@/lib/use-table-query";
import { useCan } from "@/lib/use-can";
import { useInvoices } from "@/features/invoices/api";
import { useFundingRequests } from "@/features/budgets/api";
import { FundingRequestTags, FundingReviewDialog, periodLabel } from "@/features/budgets/review-dialog";
import { useApprovalSummary } from "@/features/approvals/api";

/**
 * Everything waiting on an approver, in one place — every kind, not only
 * invoices.
 *
 * Fund requests are decided right here, with the same dialog Budgets uses: it
 * shows everything a decision needs, including what the department has left.
 * Claims, bills, payroll and purchase requests are listed and linked instead,
 * because what a decision on them needs — the receipt, the figures — is on
 * their own pages.
 *
 * Sent-back invoices are here too. They are not waiting on an approver, but
 * they are the other half of the same queue: something an approver has already
 * looked at and is expecting to see again.
 */

const ago = (iso?: string) =>
  iso
    ? describeOverdue(iso.slice(0, 10))
        .replace("days late", "days ago")
        .replace("1 day late", "yesterday")
        .replace("due today", "today")
    : "";

function SectionTitle({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {(count ?? 0) > 0 && <Badge tone="warning">{count}</Badge>}
    </div>
  );
}

/** Newest fund requests waiting for review, decided on this page. */
function FundRequestQueue() {
  const { data: session } = useSession();
  const myId = session?.user?.id;
  const [reviewTarget, setReviewTarget] = useState<FundingRequest | null>(null);
  const { data, isLoading } = useFundingRequests({});
  const waiting = useMemo(
    () => (data?.data ?? []).filter((r) => r.status === "submitted").sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    [data],
  );

  return (
    <div className="space-y-2">
      <SectionTitle title="Fund requests" count={waiting.filter((r) => r.requestedById !== myId).length} />
      <Card className="overflow-hidden">
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-foreground-muted">Loading…</p>
        ) : waiting.length === 0 ? (
          <p className="px-5 py-6 text-sm text-foreground-muted">No fund requests waiting.</p>
        ) : (
          <ul className="divide-y divide-border">
            {waiting.map((r) => {
              // Nobody approves their own: it waits for somebody else.
              const own = r.requestedById === myId;
              return (
                <li key={r.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{r.departmentName} · {r.title}</p>
                    <FundingRequestTags request={r} />
                    <p className="mt-1 line-clamp-2 text-xs text-foreground-muted">{r.purpose}</p>
                    <p className="mt-1 text-xs text-foreground-muted">
                      {periodLabel(r.period)} · {r.requestedByName} · {ago(r.requestedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center justify-between gap-3 sm:flex-col sm:items-end">
                    <MoneyDisplay minor={r.amountMinor} currency={r.currency} className="font-semibold" />
                    {own ? (
                      <span className="text-xs text-foreground-muted">Your own — someone else reviews it</span>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setReviewTarget(r)}>Review</Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <FundingReviewDialog request={reviewTarget} onClose={() => setReviewTarget(null)} />
    </div>
  );
}

/** Enrolment invoices waiting on a decision, and the ones sent back. */
function InvoiceQueue() {
  const router = useRouter();
  /* Newest first, in both lists.
   *
   * Asked for, and worth naming the cost: a queue read oldest-first puts the
   * thing that has waited longest where somebody will see it, and this ordering
   * sinks it to the bottom instead. The "waiting 6 days" line on each row is
   * what now carries that, so nothing is hidden — it just has to be read rather
   * than met at the top. */
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  const waiting = useInvoices({ ...t.baseParams, approval: "pending" });
  const returned = useInvoices({ page: 1, pageSize: 50, sort: "createdAt", dir: "desc", approval: "returned" });

  const columns: Column<Invoice>[] = [
    {
      key: "customer",
      header: "Client",
      cell: (inv) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{inv.customerName}</p>
          <p className="flex items-center gap-1 truncate text-xs text-foreground-muted">
            {inv.enrolment?.course ? (
              <>
                <GraduationCap className="h-3 w-3" />
                {inv.enrolment.course}
              </>
            ) : (
              inv.invoiceNumber
            )}
          </p>
        </div>
      ),
    },
    { key: "number", header: "Number", cell: (inv) => inv.invoiceNumber },
    { key: "salesperson", header: "Raised by", cell: (inv) => inv.salespersonName },
    {
      key: "waiting",
      header: "Submitted",
      cell: (inv) =>
        inv.approval?.submittedAt ? <span className="text-foreground-muted">{ago(inv.approval.submittedAt)}</span> : "—",
    },
    {
      key: "total",
      header: "Amount",
      align: "right",
      cell: (inv) => <MoneyDisplay minor={inv.totalMinor} currency={inv.currency} />,
    },
  ];

  const returnedRows = returned.data?.data ?? [];

  return (
    <div className="space-y-3">
      {returnedRows.length > 0 && (
        <div className="rounded-lg border border-danger/30 bg-danger/5">
          <div className="flex items-center gap-2 border-b border-danger/20 px-5 py-3">
            <Undo2 className="h-4 w-4 text-danger" />
            <h2 className="text-sm font-semibold">
              {returnedRows.length === 1
                ? "1 sent back and not yet corrected"
                : `${returnedRows.length} sent back and not yet corrected`}
            </h2>
          </div>
          <ul className="divide-y divide-danger/20">
            {returnedRows.map((inv) => (
              <li key={inv.id}>
                <button
                  type="button"
                  onClick={() => router.push(`/invoices/${inv.id}`)}
                  className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-danger/5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{inv.customerName}</p>
                    <p className="truncate text-xs text-foreground-muted">
                      {inv.invoiceNumber} · {inv.salespersonName}
                      {inv.approval?.returnedReason ? ` · ${inv.approval.returnedReason}` : ""}
                    </p>
                  </div>
                  <MoneyDisplay minor={inv.totalMinor} currency={inv.currency} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <SectionTitle title="Enrolment invoices" count={waiting.data?.meta.total} />
        <DataTable
          columns={columns}
          data={waiting.data?.data ?? []}
          getRowId={(inv) => inv.id}
          total={waiting.data?.meta.total ?? 0}
          page={t.page}
          pageSize={t.pageSize}
          sort={t.sort}
          onPageChange={t.setPage}
          onPageSizeChange={t.setPageSize}
          onSortChange={t.handleSort}
          onRowClick={(inv) => router.push(`/invoices/${inv.id}`)}
          isLoading={waiting.isLoading}
          emptyMessage={
            returnedRows.length > 0
              ? "Nothing waiting on you. The ones above are with whoever raised them."
              : "Nothing waiting. Every invoice that needed a decision has had one."
          }
        />
      </div>
    </div>
  );
}

/** Claims, bills, payroll runs and purchase requests: the newest few, each linked to where it is decided. */
function LinkedQueue({ group }: { group: ApprovalGroup }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <SectionTitle title={group.label} count={group.count} />
        {group.count > group.items.length && (
          <Link href={group.href} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            See all {group.count} <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      <Card className="overflow-hidden">
        {group.unavailable ? (
          <p className="px-5 py-6 text-sm text-foreground-muted">Could not be read just now — {group.unavailable}. It will be tried again shortly.</p>
        ) : group.items.length === 0 ? (
          <p className="px-5 py-6 text-sm text-foreground-muted">Nothing waiting.</p>
        ) : (
          <ul className="divide-y divide-border">
            {group.items.map((item) => (
              <li key={item.id}>
                <Link href={item.href} className="flex items-center gap-3 px-5 py-2.5 hover:bg-surface-muted/60">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="truncate text-xs text-foreground-muted">
                      {item.subtitle}
                      {item.at ? ` · ${ago(item.at)}` : ""}
                    </p>
                  </div>
                  {item.amountMinor !== undefined && (
                    <MoneyDisplay minor={item.amountMinor} currency={item.currency ?? "AED"} />
                  )}
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function ApprovalsPage() {
  const { can } = useCan();
  const invoices = can("invoice:write") && can("invoice:read");
  const funds = can("budget:approve");
  const approver = invoices || funds || can("expense:approve") || can("bill:approve") || can("payroll:approve") || can("po:create");
  const { data: summary } = useApprovalSummary(approver);

  if (!approver) {
    return (
      <div className="p-6 text-sm text-foreground-muted">
        Approving is not something your role does.
      </div>
    );
  }

  const linked = (summary?.groups ?? []).filter((g) => g.type !== "invoice" && g.type !== "fund_request");

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader
        icon={ClipboardCheck}
        title="Approvals"
        description="Everything waiting on your decision — fund requests, enrolment invoices, claims, bills, payroll and purchase requests — newest first."
      />

      {summary && summary.total === 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-foreground-muted">
          <WalletCards className="h-4 w-4" /> Nothing is waiting on you right now.
        </div>
      )}

      {funds && <FundRequestQueue />}
      {invoices && <InvoiceQueue />}
      {linked.map((group) => <LinkedQueue key={group.type} group={group} />)}
    </div>
  );
}
