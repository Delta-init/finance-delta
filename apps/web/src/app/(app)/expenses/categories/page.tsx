"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Pencil, Trash2, Tag } from "lucide-react";
import type { ExpenseCategoryRecord } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useExpenseCategories, useDeleteExpenseCategory } from "@/features/expense-categories/api";
import { CategoryEditor } from "@/features/expense-categories/CategoryEditor";

function DeleteDialog({ category, onClose }: { category: ExpenseCategoryRecord; onClose: () => void }) {
  const del = useDeleteExpenseCategory();
  const blocked = category.expenseCount > 0;
  async function handleDelete() {
    try {
      await del.mutateAsync(category.id);
      toast.success("Category deleted");
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to delete category");
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Delete category?</DialogTitle></DialogHeader>
        {blocked ? (
          <p className="text-sm text-foreground-muted">
            <span className="font-medium text-foreground">{category.name}</span> is used by{" "}
            {category.expenseCount} expense{category.expenseCount > 1 ? "s" : ""}, so it can&apos;t be deleted.
            Reassign those expenses to another category first.
          </p>
        ) : (
          <p className="text-sm text-foreground-muted">
            This permanently removes <span className="font-medium text-foreground">{category.name}</span>. This can&apos;t be undone.
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild><Button type="button" variant="ghost">{blocked ? "Close" : "Cancel"}</Button></DialogClose>
          {!blocked && <Button variant="destructive" onClick={handleDelete} loading={del.isPending}>Delete</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ExpenseCategoriesPage() {
  const { data: categories, isLoading } = useExpenseCategories();
  // undefined: closed; null: a new one; a record: that one.
  const [editing, setEditing] = useState<ExpenseCategoryRecord | null | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<ExpenseCategoryRecord | null>(null);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/expenses" className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-semibold">Expense Categories</h1>
          <p className="text-sm text-foreground-muted">Each expense is filed under a category and one of its subcategories.</p>
        </div>
        <Button onClick={() => setEditing(null)}>
          <Plus className="h-4 w-4" /> New category
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-foreground-muted">Loading…</div>
        ) : !categories || categories.length === 0 ? (
          <div className="p-6 text-center text-sm text-foreground-muted">No categories yet.</div>
        ) : (
          <ul className="divide-y divide-border">
            {categories.map((c) => (
              <li key={c.id} className="space-y-2 px-4 py-3">
                <div className="flex items-center gap-3">
                  <Tag className="h-4 w-4 shrink-0 text-foreground-muted" />
                  <span className="flex-1 font-medium">{c.name}</span>
                  {!c.inPnl && <Badge tone="warning">Not in P&amp;L</Badge>}
                  {c.isSystem && <Badge tone="neutral">Default</Badge>}
                  <span className="text-xs text-foreground-muted">
                    {c.expenseCount} expense{c.expenseCount === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    title="Edit"
                    onClick={() => setEditing(c)}
                    className="rounded p-1.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    onClick={() => setDeleteTarget(c)}
                    className="rounded p-1.5 text-foreground-muted hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {c.subcategories.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pl-7">
                    {c.subcategories.map((s) => {
                      const out = (s.inPnl ?? c.inPnl) === false;
                      return (
                        <span
                          key={s.slug}
                          title={out ? "Not in profit & loss" : undefined}
                          className={`rounded-md border px-2 py-0.5 text-xs ${out ? "border-warning/40 text-warning" : "border-border text-foreground-muted"}`}
                        >
                          {s.name}
                          {s.expenseCount > 0 && <span className="ml-1 tabular-nums opacity-70">{s.expenseCount}</span>}
                        </span>
                      );
                    })}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing !== undefined && (
        <CategoryEditor
          category={editing ?? undefined}
          existing={categories}
          onClose={() => setEditing(undefined)}
          onSaved={() => toast.success(editing ? "Category updated" : "Category added")}
        />
      )}
      {deleteTarget && <DeleteDialog category={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </div>
  );
}
