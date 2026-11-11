"use client";

import { ImportWizard } from "@/features/imports/ImportWizard";
import { EXPENSE_IMPORT } from "@/features/imports/kinds";

/** Expenses from a spreadsheet (2026-11-11). */
export default function ImportExpensesPage() {
  return <ImportWizard kind={EXPENSE_IMPORT} />;
}
