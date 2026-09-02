"use client";

import { useEffect, useState } from "react";
import { Calculator } from "lucide-react";
import { compareCashCount, formatMoney, toMinor, type BankAccount, type ReconciliationSession } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useRecordCashCount, useUpdateCashCount } from "@/features/banking/api";

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Counting the tin.
 *
 * Says what the difference is before it is committed, and what will happen to
 * it — a count that quietly moves the balance is worse than one that does not
 * move it at all, because nobody knows afterwards that the tin was ever short.
 */
export function CashCountDialog({
  account,
  session,
  open,
  onClose,
}: {
  account: BankAccount;
  /** The count being corrected, or nothing when taking a new one. */
  session?: ReconciliationSession | null;
  open: boolean;
  onClose: () => void;
}) {
  const count = useRecordCashCount(account.id);
  const amend = useUpdateCashCount(account.id);
  const correcting = Boolean(session);
  const [countedOn, setCountedOn] = useState(today);
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setCountedOn(session ? session.statementDate.slice(0, 10) : today());
    setCounted(session ? (session.statementBalanceMinor / 100).toFixed(2) : "");
    setNotes(session?.notes ?? "");
  }, [open, session]);

  /*
   * Correcting a count compares against the book as it was before that count
   * touched it — its own adjustment is about to be withdrawn, so counting it
   * would measure the tin against a figure the count itself created.
   */
  const book = correcting ? session!.closingBookBalanceMinor : account.currentBalanceMinor;
  const entered = counted.trim().length > 0;
  const countedMinor = toMinor(counted || "0");
  const { differenceMinor: difference, verdict } = compareCashCount(countedMinor, book);

  async function submit() {
    if (!entered) return;
    try {
      const body = { countedOn, countedMinor, notes: notes.trim() };
      if (correcting) await amend.mutateAsync({ sessionId: session!.id, input: body });
      else await count.mutateAsync(body);
      toast.success(
        difference === 0
          ? "Counted, and the tin agrees"
          : `Counted. An adjustment of ${formatMoney(Math.abs(difference), account.currency)} was posted.`,
      );
      onClose();
      setCounted("");
      setNotes("");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not record the count");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="h-4 w-4 text-foreground-muted" />
            {correcting ? "Correct this count" : "Count the cash"}
          </DialogTitle>
          <DialogDescription>
            {correcting
              ? "The count is taken again with these figures, and its previous adjustment withdrawn."
              : "Count what is actually in the tin. Everything up to this date is settled in one go."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="counted-on">Counted on</Label>
              <Input id="counted-on" type="date" value={countedOn} onChange={(e) => setCountedOn(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="counted">Counted ({account.currency})</Label>
              <Input
                id="counted"
                type="number"
                step="0.01"
                min="0"
                autoFocus
                value={counted}
                placeholder="0.00"
                onChange={(e) => setCounted(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1 rounded-md border border-border bg-surface-muted/40 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-foreground-muted">Book balance</span>
              <span className="font-numeric font-medium">{formatMoney(book, account.currency)}</span>
            </div>
            {entered && (
              <>
                <div className="flex justify-between">
                  <span className="text-foreground-muted">Counted</span>
                  <span className="font-numeric font-medium">{formatMoney(countedMinor, account.currency)}</span>
                </div>
                <div className="flex justify-between border-t border-border pt-1">
                  <span className="font-medium capitalize">{verdict}</span>
                  <span
                    className={`font-numeric font-semibold ${
                      difference === 0 ? "text-success" : "text-danger"
                    }`}
                  >
                    {formatMoney(Math.abs(difference), account.currency)}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Said before it happens, not after. */}
          {entered && difference !== 0 && (
            <p className="rounded-md border border-warning/30 bg-warning/5 p-2.5 text-xs">
              An entry of {formatMoney(Math.abs(difference), account.currency)} will be added to the
              book so it agrees with the count. The count records that the tin was{" "}
              {verdict}.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="count-notes">Notes</Label>
            <Input
              id="count-notes"
              value={notes}
              maxLength={300}
              placeholder="Optional — worth saying why, if it did not agree"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={count.isPending || amend.isPending} disabled={!entered} onClick={submit}>
            {correcting ? "Save count" : "Record count"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
