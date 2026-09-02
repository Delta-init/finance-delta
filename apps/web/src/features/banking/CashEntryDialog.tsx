"use client";

import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { formatMoney, toMinor, type BankAccount, type BankTransaction } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCreateBankTransaction, useUpdateBankTransaction } from "@/features/banking/api";

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Adding or correcting one line of the cash book.
 *
 * The same form either way, because they are the same four facts. An entry
 * typed into a row at the foot of a table has nowhere to put a reference or a
 * note, and no room to say why an amount was refused — so it asks properly.
 *
 * In and Out stay separate rather than becoming one signed amount. Somebody
 * keeping a tin thinks in "paid out 55", not "-55", and a single field that
 * needs a minus sign to mean the opposite thing is a field that gets it wrong.
 */
export function CashEntryDialog({
  account,
  entry,
  open,
  onClose,
}: {
  account: BankAccount;
  /** The row being corrected, or nothing when adding. */
  entry?: BankTransaction | null;
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateBankTransaction(account.id);
  const update = useUpdateBankTransaction(account.id);
  const editing = Boolean(entry);

  const [date, setDate] = useState(today);
  const [description, setDescription] = useState("");
  const [inAmount, setInAmount] = useState("");
  const [outAmount, setOutAmount] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  // Reloaded whenever a different row is opened, so the form never shows the
  // last one's figures against this one's name.
  useEffect(() => {
    if (!open) return;
    if (entry) {
      const isIn = entry.amountMinor >= 0;
      setDate(entry.date.slice(0, 10));
      setDescription(entry.description);
      setInAmount(isIn ? (entry.amountMinor / 100).toFixed(2) : "");
      setOutAmount(isIn ? "" : (Math.abs(entry.amountMinor) / 100).toFixed(2));
      setReference(entry.reference ?? "");
      setNotes(entry.notes ?? "");
    } else {
      setDate(today());
      setDescription("");
      setInAmount("");
      setOutAmount("");
      setReference("");
      setNotes("");
    }
  }, [open, entry]);

  const inMinor = toMinor(inAmount || "0");
  const outMinor = toMinor(outAmount || "0");
  const bothSides = inMinor > 0 && outMinor > 0;
  const amountMinor = inMinor > 0 ? inMinor : -outMinor;
  const canSubmit = description.trim().length > 0 && (inMinor > 0 || outMinor > 0) && !bothSides;

  async function submit() {
    if (!canSubmit) return;
    const body = {
      date,
      description: description.trim(),
      amountMinor,
      reference: reference.trim(),
      notes: notes.trim(),
    };
    try {
      if (editing) {
        await update.mutateAsync({ txId: entry!.id, input: body });
        toast.success("Entry updated");
      } else {
        await create.mutateAsync(body);
        toast.success("Entry added");
      }
      onClose();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.message : editing ? "Could not update it" : "Could not add it",
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-foreground-muted" />
            {editing ? "Edit entry" : "New entry"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "The balance below this entry is recalculated from its date."
              : "Money in or money out — one of the two, not both."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cash-desc">What was it for?</Label>
            <Input
              id="cash-desc"
              value={description}
              maxLength={200}
              autoFocus
              placeholder="e.g. Office supplies"
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void submit())}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="cash-date">Date</Label>
              <Input id="cash-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cash-in">In ({account.currency})</Label>
              <Input
                id="cash-in"
                type="number"
                step="0.01"
                min="0"
                value={inAmount}
                placeholder="0.00"
                onChange={(e) => { setInAmount(e.target.value); if (e.target.value) setOutAmount(""); }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cash-out">Out ({account.currency})</Label>
              <Input
                id="cash-out"
                type="number"
                step="0.01"
                min="0"
                value={outAmount}
                placeholder="0.00"
                onChange={(e) => { setOutAmount(e.target.value); if (e.target.value) setInAmount(""); }}
              />
            </div>
          </div>

          {bothSides && (
            <p className="rounded-md border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger">
              An entry is money in or money out, not both. Clear whichever is wrong.
            </p>
          )}

          {!bothSides && (inMinor > 0 || outMinor > 0) && !editing && (
            <p className="text-xs text-foreground-muted">
              The tin goes to{" "}
              <span className="font-numeric font-medium text-foreground">
                {formatMoney(account.currentBalanceMinor + amountMinor, account.currency)}
              </span>
              .
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cash-ref">Reference</Label>
              <Input
                id="cash-ref"
                value={reference}
                maxLength={100}
                placeholder="Optional — receipt or voucher no."
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cash-notes">Notes</Label>
              <Input
                id="cash-notes"
                value={notes}
                maxLength={300}
                placeholder="Optional"
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            loading={create.isPending || update.isPending}
            disabled={!canSubmit}
            onClick={submit}
          >
            {editing ? "Save changes" : "Add entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
