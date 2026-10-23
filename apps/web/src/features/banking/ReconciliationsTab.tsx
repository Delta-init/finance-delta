"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ReconciliationSession } from "@delta/shared";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { MoneyDisplay } from "@/components/ui/money";
import { useReconciliationLines, useReconciliations } from "./api";

/*
 * Every reconciliation of a bank account (the user, 2026-10-23: "list all the bank reconciliations in a separate tab
 * on the bank's page"), newest first: its period, statement date, opening and closing balances, lines ticked, the
 * difference, whether it is open or completed and by whom. An open one goes on in Reconcile; a completed one shows the
 * lines it reconciled, with their statement dates.
 */
export function ReconciliationsTab({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const { data, isLoading } = useReconciliations(accountId, { page, pageSize });
  const [viewing, setViewing] = useState<ReconciliationSession | null>(null);

  const columns: Column<ReconciliationSession>[] = [
    {
      key: "period",
      header: "Period",
      cell: (s) => (s.periodFrom && s.periodTo ? <span className="whitespace-nowrap">{s.periodFrom} → {s.periodTo}</span> : <span className="text-foreground-subtle">—</span>),
    },
    { key: "statementDate", header: "Statement date", cell: (s) => <span className="text-foreground-muted">{s.statementDate}</span> },
    { key: "opening", header: "Opening", align: "right", cell: (s) => <MoneyDisplay minor={s.openingBookBalanceMinor} currency={s.currency} /> },
    { key: "closing", header: "Closing (statement)", align: "right", cell: (s) => <MoneyDisplay minor={s.statementBalanceMinor} currency={s.currency} className="font-medium" /> },
    { key: "lines", header: "Lines", align: "right", cell: (s) => <span className="tabular-nums">{s.reconciledTransactionIds.length}</span> },
    {
      key: "difference",
      header: "Difference",
      align: "right",
      cell: (s) => (s.differenceMinor === 0
        ? <span className="font-medium text-success">Balanced</span>
        : <MoneyDisplay minor={s.differenceMinor} currency={s.currency} className="font-medium text-danger" />),
    },
    {
      key: "status",
      header: "Status",
      cell: (s) => (s.status === "open" ? <Badge tone="warning">Open</Badge> : <Badge tone="success">Completed</Badge>),
    },
    {
      key: "completed",
      header: "Completed",
      cell: (s) => (s.completedAt
        ? <span className="text-xs text-foreground-muted">{s.completedByName ?? "—"} · {s.completedAt.slice(0, 10)}</span>
        : <span className="text-foreground-subtle">—</span>),
    },
    { key: "notes", header: "Notes", cell: (s) => <span className="block max-w-[220px] truncate text-xs text-foreground-muted" title={s.notes}>{s.notes || "—"}</span> },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(s) => s.id}
        total={data?.meta.total ?? 0}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
        onRowClick={(s) => (s.status === "open" ? router.push(`/banking/${accountId}/reconcile`) : setViewing(s))}
        isLoading={isLoading}
        emptyMessage="This account hasn't been reconciled yet — use Reconcile above."
      />
      {viewing && <ReconciledLines accountId={accountId} session={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

/** A completed reconciliation's lines: date, statement date, description and amount, with the money in and out. */
function ReconciledLines({ accountId, session, onClose }: { accountId: string; session: ReconciliationSession; onClose: () => void }) {
  const { data: lines, isLoading, error } = useReconciliationLines(accountId, session.id, false, { tickedOnly: true });
  const rows = lines ?? [];
  const out = rows.reduce((n, l) => n + (l.amountMinor < 0 ? -l.amountMinor : 0), 0);
  const into = rows.reduce((n, l) => n + (l.amountMinor > 0 ? l.amountMinor : 0), 0);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Reconciled {session.periodFrom && session.periodTo ? `${session.periodFrom} → ${session.periodTo}` : `to ${session.statementDate}`}</DialogTitle>
          <DialogDescription>
            {rows.length} lines · out <MoneyDisplay minor={out} currency={session.currency} /> · in <MoneyDisplay minor={into} currency={session.currency} /> · closing{" "}
            <MoneyDisplay minor={session.statementBalanceMinor} currency={session.currency} />
            {session.completedByName ? ` · by ${session.completedByName}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-muted">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-foreground-muted">Date</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-foreground-muted">Statement date</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-foreground-muted">Description</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-foreground-muted">Amount</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={4} className="px-3 py-6 text-center text-foreground-muted">Loading…</td></tr>}
              {error && <tr><td colSpan={4} className="px-3 py-6 text-center text-danger">{(error as Error).message || "The lines didn't load"}</td></tr>}
              {!isLoading && !error && rows.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-foreground-muted">No lines.</td></tr>}
              {rows.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2 text-foreground-muted">{l.date}</td>
                  <td className="px-3 py-2">{l.statementDate ?? <span className="text-foreground-subtle">—</span>}</td>
                  <td className="px-3 py-2">
                    <p className="max-w-sm truncate">{l.description}</p>
                    {l.reference && <p className="text-xs text-foreground-muted">{l.reference}</p>}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono ${l.amountMinor >= 0 ? "text-success" : "text-danger"}`}>
                    {l.amountMinor >= 0 ? "+" : ""}{(l.amountMinor / 100).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
