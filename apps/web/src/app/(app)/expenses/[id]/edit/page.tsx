"use client";

import { use } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useExpense } from "@/features/expenses/api";
import { ExpenseForm, type ExpenseFormValues } from "@/features/expenses/ExpenseForm";

export default function EditExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: expense, isLoading } = useExpense(id);

  if (isLoading) {
    return <div className="flex h-64 items-center justify-center text-foreground-muted">Loading…</div>;
  }
  if (!expense) {
    return <div className="flex h-64 items-center justify-center text-foreground-muted">Expense not found.</div>;
  }

  // Any non-voided expense can be edited (mirrors the API guard).
  if (expense.status === "voided") {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div className="flex items-center gap-3">
          <Link href={`/expenses/${id}`} className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-xl font-semibold">Edit Expense</h1>
        </div>
        <div className="rounded-lg border border-border bg-surface p-6 text-sm text-foreground-muted">
          This expense has been <span className="font-medium text-foreground">voided</span> and can no longer be edited.
          <div className="mt-3">
            <Link href={`/expenses/${id}`} className="text-primary hover:underline">Back to expense →</Link>
          </div>
        </div>
      </div>
    );
  }

  const initialValues: Partial<ExpenseFormValues> = {
    category: expense.category,
    // The typed name lives in categoryName. Left blank when it is just the
    // category's own label, so an untouched claim does not reopen looking as
    // though somebody had typed "Other" into the box.
    categoryOther:
      expense.category === "other" && expense.categoryName !== "Other" ? expense.categoryName : "",
    description: expense.description,
    expenseDate: expense.expenseDate,
    // Shown back the way it was typed. amountMinor holds the net, so a claim
    // entered tax-inclusive has to be reopened at its gross or the figure would
    // drop by the tax every time somebody saved it.
    amountDisplay: ((expense.taxInclusive ? expense.totalMinor : expense.amountMinor) / 100).toString(),
    currency: expense.currency,
    taxPct: expense.taxPct,
    taxInclusive: expense.taxInclusive ?? false,
    paymentAccount: expense.paymentAccount || "",
    paymentMethod: expense.paymentMethod,
    reference: expense.reference || "",
    isRecurring: expense.isRecurring,
    recurrenceFrequency: expense.recurrence?.frequency,
    recurrenceNextDate: expense.recurrence?.nextDate,
    recurrenceEndDate: expense.recurrence?.endDate,
    hasMileage: !!expense.mileage,
    mileageDistanceKm: expense.mileage?.distanceKm,
    mileageRateDisplay: expense.mileage ? (expense.mileage.ratePerKmMinor / 100).toString() : undefined,
    projectName: expense.projectName || "",
    departmentId: expense.department?.id ?? "",
    costCentre: expense.costCentre || "",
    notes: expense.notes || "",
    attachments: expense.attachments,
  };

  return <ExpenseForm mode="edit" expenseId={id} initialValues={initialValues} />;
}
