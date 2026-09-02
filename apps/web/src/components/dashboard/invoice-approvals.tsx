"use client";

import Link from "next/link";
import { ClipboardCheck, ArrowRight, GraduationCap } from "lucide-react";
import { MoneyDisplay } from "@/components/ui/money";
import { useInvoices } from "@/features/invoices/api";
import { useCan } from "@/lib/use-can";

/**
 * Invoices waiting on this approver.
 *
 * Until now an invoice held for approval could only be found by somebody who
 * already knew its number: the approval lives on the invoice, and nothing
 * anywhere listed which ones were waiting. So an enrolment sat pending until
 * the counsellor went and asked, which is the failure this exists to prevent.
 *
 * Links through to each invoice rather than approving here. The figures are on
 * the invoice, and a button that approves without them invites approving
 * without reading them.
 */
export function InvoiceApprovals() {
  const { can } = useCan();
  // Deciding is one permission and listing is another. Somebody who can only
  // read their own invoices is on the other side of this queue.
  const usable = can("invoice:write") && can("invoice:read");

  const { data, isLoading } = useInvoices(
    { approval: "pending", page: 1, pageSize: 5, sort: "createdAt", dir: "asc" },
    { enabled: usable },
  );

  if (!usable || isLoading) return null;
  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  if (total === 0) return null;

  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5">
      <div className="flex items-center gap-2 border-b border-warning/20 px-5 py-3">
        <ClipboardCheck className="h-4 w-4 text-warning" />
        <h2 className="text-sm font-semibold">
          {total === 1 ? "1 invoice needs your approval" : `${total} invoices need your approval`}
        </h2>
        <Link
          href="/approvals"
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          See all <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <ul className="divide-y divide-warning/20">
        {rows.map((inv) => (
          <li key={inv.id}>
            <Link
              href={`/invoices/${inv.id}`}
              className="flex items-center gap-3 px-5 py-3 hover:bg-warning/5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{inv.customerName}</p>
                <p className="flex items-center gap-1.5 truncate text-xs text-foreground-muted">
                  {inv.enrolment?.course && (
                    <>
                      <GraduationCap className="h-3 w-3" />
                      {inv.enrolment.course} ·{" "}
                    </>
                  )}
                  {inv.invoiceNumber} · raised by {inv.salespersonName}
                </p>
              </div>
              <MoneyDisplay minor={inv.totalMinor} currency={inv.currency} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
