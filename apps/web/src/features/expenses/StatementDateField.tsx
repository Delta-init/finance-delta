"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import type { Expense } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useSetExpenseStatementDate } from "./api";

/**
 * The day the bank statement shows the expense. Reconciling its bank line writes it (2026-10-23); since 2026-10-26 it
 * can also be typed in, changed or taken off here ("we can edit the statement date of the expense"). Only the
 * expense changes — a later reconciliation of its line writes over it.
 */
export function StatementDateField({ expense, canChange }: { expense: Expense; canChange: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(expense.statementDate ?? "");
  const set = useSetExpenseStatementDate(expense.id);
  const hasState = expense.statementState && expense.statementState !== "none";
  if (!hasState && !canChange) return null;

  const save = (date: string | null) =>
    set.mutate(date, {
      onSuccess: () => { toast.success(date ? `Statement date set to ${date}` : "Statement date taken off"); setEditing(false); },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not save the statement date"),
    });

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-foreground-muted">Statement Date</p>
        {canChange && !editing && (
          <button
            type="button"
            onClick={() => { setValue(expense.statementDate ?? ""); setEditing(true); }}
            className="text-foreground-muted hover:text-foreground"
            title={expense.statementDate ? "Change the statement date" : "Enter the statement date"}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-1 space-y-2">
          <Input type="date" value={value} onChange={(e) => setValue(e.target.value)} className="h-8" autoFocus />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!value || set.isPending} onClick={() => save(value)}>Save</Button>
            {expense.statementDate && (
              <Button size="sm" variant="outline" disabled={set.isPending} onClick={() => save(null)}>Take off</Button>
            )}
            <Button size="sm" variant="ghost" disabled={set.isPending} onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : expense.statementDate ? (
        <p className="text-sm font-medium mt-0.5">{expense.statementDate}</p>
      ) : hasState ? (
        <>
          <p className="text-sm font-medium mt-0.5 text-warning">Pending</p>
          <p className="text-xs text-foreground-muted mt-0.5">Set when {expense.paymentAccount || "its bank account"} is reconciled, or enter it here</p>
        </>
      ) : (
        <p className="text-sm mt-0.5 text-foreground-muted">Not entered</p>
      )}
    </div>
  );
}
