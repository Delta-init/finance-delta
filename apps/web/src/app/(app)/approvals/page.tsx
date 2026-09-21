"use client";

import { useRouter } from "next/navigation";
import { ClipboardCheck, GraduationCap, Undo2 } from "lucide-react";
import { describeOverdue, formatMoney, type Invoice } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { MoneyDisplay } from "@/components/ui/money";
import { useTableQuery } from "@/lib/use-table-query";
import { useCan } from "@/lib/use-can";
import { useInvoices } from "@/features/invoices/api";

/**
 * Everything waiting on an approver, in one place.
 *
 * The queue used to exist only as a filter somebody had to know to apply, so an
 * enrolment sat pending until the counsellor went and asked about it — which is
 * the failure the approval step was meant to prevent rather than cause.
 *
 * Sent-back work is here too. It is not waiting on an approver, but it is the
 * other half of the same queue: something an approver has already looked at and
 * is expecting to see again.
 */
export default function ApprovalsPage() {
  const router = useRouter();
  const { can } = useCan();
  /* Newest first, in both lists.
   *
   * Asked for, and worth naming the cost: a queue read oldest-first puts the
   * thing that has waited longest where somebody will see it, and this ordering
   * sinks it to the bottom instead. The "waiting 6 days" line on each row is
   * what now carries that, so nothing is hidden — it just has to be read rather
   * than met at the top. */
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });

  // Deciding is one permission and reading the queue is another. Somebody who
  // only sees their own invoices is on the far side of this.
  const usable = can("invoice:write") && can("invoice:read");

  const waiting = useInvoices(
    { ...t.baseParams, approval: "pending" },
    { enabled: usable },
  );
  const returned = useInvoices(
    { page: 1, pageSize: 50, sort: "createdAt", dir: "desc", approval: "returned" },
    { enabled: usable },
  );

  if (!usable) {
    return (
      <div className="p-6 text-sm text-foreground-muted">
        Approving invoices is not something your role does.
      </div>
    );
  }

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
        inv.approval?.submittedAt ? (
          <span className="text-foreground-muted">
            {describeOverdue(inv.approval.submittedAt.slice(0, 10))
              .replace("days late", "days ago")
              .replace("1 day late", "yesterday")
              .replace("due today", "today")}
          </span>
        ) : (
          "—"
        ),
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
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader
        icon={ClipboardCheck}
        title="Approvals"
        description="Invoices waiting on a decision, and the ones sent back for correcting."
      />

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
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Waiting for you</h2>
          {(waiting.data?.meta.total ?? 0) > 0 && (
            <Badge tone="warning">{waiting.data?.meta.total}</Badge>
          )}
        </div>
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
