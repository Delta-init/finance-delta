"use client";

import { useState } from "react";
import { Calculator, Pencil, Trash2 } from "lucide-react";
import { formatMoney, type BankAccount, type ReconciliationSession } from "@delta/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { useReconciliations, useDeleteCashCount } from "@/features/banking/api";
import { CashCountDialog } from "@/features/banking/CashCountDialog";

/**
 * The counts already taken on this tin.
 *
 * Here because a count is not a thing that happens and vanishes: it locks every
 * entry it covered, so the only way back to a row that needs correcting is
 * through the count that signed it off. Somewhere to see them is what makes
 * that possible rather than a dead end.
 */
export function CashCounts({ account }: { account: BankAccount }) {
  const { can } = useCan();
  const canCount = can("banking:reconcile");
  const { data } = useReconciliations(account.id, { page: 1, pageSize: 20, sort: "statementDate", dir: "desc" });
  const remove = useDeleteCashCount(account.id);
  const [editing, setEditing] = useState<ReconciliationSession | null>(null);
  const [confirming, setConfirming] = useState<ReconciliationSession | null>(null);

  const counts = data?.data ?? [];
  if (counts.length === 0) return null;

  async function withdraw(session: ReconciliationSession) {
    try {
      await remove.mutateAsync(session.id);
      toast.success("Count withdrawn. The entries it covered can be changed again.");
      setConfirming(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not withdraw the count");
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Calculator className="h-4 w-4 text-foreground-muted" />
        <h2 className="text-sm font-semibold">Counts</h2>
        <span className="ml-auto text-xs text-foreground-muted">
          {counts.length === 1 ? "1 count" : `${counts.length} counts`}
        </span>
      </div>

      <ul className="divide-y divide-border">
        {counts.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {c.statementDate} — counted {formatMoney(c.statementBalanceMinor, c.currency)}
              </p>
              <p className="text-xs text-foreground-muted">
                {c.differenceMinor === 0 ? (
                  "Agreed with the book"
                ) : (
                  <>
                    {c.differenceMinor > 0 ? "Over" : "Short"} by{" "}
                    {formatMoney(Math.abs(c.differenceMinor), c.currency)}
                    {c.adjustmentTransactionId ? ", adjusted" : ""}
                  </>
                )}
                {c.completedByName ? ` · ${c.completedByName}` : ""}
                {c.notes ? ` · ${c.notes}` : ""}
              </p>
            </div>

            {canCount && (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(c)}
                  className="text-foreground-subtle hover:text-primary"
                  aria-label={`Correct the count of ${c.statementDate}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => setConfirming(c)}
                  className="text-foreground-subtle hover:text-danger disabled:opacity-50"
                  aria-label={`Withdraw the count of ${c.statementDate}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {editing && (
        <CashCountDialog
          account={account}
          session={editing}
          open
          onClose={() => setEditing(null)}
        />
      )}

      {/* Said in full, because withdrawing a count changes the balance as well
          as unlocking rows, and neither is obvious from a bin icon. */}
      <Dialog open={Boolean(confirming)} onOpenChange={(o) => { if (!o) setConfirming(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Withdraw this count?</DialogTitle>
            <DialogDescription>
              {confirming && (
                <>
                  The count of {formatMoney(confirming.statementBalanceMinor, confirming.currency)} on{" "}
                  {confirming.statementDate} will be removed
                  {confirming.adjustmentTransactionId
                    ? ", along with the adjustment entry it posted — so the balance goes back to what the book said"
                    : ""}
                  . The entries it covered can be changed again.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => confirming && withdraw(confirming)}
            >
              Withdraw count
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
