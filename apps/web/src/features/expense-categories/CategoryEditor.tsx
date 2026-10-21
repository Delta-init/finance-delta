"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { ExpenseCategoryRecord } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { useCreateExpenseCategory, useUpdateExpenseCategory } from "./api";

interface SubRow { key: string; slug?: string; name: string; inPnl: boolean; expenseCount: number }

let seq = 0;
const rowKey = () => `row-${++seq}`;

/**
 * A category with its subcategories (2026-10-21), made or changed in one go.
 *
 * Each has "counts in profit & loss": off for what is recorded but is not an
 * expense — money staff owe back, payroll clearing, VAT, a loan's principal. A
 * subcategory follows its category unless set otherwise. One with expenses can
 * be renamed but not removed.
 */
export function CategoryEditor({ category, existing, onClose, onSaved }: {
  /** The one being edited; none to make a new one. */
  category?: ExpenseCategoryRecord;
  /** Used to catch a duplicate name before the server has to. */
  existing?: ExpenseCategoryRecord[];
  onClose: () => void;
  onSaved?: (saved: ExpenseCategoryRecord) => void;
}) {
  const create = useCreateExpenseCategory();
  const update = useUpdateExpenseCategory(category?.id ?? "");
  const [name, setName] = useState(category?.name ?? "");
  const [inPnl, setInPnl] = useState(category?.inPnl ?? true);
  const [subs, setSubs] = useState<SubRow[]>(() =>
    category?.subcategories.length
      ? category.subcategories.map((s) => ({ key: rowKey(), slug: s.slug, name: s.name, inPnl: s.inPnl ?? category.inPnl, expenseCount: s.expenseCount }))
      : [{ key: rowKey(), name: "", inPnl: category?.inPnl ?? true, expenseCount: 0 }],
  );
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending;

  const typed = name.trim().toLowerCase();
  const clash = typed ? existing?.find((c) => c.id !== category?.id && c.name.trim().toLowerCase() === typed) : undefined;
  const filled = subs.filter((s) => s.name.trim());
  const dupe = filled.find((s, i) => filled.findIndex((x) => x.name.trim().toLowerCase() === s.name.trim().toLowerCase()) !== i);

  const setSub = (key: string, patch: Partial<SubRow>) => setSubs((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  // The category's switch carries its subcategories that were following it.
  const flipCategory = (on: boolean) => {
    setSubs((rows) => rows.map((r) => (r.inPnl === inPnl ? { ...r, inPnl: on } : r)));
    setInPnl(on);
  };

  async function save() {
    setError(null);
    if (!name.trim()) return setError("Name the category");
    if (clash) return setError(`"${clash.name}" already exists`);
    if (!filled.length) return setError("Add at least one subcategory");
    if (dupe) return setError(`"${dupe.name.trim()}" is listed twice`);
    // Sent only where it differs from the category, so it keeps following it.
    const subcategories = filled.map((s) => ({
      ...(s.slug ? { slug: s.slug } : {}),
      name: s.name.trim(),
      ...(s.inPnl !== inPnl ? { inPnl: s.inPnl } : {}),
    }));
    try {
      const saved = category
        ? await update.mutateAsync({ name: name.trim(), inPnl, subcategories })
        : await create.mutateAsync({ name: name.trim(), inPnl, subcategories });
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the category");
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{category ? "Edit category" : "New category"}</DialogTitle>
          <DialogDescription>
            {category ? "Renaming updates it on every expense filed under it." : "It is offered on every expense from now on, with its subcategories."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="category-name">Name *</Label>
            <Input id="category-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Student Refunds" autoFocus />
            {clash && <p className="text-xs text-danger">&ldquo;{clash.name}&rdquo; already exists.</p>}
          </div>

          <label className="flex items-start gap-2.5">
            <input type="checkbox" checked={inPnl} onChange={(e) => flipCategory(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--primary)]" />
            <span>
              <span className="block text-sm font-medium">Counts in profit &amp; loss</span>
              <span className="block text-xs text-foreground-muted">
                Off for what is recorded but is not an expense — advances staff pay back, payroll clearing, VAT. Those stay
                in the Expenses list and in cash flow.
              </span>
            </span>
          </label>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Subcategories *</Label>
              <span className="text-xs text-foreground-muted">In P&amp;L</span>
            </div>
            <ul className="space-y-2">
              {subs.map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  <Input
                    aria-label="Subcategory name"
                    value={s.name}
                    onChange={(e) => setSub(s.key, { name: e.target.value })}
                    maxLength={60}
                    placeholder="e.g. Course Refunds"
                    className="flex-1"
                  />
                  <input
                    type="checkbox"
                    aria-label={`${s.name || "This subcategory"} counts in profit & loss`}
                    title="Counts in profit & loss"
                    checked={s.inPnl}
                    onChange={(e) => setSub(s.key, { inPnl: e.target.checked })}
                    className="h-4 w-4 shrink-0 accent-[var(--primary)]"
                  />
                  <button
                    type="button"
                    title={s.expenseCount ? `Used by ${s.expenseCount} expense${s.expenseCount === 1 ? "" : "s"} — move them first` : "Remove"}
                    disabled={s.expenseCount > 0 || subs.length === 1}
                    onClick={() => setSubs((rows) => rows.filter((r) => r.key !== s.key))}
                    className="rounded p-1.5 text-foreground-muted hover:bg-danger/10 hover:text-danger disabled:pointer-events-none disabled:opacity-40"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setSubs((rows) => [...rows, { key: rowKey(), name: "", inPnl, expenseCount: 0 }])}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Plus className="h-3 w-3" /> Add subcategory
            </button>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} loading={busy}>{category ? "Save" : "Create category"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
