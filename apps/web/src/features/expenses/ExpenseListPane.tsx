"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { NO_SUBCATEGORY, EXPENSE_PAYMENT_STATUS_LABELS } from "@delta/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/ui/money";
import { openPane, PANE_PREFIX } from "@/components/split-view/split-view";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { useExpenses, useExpenseSummary } from "./api";
import { ExpenseDetail } from "./ExpenseDetail";

/*
 * A category budget's breakdown in the split pane (the user, 2026-11-09: "click the expenses and they open in the
 * split screen, to check the breakdown"): the approved expenses of a category — or one subcategory, or those filed
 * with none — in a month or a year, in one currency, counting only what the budget counts (the P&L). The same
 * figure as the table's Spent. One clicked opens in the pane itself, with a way back to the list.
 *
 * Its settings are the pane's, in the address under `p.`: sub, from, to, currency.
 */

const PAGE_SIZE = 25;
const KEYS = ["sub", "from", "to", "currency"] as const;

const PAYMENT_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = { unpaid: "warning", overdue: "danger", paid: "success" };

/** The list's settings as the address holds them — what opening one expense carries along, to come back to. */
function listSettings(q: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEYS) { const v = q.get(PANE_PREFIX + k); if (v) out[k] = v; }
  return out;
}

const dayLabel = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function periodOf(from: string, to: string): string {
  if (!from) return "";
  const f = new Date(`${from}T00:00:00Z`);
  const sameMonth = to && from.slice(0, 7) === to.slice(0, 7) && from.endsWith("-01");
  if (sameMonth) return f.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  if (from.endsWith("-01-01") && to.endsWith("-12-31") && from.slice(0, 4) === to.slice(0, 4)) return from.slice(0, 4);
  return `${dayLabel(from)} – ${to ? dayLabel(to) : "now"}`;
}

/** What one category (or subcategory) was spent on — the pane `expenses:<category>`. */
export function ExpenseListPane({ category }: { category: string }) {
  const q = useSearchParams();
  const s = listSettings(new URLSearchParams(q.toString()));
  const sub = s.sub ?? "";
  // Back to the first page when it shows something else (another subcategory of the same category, say).
  const sig = JSON.stringify([category, s]);
  const [paging, setPaging] = useState({ sig, page: 1 });
  const page = paging.sig === sig ? paging.page : 1;
  const setPage = (f: (p: number) => number) => setPaging({ sig, page: f(page) });
  const { data: categories } = useExpenseCategories();
  const cat = categories?.find((c) => c.slug === category);
  const subName = sub === NO_SUBCATEGORY ? "No subcategory" : sub ? cat?.subcategories.find((x) => x.slug === sub)?.name ?? sub : "";

  const filters = {
    status: "approved", category, subcategory: sub || undefined, dateFrom: s.from || undefined, dateTo: s.to || undefined,
    currency: s.currency || undefined, pnl: "true",
  };
  const { data, isLoading, isPlaceholderData } = useExpenses({ ...filters, page, pageSize: PAGE_SIZE, sort: "date", dir: "desc" });
  const summary = useExpenseSummary(filters);
  const rows = data?.data ?? [];
  const meta = data?.meta;
  const totals = summary.data?.byCurrency ?? [];

  return (
    <div className="space-y-4 p-4">
      <div>
        <h2 className="text-lg font-semibold">
          {cat?.name ?? category}{subName && <span className="text-foreground-muted"> › {subName}</span>}
        </h2>
        <p className="text-sm text-foreground-muted">
          Approved expenses{s.from ? ` · ${periodOf(s.from, s.to ?? "")}` : ""}{s.currency ? ` · ${s.currency}` : ""} — what the budget counts as spent.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        {totals.length === 0 && !summary.isLoading ? (
          <div className="rounded-lg border border-border px-4 py-3 text-sm text-foreground-muted">Nothing spent.</div>
        ) : totals.map((t) => (
          <div key={t.currency} className="rounded-lg border border-border px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-foreground-muted">{t.count} {t.count === 1 ? "expense" : "expenses"}</p>
            <p className="text-lg font-semibold"><MoneyDisplay minor={t.totalMinor} currency={t.currency} /></p>
            <p className="text-xs text-foreground-muted">
              <MoneyDisplay minor={t.paidMinor} currency={t.currency} /> paid · <MoneyDisplay minor={t.unpaidMinor + t.overdueMinor} currency={t.currency} /> not paid
            </p>
          </div>
        ))}
      </div>

      <div className={`overflow-hidden rounded-lg border border-border transition-opacity ${isPlaceholderData ? "opacity-60" : ""}`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b bg-surface-muted/60 text-left text-xs uppercase tracking-wide text-foreground-muted">
                <th className="px-3 py-2">Expense</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Department</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr><td colSpan={4} className="px-3 py-10 text-center text-foreground-muted">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-10 text-center text-foreground-muted">No expenses.</td></tr>
              ) : rows.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => openPane("expense", e.id, { ...s, list: category })}
                  className="cursor-pointer align-top hover:bg-surface-muted/40"
                  title="Open it here"
                >
                  <td className="px-3 py-2">
                    <span className="font-medium text-primary">{e.expenseNumber}</span>
                    <span className="block max-w-[260px] truncate text-xs text-foreground-muted">{e.description}</span>
                    {!sub && e.subcategoryName && <span className="block text-[11px] text-foreground-muted">{e.subcategoryName}</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-foreground-muted">{dayLabel(e.expenseDate)}</td>
                  <td className="px-3 py-2 text-foreground-muted">{e.department?.name ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <MoneyDisplay minor={e.totalMinor} currency={e.currency} className="font-medium" />
                    <Badge tone={PAYMENT_TONE[e.paymentStatus] ?? "neutral"} className="mt-1">
                      {EXPENSE_PAYMENT_STATUS_LABELS[e.paymentStatus] ?? e.paymentStatus}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {meta && meta.pageCount > 1 && (
        <div className="flex items-center justify-between text-sm text-foreground-muted">
          <span>{(meta.page - 1) * meta.pageSize + 1}–{Math.min(meta.page * meta.pageSize, meta.total)} of {meta.total}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={meta.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
            <Button size="sm" variant="outline" disabled={meta.page >= meta.pageCount} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One expense in the pane — `expense:<id>`. Opened from a breakdown (`p.list`), it has a way back to that list; deleted
 * there, the list comes back, else the pane closes.
 */
export function ExpensePane({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useSearchParams();
  const all = new URLSearchParams(q.toString());
  const list = all.get(PANE_PREFIX + "list") ?? "";
  const s = listSettings(all);
  const back = list ? () => openPane("expenses", list, s) : null;
  return (
    <div>
      {back && (
        <div className="border-b border-border px-4 py-2">
          <button type="button" onClick={back} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" /> Back to the list
          </button>
        </div>
      )}
      <ExpenseDetail id={id} embedded onDeleted={back ?? onClose} />
    </div>
  );
}
