"use client";

import { use } from "react";
import { ExpenseDetail } from "@/features/expenses/ExpenseDetail";

/** One expense's page — the same one the split pane shows beside a category budget (features/expenses/ExpenseDetail). */
export default function ExpenseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ExpenseDetail id={id} />;
}
