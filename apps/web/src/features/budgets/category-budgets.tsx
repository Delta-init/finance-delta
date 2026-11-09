"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { CategoryBudgetLine, CategoryBudgetRow } from "@delta/shared";
import { toMinor } from "@delta/shared";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoneyDisplay } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCategoryAllocations, useSaveCategoryAllocation } from "./api";
import { periodLabel } from "./review-dialog";

/*
 * Budgets by expense category (the user, 2026-11-09: "category-wise, and no department to pick"). Each spending
 * category of the month (or the year) with its budget, what was spent there — every approved expense, with a
 * department or without — and what is left; open one for its subcategories. A budget is set for a category, or for
 * one of its subcategories, and a month.
 */

const WHOLE = "__whole";

/** What the dialog opens on: a category (and subcategory) already picked, or nothing. */
export type CategoryBudgetTarget = { category: string; subcategory: string; currency: string } | null;

function UsedBar({ spent, allocated }: { spent: number; allocated: number }) {
  if (allocated <= 0) return <div className="text-right text-xs text-foreground-muted">—</div>;
  const pct = Math.round((spent / allocated) * 100);
  const tone = pct > 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="flex items-center justify-end gap-2" title={`${pct}% of the budget spent`}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-muted">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className={`w-10 text-right text-xs tabular-nums ${pct > 100 ? "font-semibold text-red-600" : "text-foreground-muted"}`}>{pct}%</span>
    </div>
  );
}

function Left({ line }: { line: Pick<CategoryBudgetLine, "budgeted" | "availableMinor"> & { currency: string } }) {
  if (!line.budgeted) return <span className="text-xs text-foreground-muted">—</span>;
  return <MoneyDisplay minor={line.availableMinor} currency={line.currency} className={line.availableMinor < 0 ? "font-semibold text-red-600" : "font-semibold"} />;
}

export function CategoryBudgetView({ rows, loading, period, canManage, onSet }: {
  rows: CategoryBudgetRow[];
  loading: boolean;
  /** YYYY-MM, or YYYY for the whole year. */
  period: string;
  canManage: boolean;
  onSet: (target: CategoryBudgetTarget) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const label = /^\d{4}$/.test(period) ? period : periodLabel(period);

  // Per currency: what the budgeted categories were given, spent and have left — and what went where nothing was budgeted.
  const totals = useMemo(() => {
    const by = new Map<string, { allocated: number; spentBudgeted: number; spentOther: number; budgeted: number }>();
    for (const r of rows) {
      const t = by.get(r.currency) ?? { allocated: 0, spentBudgeted: 0, spentOther: 0, budgeted: 0 };
      if (r.budgeted) { t.allocated += r.allocatedMinor; t.spentBudgeted += r.spentMinor; t.budgeted++; }
      else t.spentOther += r.spentMinor;
      by.set(r.currency, t);
    }
    return [...by.entries()];
  }, [rows]);

  const cols = canManage ? 7 : 6;
  return (
    <>
      {!loading && totals.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {totals.map(([currency, t]) => (
            <Card key={currency} className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">{label} · {currency} · by category</p>
              <p className={`mt-1 text-xl font-semibold ${t.allocated - t.spentBudgeted < 0 ? "text-red-600" : ""}`}>
                {t.budgeted ? <MoneyDisplay minor={t.allocated - t.spentBudgeted} currency={currency} /> : "No budgets set"}
              </p>
              <p className="mt-1 text-xs text-foreground-muted">
                {t.budgeted ? <>Left in {t.budgeted} budgeted {t.budgeted === 1 ? "category" : "categories"} · <MoneyDisplay minor={t.allocated} currency={currency} /> budgeted · <MoneyDisplay minor={t.spentBudgeted} currency={currency} /> spent there · </> : null}
                <MoneyDisplay minor={t.spentOther} currency={currency} /> spent with no budget
              </p>
            </Card>
          ))}
        </div>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Budgets by category</h2>
          <p className="text-sm text-foreground-muted">
            Spent = every approved expense filed in the category that {/^\d{4}$/.test(period) ? "year" : "month"}, whatever its department. Left = budget − spent.
            A category&apos;s budget is its own, or what its subcategories&apos; budgets add up to. Advances, payroll clearing and VAT aren&apos;t spending, so they aren&apos;t here.
          </p>
        </div>
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b bg-surface-muted/60 text-left text-xs uppercase tracking-wide text-foreground-muted">
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Currency</th>
                  <th className="px-4 py-3 text-right">Budget</th>
                  <th className="px-4 py-3 text-right">Spent</th>
                  <th className="px-4 py-3 text-right">Left</th>
                  <th className="px-4 py-3 text-right">Used</th>
                  {canManage && <th className="px-4 py-3 text-right">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading ? (
                  <tr><td colSpan={cols} className="px-4 py-12 text-center text-foreground-muted">Loading budgets…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={cols} className="px-4 py-12 text-center text-foreground-muted">No expense categories yet.</td></tr>
                ) : rows.map((r) => {
                  const key = `${r.category}|${r.currency}`;
                  const isOpen = open.has(key);
                  const subs = r.subcategories.filter((s) => s.subcategory !== "" || s.spentMinor !== 0);
                  return (
                    <Fragment key={key}>
                      <tr className="hover:bg-surface-muted/40">
                        <td className="px-4 py-3">
                          <button type="button" onClick={() => toggle(key)} aria-expanded={isOpen} className="flex items-center gap-1.5 text-left font-medium hover:text-primary">
                            {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                            {r.categoryName}
                          </button>
                          <span className="ml-6 text-xs text-foreground-muted">{r.expenses} {r.expenses === 1 ? "expense" : "expenses"}</span>
                        </td>
                        <td className="px-4 py-3 text-foreground-muted">{r.currency}</td>
                        <td className="px-4 py-3 text-right">
                          {r.budgeted ? <MoneyDisplay minor={r.allocatedMinor} currency={r.currency} /> : <span className="text-xs text-foreground-muted">No budget</span>}
                          {r.budgetFrom === "subcategories" && <span className="block text-[11px] text-foreground-muted">from its subcategories</span>}
                        </td>
                        <td className="px-4 py-3 text-right"><MoneyDisplay minor={r.spentMinor} currency={r.currency} /></td>
                        <td className="px-4 py-3 text-right"><Left line={{ ...r, currency: r.currency }} /></td>
                        <td className="px-4 py-3"><UsedBar spent={r.spentMinor} allocated={r.budgeted ? r.allocatedMinor : 0} /></td>
                        {canManage && (
                          <td className="px-4 py-3 text-right">
                            <Button size="sm" variant="ghost" onClick={() => onSet({ category: r.category, subcategory: "", currency: r.currency })}>
                              {r.budgetFrom === "category" ? "Adjust" : "Set budget"}
                            </Button>
                          </td>
                        )}
                      </tr>
                      {isOpen && (subs.length === 0 ? (
                        <tr><td colSpan={cols} className="bg-surface-muted/20 px-4 py-3 pl-10 text-xs text-foreground-muted">No subcategories.</td></tr>
                      ) : subs.map((s) => (
                        <tr key={`${key}|${s.subcategory}`} className="bg-surface-muted/20 hover:bg-surface-muted/40">
                          <td className="px-4 py-2 pl-10">
                            <span className={s.subcategory ? "" : "italic text-foreground-muted"}>{s.name}</span>
                            <span className="ml-2 text-xs text-foreground-muted">{s.expenses} {s.expenses === 1 ? "expense" : "expenses"}</span>
                          </td>
                          <td className="px-4 py-2 text-foreground-muted">{r.currency}</td>
                          <td className="px-4 py-2 text-right">{s.budgeted ? <MoneyDisplay minor={s.allocatedMinor} currency={r.currency} /> : <span className="text-xs text-foreground-muted">—</span>}</td>
                          <td className="px-4 py-2 text-right"><MoneyDisplay minor={s.spentMinor} currency={r.currency} /></td>
                          <td className="px-4 py-2 text-right"><Left line={{ ...s, currency: r.currency }} /></td>
                          <td className="px-4 py-2"><UsedBar spent={s.spentMinor} allocated={s.budgeted ? s.allocatedMinor : 0} /></td>
                          {canManage && (
                            <td className="px-4 py-2 text-right">
                              {s.subcategory && (
                                <Button size="sm" variant="ghost" onClick={() => onSet({ category: r.category, subcategory: s.subcategory, currency: r.currency })}>
                                  {s.budgeted ? "Adjust" : "Set"}
                                </Button>
                              )}
                            </td>
                          )}
                        </tr>
                      )))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </>
  );
}

/**
 * Set a category's (or one subcategory's) budget for a month. The amount already set fills in; 0 takes it off.
 * `categories`: the rows on the page, for the names and subcategories to pick from.
 */
export function CategoryBudgetDialog({ open, onOpenChange, target, period, currency, categories }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: CategoryBudgetTarget;
  period: string;
  currency: string;
  categories: CategoryBudgetRow[];
}) {
  const save = useSaveCategoryAllocation();
  const [category, setCategory] = useState("");
  const [sub, setSub] = useState(WHOLE);
  const [month, setMonth] = useState(period);
  const [ccy, setCcy] = useState(currency);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);

  const year = Number((month || period).slice(0, 4));
  const { data: allocationsResult } = useCategoryAllocations({ year }, open && Number.isFinite(year));
  const allocations = allocationsResult?.data ?? [];

  // One entry per category for the pickers (a category shows once per currency in the table).
  const choices = useMemo(() => {
    const m = new Map<string, { name: string; subs: { slug: string; name: string }[] }>();
    for (const r of categories) {
      if (m.has(r.category)) continue;
      m.set(r.category, { name: r.categoryName, subs: r.subcategories.filter((s) => s.subcategory).map((s) => ({ slug: s.subcategory, name: s.name })) });
    }
    return [...m.entries()].map(([slug, v]) => ({ slug, ...v }));
  }, [categories]);
  const picked = choices.find((c) => c.slug === category);
  const subSlug = sub === WHOLE ? "" : sub;
  const current = allocations.find((a) => a.category === category && a.subcategory === subSlug && a.period === month && a.currency === ccy.toUpperCase());

  useEffect(() => {
    if (!open) return;
    setCategory(target?.category ?? "");
    setSub(target?.subcategory || WHOLE);
    setMonth(period);
    setCcy(target?.currency ?? currency);
    setNote("");
    setAmount("");
    setTouched(false);
  }, [open, target, period, currency]);
  // The amount already set for what is picked, until the person types their own.
  useEffect(() => {
    if (!open || touched) return;
    setAmount(current ? (current.allocatedMinor / 100).toFixed(2) : "");
  }, [open, touched, current]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!category || !month || amount === "" || Number(amount) < 0) return;
    try {
      await save.mutateAsync({ category, subcategory: subSlug, period: month, currency: ccy.toUpperCase(), allocatedMinor: toMinor(amount), note });
      toast.success(Number(amount) === 0 ? "Budget taken off" : "Budget saved");
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save the budget");
    }
  };

  const history = current?.changes ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Category budget</DialogTitle>
          <DialogDescription>A month&apos;s budget for an expense category, or one of its subcategories — no department needed. 0 takes it off. Every change is recorded.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={category} onValueChange={(v) => { setCategory(v); setSub(WHOLE); setTouched(false); }}>
              <SelectTrigger><SelectValue placeholder="Choose a category" /></SelectTrigger>
              <SelectContent>{choices.map((c) => <SelectItem key={c.slug} value={c.slug}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Subcategory</Label>
            <Select value={sub} onValueChange={(v) => { setSub(v); setTouched(false); }} disabled={!picked}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={WHOLE}>The whole category</SelectItem>
                {(picked?.subs ?? []).map((s) => <SelectItem key={s.slug} value={s.slug}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Month</Label><Input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setTouched(false); }} required /></div>
            <div className="space-y-1.5"><Label>Currency</Label><Input value={ccy} maxLength={3} onChange={(e) => { setCcy(e.target.value.toUpperCase()); setTouched(false); }} required /></div>
          </div>
          <div className="space-y-1.5">
            <Label>Budget amount</Label>
            <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => { setAmount(e.target.value); setTouched(true); }} placeholder="0.00" required />
            {current && <p className="text-xs text-foreground-muted">Set now: <MoneyDisplay minor={current.allocatedMinor} currency={current.currency} />, by {current.updatedByName}</p>}
          </div>
          <div className="space-y-1.5"><Label>Change note</Label><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this budget, or why it changed" maxLength={500} /></div>
          {history.length > 0 && (
            <div className="rounded-lg border border-border p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted">Recent changes</p>
              <div className="max-h-32 space-y-2 overflow-y-auto">
                {history.slice(-5).reverse().map((change, index) => (
                  <div key={`${change.changedAt}-${index}`} className="flex justify-between gap-3 text-xs">
                    <span className="min-w-0"><span className="font-medium">{change.changedByName}</span>{change.note && <span className="block truncate text-foreground-muted">{change.note}</span>}</span>
                    <span className="shrink-0 text-right text-foreground-muted"><MoneyDisplay minor={change.allocatedMinor} currency={current?.currency ?? ccy} /><span className="block">{new Date(change.changedAt).toLocaleDateString()}</span></span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={save.isPending} disabled={!category || !month || amount === ""}>Save budget</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
