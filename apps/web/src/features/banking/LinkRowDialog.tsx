"use client";

import { useState } from "react";
import { Link2, Search } from "lucide-react";
import { formatMoney, type BankTransaction } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useMatchTransaction } from "@/features/banking/api";
import { useInvoices } from "@/features/invoices/api";
import { useExpenses } from "@/features/expenses/api";
import { useBills } from "@/features/bills/api";

type Kind = "invoice" | "expense" | "bill";

const KINDS: { key: Kind; label: string; hint: string }[] = [
  { key: "expense", label: "Expense", hint: "Something bought with the cash" },
  { key: "invoice", label: "Invoice", hint: "A client paying in cash" },
  { key: "bill", label: "Bill", hint: "A supplier settled in cash" },
];

/**
 * Point a cash book row at the document it belongs to.
 *
 * A row that reads "Commission irfana" is a line of text: nothing else in the
 * system knows the tin paid it. Attaching the expense makes the tin reconcile
 * against the rest of the books instead of being a parallel record of them.
 *
 * Attached by hand, never created for you. Recording a client's cash payment
 * against their invoice and also entering the row is two different facts about
 * the same money — if the link were made automatically as well, the same cash
 * would be booked twice.
 */
export function LinkRowDialog({
  accountId,
  tx,
  currency,
  open,
  onClose,
}: {
  accountId: string;
  tx: BankTransaction;
  currency: string;
  open: boolean;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>(tx.amountMinor >= 0 ? "invoice" : "expense");
  const [q, setQ] = useState("");
  const match = useMatchTransaction(accountId, tx.id);

  const params = { page: 1, pageSize: 8, q: q.trim() || undefined };
  const invoices = useInvoices(params, { enabled: open && kind === "invoice" });
  const expenses = useExpenses(params, { enabled: open && kind === "expense" });
  const bills = useBills(params, { enabled: open && kind === "bill" });

  const rows =
    kind === "invoice"
      ? (invoices.data?.data ?? []).map((r) => ({
          id: r.id, number: r.invoiceNumber, label: r.customerName, minor: r.totalMinor,
        }))
      : kind === "expense"
        ? (expenses.data?.data ?? []).map((r) => ({
            id: r.id, number: r.expenseNumber, label: r.description, minor: r.totalMinor,
          }))
        : (bills.data?.data ?? []).map((r) => ({
            id: r.id, number: r.billNumber, label: r.vendorName, minor: r.totalMinor,
          }));

  async function link(row: { id: string; number: string }) {
    try {
      await match.mutateAsync({
        type: kind,
        referenceId: row.id,
        referenceNumber: row.number,
        // What this row settled, which is not always the document's full value —
        // a tin often pays part of something.
        amountMinor: Math.abs(tx.amountMinor),
      });
      toast.success(`Linked to ${row.number}`);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not link it");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-foreground-muted" /> Link this entry
          </DialogTitle>
          <DialogDescription>
            {tx.description} — {formatMoney(Math.abs(tx.amountMinor), currency)} on{" "}
            {tx.date.slice(0, 10)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            {KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                onClick={() => { setKind(k.key); setQ(""); }}
                className={`flex-1 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  kind === k.key ? "border-primary bg-primary/5" : "border-border hover:bg-surface-muted"
                }`}
              >
                <span className="block font-medium">{k.label}</span>
                <span className="block text-xs text-foreground-muted">{k.hint}</span>
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="link-q">Find it</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
              <Input
                id="link-q"
                value={q}
                autoFocus
                placeholder="Number, name or description"
                className="pl-8"
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>

          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {rows.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-foreground-muted">
                Nothing to show. Try a different search.
              </li>
            ) : (
              rows.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    disabled={match.isPending}
                    onClick={() => link(r)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-muted disabled:opacity-50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.label}</p>
                      <p className="text-xs text-foreground-muted">{r.number}</p>
                    </div>
                    <span className="shrink-0 font-numeric text-sm">
                      {formatMoney(r.minor, currency)}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
