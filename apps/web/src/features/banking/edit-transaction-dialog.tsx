"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Lock } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BankTransaction, UpdateBankTransactionInput } from "@delta/shared";

/**
 * Correcting an entry after it has been made.
 *
 * The amount is typed in whole currency and signed by direction, because that
 * is how a statement reads — a withdrawal of 250, not minus 250. It is
 * converted once, here, on the way out.
 *
 * A transaction that has been reconciled or matched cannot be changed at all;
 * the dialog says which and offers nothing, rather than letting somebody fill
 * the form in and then be refused by the server.
 */
export function EditTransactionDialog({
  tx, open, onOpenChange, onSubmit, pending, error,
}: {
  tx: BankTransaction | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: UpdateBankTransactionInput) => void;
  pending: boolean;
  error?: string | null;
}) {
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [direction, setDirection] = useState<"credit" | "debit">("debit");
  const [amount, setAmount] = useState("");

  useEffect(() => {
    if (!tx) return;
    setDate(tx.date.slice(0, 10));
    setDescription(tx.description);
    setReference(tx.reference ?? "");
    setNotes(tx.notes ?? "");
    setDirection(tx.amountMinor >= 0 ? "credit" : "debit");
    setAmount((Math.abs(tx.amountMinor) / 100).toFixed(2));
  }, [tx]);

  const frozen = tx?.isReconciled ? "reconciled" : tx?.matches?.length ? "matched" : null;
  const parsed = Number(amount);
  const valid = description.trim() && date && Number.isFinite(parsed) && parsed > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit transaction</DialogTitle>
          <DialogDescription>
            The running balance for this account is recalculated in date order, so changing an
            amount or a date restates every figure after it.
          </DialogDescription>
        </DialogHeader>

        {frozen ? (
          <p className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 p-3 text-sm">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>
              {frozen === "reconciled" ? (
                <>
                  This transaction has been reconciled and is now evidence of a statement that was
                  signed off. Add a correcting entry instead of changing it.
                </>
              ) : (
                <>
                  This transaction is matched to {tx?.matches?.[0]?.type}{" "}
                  {tx?.matches?.[0]?.referenceNumber}. Unmatch it first, or change it from there.
                </>
              )}
            </span>
          </p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tx-date">Date</Label>
                <Input id="tx-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tx-amount">Amount</Label>
                <Input
                  id="tx-amount" type="number" min="0" step="0.01"
                  value={amount} onChange={(e) => setAmount(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Direction</Label>
              <div className="flex gap-2">
                <Button
                  type="button" size="sm"
                  variant={direction === "debit" ? "primary" : "secondary"}
                  onClick={() => setDirection("debit")}
                >
                  Money out
                </Button>
                <Button
                  type="button" size="sm"
                  variant={direction === "credit" ? "primary" : "secondary"}
                  onClick={() => setDirection("credit")}
                >
                  Money in
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tx-desc">Description</Label>
              <Input id="tx-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tx-ref">Reference</Label>
              <Input id="tx-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tx-notes">Notes</Label>
              <Input id="tx-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            {error && (
              <p className="flex items-start gap-2 text-sm text-danger">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {frozen ? "Close" : "Cancel"}
          </Button>
          {!frozen && (
            <Button
              loading={pending}
              disabled={!valid}
              onClick={() =>
                onSubmit({
                  date,
                  description: description.trim(),
                  reference: reference.trim(),
                  notes: notes.trim(),
                  // Signed on the way out: the form asks for a direction and a
                  // positive figure, the ledger stores one signed number.
                  amountMinor: Math.round(parsed * 100) * (direction === "debit" ? -1 : 1),
                })
              }
            >
              Save changes
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
