"use client";

import { useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { EditReconciliationInput, ReconciliationSession } from "@delta/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { useDeleteReconciliation, useEditReconciliation, useReconciliationLines, useReconciliations, useReopenReconciliation } from "./api";

/*
 * Every reconciliation of a bank account (the user, 2026-10-23: "list all the bank reconciliations in a separate tab
 * on the bank's page"), newest first: its period, statement date, opening and closing balances, lines ticked, the
 * difference, whether it is open or completed and by whom. An open one goes on in Reconcile; a completed one shows the
 * lines it reconciled, with their statement dates.
 *
 * Edit, reopen and delete (2026-10-23): an open one's period and figures can be changed, or it can be deleted; a
 * completed one's notes can be changed, and the latest completed one can be reopened (to fix its figures or ticks) or
 * deleted (undone: its lines unreconciled, their statement dates cleared). An older one can't — the one after it opens
 * at its closing balance.
 */
export function ReconciliationsTab({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const { data, isLoading } = useReconciliations(accountId, { page, pageSize });
  const [viewing, setViewing] = useState<ReconciliationSession | null>(null);
  const { can } = useCan();
  const canReconcile = can("banking:reconcile");
  const [editing, setEditing] = useState<ReconciliationSession | null>(null);
  const [reopening, setReopening] = useState<ReconciliationSession | null>(null);
  const [deleting, setDeleting] = useState<ReconciliationSession | null>(null);
  const act = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn(); };
  const lockedWhy = "Only the latest completed reconciliation can be reopened or deleted";

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
    ...(canReconcile ? [{
      key: "actions",
      header: "",
      align: "right" as const,
      cell: (s: ReconciliationSession) => {
        const locked = s.status === "completed" && !s.undoable;
        return (
          <div className="flex items-center justify-end gap-3">
            <button type="button" onClick={act(() => setEditing(s))} className="text-foreground-subtle hover:text-primary" title={s.status === "open" ? "Edit" : "Edit notes"} aria-label="Edit">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            {s.status === "completed" && (
              <button type="button" disabled={locked} onClick={act(() => setReopening(s))} className="text-foreground-subtle hover:text-primary disabled:cursor-not-allowed disabled:opacity-40" title={locked ? lockedWhy : "Reopen"} aria-label="Reopen">
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
            <button type="button" disabled={locked} onClick={act(() => setDeleting(s))} className="text-foreground-subtle hover:text-danger disabled:cursor-not-allowed disabled:opacity-40" title={locked ? lockedWhy : "Delete"} aria-label="Delete">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      },
    }] : []),
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
      {editing && <EditReconciliation accountId={accountId} session={editing} onClose={() => setEditing(null)} />}
      {reopening && (
        <ReopenReconciliation
          accountId={accountId}
          session={reopening}
          onClose={() => setReopening(null)}
          onReopened={() => { setReopening(null); router.push(`/banking/${accountId}/reconcile`); }}
        />
      )}
      {deleting && <DeleteReconciliation accountId={accountId} session={deleting} onClose={() => setDeleting(null)} />}
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

const periodOf = (s: ReconciliationSession) => (s.periodFrom && s.periodTo ? `${s.periodFrom} → ${s.periodTo}` : `to ${s.statementDate}`);
const toDisplay = (minor: number) => (minor / 100).toFixed(2);
const toMinor = (v: string) => Math.round((parseFloat(v) || 0) * 100);
const failed = (e: unknown, fallback: string) => toast.error(e instanceof ApiError ? e.message : fallback);

/**
 * Edit: an open reconciliation's period, statement date, opening and closing balances and notes — only what changed is
 * sent, and the server checks it as it checks a new one. A completed one: its notes.
 */
function EditReconciliation({ accountId, session, onClose }: { accountId: string; session: ReconciliationSession; onClose: () => void }) {
  const edit = useEditReconciliation(accountId);
  const isOpen = session.status === "open";
  const [from, setFrom] = useState(session.periodFrom ?? "");
  const [to, setTo] = useState(session.periodTo ?? "");
  const [statementDate, setStatementDate] = useState(session.statementDate);
  const [opening, setOpening] = useState(toDisplay(session.openingBookBalanceMinor));
  const [closing, setClosing] = useState(toDisplay(session.statementBalanceMinor));
  const [notes, setNotes] = useState(session.notes ?? "");

  async function save() {
    const input: EditReconciliationInput = {};
    if (notes !== (session.notes ?? "")) input.notes = notes;
    if (isOpen) {
      if ((from || to) && (from !== (session.periodFrom ?? "") || to !== (session.periodTo ?? ""))) { input.periodFrom = from; input.periodTo = to; }
      if (statementDate !== session.statementDate) input.statementDate = statementDate;
      if (toMinor(opening) !== session.openingBookBalanceMinor) input.openingBalanceMinor = toMinor(opening);
      if (toMinor(closing) !== session.statementBalanceMinor) input.statementBalanceMinor = toMinor(closing);
    }
    if (!Object.keys(input).length) return onClose();
    try {
      const saved = await edit.mutateAsync({ sessionId: session.id, input });
      toast.success(saved.status === "open" && saved.differenceMinor !== 0 ? "Saved — the difference is now worked out again" : "Saved");
      onClose();
    } catch (e) {
      failed(e, "Could not save the reconciliation");
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit reconciliation {periodOf(session)}</DialogTitle>
          <DialogDescription>
            {isOpen
              ? "Change its period, statement date or balances. The difference is worked out again from the lines you ticked."
              : session.undoable
                ? "It is completed, so only its notes can change. To change its period or figures, reopen it."
                : "It is completed, so only its notes can change."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {isOpen && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="editFrom">Period from</Label>
                  <Input id="editFrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="editTo">Period to</Label>
                  <Input id="editTo" type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); if (statementDate < e.target.value) setStatementDate(e.target.value); }} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="editOpening">Opening balance ({session.currency})</Label>
                  <Input id="editOpening" type="number" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="editClosing">Closing balance ({session.currency})</Label>
                  <Input id="editClosing" type="number" step="0.01" value={closing} onChange={(e) => setClosing(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="editStatementDate">Statement date</Label>
                <Input id="editStatementDate" type="date" value={statementDate} min={to || undefined} onChange={(e) => setStatementDate(e.target.value)} />
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="editNotes">Notes</Label>
            <Textarea id="editNotes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={edit.isPending} onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Reopen the latest completed reconciliation — said in full, because its lines stop being reconciled until it is completed again. */
function ReopenReconciliation({ accountId, session, onClose, onReopened }: { accountId: string; session: ReconciliationSession; onClose: () => void; onReopened: () => void }) {
  const reopen = useReopenReconciliation(accountId);
  const n = session.reconciledTransactionIds.length;
  async function go() {
    try {
      await reopen.mutateAsync(session.id);
      toast.success("Reopened — fix it and complete it again");
      onReopened();
    } catch (e) {
      failed(e, "Could not reopen the reconciliation");
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reopen reconciliation {periodOf(session)}?</DialogTitle>
          <DialogDescription>
            It becomes open again with its {n === 1 ? "1 ticked line" : `${n} ticked lines`}, statement dates and figures kept. Until you complete it
            again those lines are not reconciled and their expenses' statement dates show Pending. The account&apos;s last reconciled goes back to the one before.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={reopen.isPending} onClick={go}>Reopen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Delete: an open one simply goes; the latest completed one is undone, which can't be taken back. */
function DeleteReconciliation({ accountId, session, onClose }: { accountId: string; session: ReconciliationSession; onClose: () => void }) {
  const remove = useDeleteReconciliation(accountId);
  const n = session.reconciledTransactionIds.length;
  const isOpen = session.status === "open";
  async function go() {
    try {
      const { unreconciled } = await remove.mutateAsync(session.id);
      toast.success(isOpen ? "Reconciliation deleted" : `Reconciliation deleted — ${unreconciled === 1 ? "1 line" : `${unreconciled} lines`} unreconciled`);
      onClose();
    } catch (e) {
      failed(e, "Could not delete the reconciliation");
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete reconciliation {periodOf(session)}?</DialogTitle>
          <DialogDescription>
            {isOpen
              ? `It is still open, so no line was reconciled by it — only its ${n === 1 ? "1 tick" : `${n} ticks`} and figures go.`
              : `This undoes it: its ${n === 1 ? "1 line goes" : `${n} lines go`} back to unreconciled, their statement dates are cleared (their expenses show Pending again), and the account's last reconciled goes back to the one before. It can't be taken back — you would tick the lines again in a new reconciliation.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" loading={remove.isPending} onClick={go}>Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
