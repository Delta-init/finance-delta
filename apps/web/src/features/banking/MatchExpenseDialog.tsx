"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { formatMoney, type BankTransaction } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { toDmy } from "@/lib/dates";
import { useExpenseCandidates, useMatchToExpense } from "@/features/banking/api";

/**
 * A money-out line matched to an expense — and only an expense (the user, 2026-11-11: "Bank and expenses required
 * matching only"). Offered: expenses not in Banking yet, in the line's currency, the same amount, within 3 days of it;
 * "Other amounts" widens to 30 days and any amount (the match itself still needs the amounts to agree). Matched, the
 * expense is paid from this account on the line's day and the line is its line — nothing is added.
 */
export function MatchExpenseDialog({ accountId, tx, onClose }: { accountId: string; tx: BankTransaction; onClose: () => void }) {
  const [wide, setWide] = useState(false);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const { data, isLoading, error } = useExpenseCandidates(accountId, tx.id, { wide, q });
  const match = useMatchToExpense(accountId);
  const amount = -tx.amountMinor;

  const pick = async (expenseId: string, number: string) => {
    try {
      await match.mutateAsync({ txId: tx.id, expenseId });
      toast.success(`Matched to ${number} — paid from this account on ${toDmy(tx.date)}`);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not match it");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Match to an expense</DialogTitle>
          <DialogDescription>
            {toDmy(tx.date)} · {tx.description} · {formatMoney(amount, tx.currency)} out. The expense you pick is marked paid
            from this account on that day, and this line becomes its line — nothing is added, so it is counted once.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Description, EXP number, reference" className="pl-8" />
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground-muted">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={wide} onChange={(e) => setWide(e.target.checked)} />
            Other amounts (30 days)
          </label>
        </div>
        <div className="max-h-[50vh] overflow-y-auto rounded-md border border-border">
          {isLoading ? (
            <p className="px-4 py-8 text-center text-sm text-foreground-muted">Looking…</p>
          ) : error ? (
            <p className="px-4 py-8 text-center text-sm text-danger">{error instanceof ApiError ? error.message : "Could not look for expenses"}</p>
          ) : !data?.candidates.length ? (
            <p className="px-4 py-8 text-center text-sm text-foreground-muted">
              No expense {wide ? "within 30 days" : `of ${formatMoney(amount, tx.currency)} within 3 days`} that isn&apos;t in Banking yet.
              {!wide && " Tick “Other amounts” to look wider."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface text-left text-xs uppercase tracking-wide text-foreground-subtle">
                <tr><th className="px-3 py-2">Expense</th><th className="px-3 py-2">Date</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2" /></tr>
              </thead>
              <tbody>
                {data.candidates.map((c) => (
                  <tr key={c.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <span className="font-medium">{c.expenseNumber}</span> · {c.description}
                      <div className="text-xs text-foreground-muted">{[c.category, c.status.replace(/_/g, " "), c.paid ? "marked paid, not in an account" : ""].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {toDmy(c.expenseDate)}
                      <div className="text-xs text-foreground-muted">{c.daysApart === 0 ? "same day" : `${c.daysApart} day${c.daysApart === 1 ? "" : "s"} apart`}</div>
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right font-numeric ${c.sameAmount ? "" : "text-warning"}`}>
                      {formatMoney(c.totalMinor, c.currency)}
                      {!c.sameAmount && <div className="text-xs">not the line&apos;s amount</div>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" disabled={!c.sameAmount || match.isPending} title={c.sameAmount ? "Match this line to it" : "The amounts have to agree — change the expense first"}
                        onClick={() => pick(c.id, c.expenseNumber)}>
                        Match
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
