"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Pencil, Trash2, Tag } from "lucide-react";
import type { ExpenseCategoryRecord } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  useExpenseCategories,
  useCreateExpenseCategory,
  useUpdateExpenseCategory,
  useDeleteExpenseCategory,
} from "@/features/expense-categories/api";

function RenameDialog({ category, onClose }: { category: ExpenseCategoryRecord; onClose: () => void }) {
  const [name, setName] = useState(category.name);
  const update = useUpdateExpenseCategory(category.id);
  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await update.mutateAsync({ name: trimmed });
      toast.success("Category updated");
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to update category");
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Rename category</DialogTitle></DialogHeader>
        <div className="space-y-1.5">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }} />
          <p className="text-xs text-foreground-muted">Renaming updates this category everywhere it&apos;s used.</p>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
          <Button onClick={handleSave} loading={update.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
  const create = useCreateExpenseCategory();
  const [newName, setNewName] = useState("");
  const [renameTarget, setRenameTarget] = useState<ExpenseCategoryRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExpenseCategoryRecord | null>(null);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    try {
      await create.mutateAsync({ name });
      toast.success("Category added");
      setNewName("");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to add category");
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/expenses" className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Expense Categories</h1>
          <p className="text-sm text-foreground-muted">Add, rename, or remove the categories used across expenses.</p>
        </div>
      </div>

      <div className="flex items-end gap-2 rounded-lg border border-border bg-surface p-4">
        <div className="flex-1 space-y-1.5">
          <Label>New category</Label>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Software Subscriptions"
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          />
        </div>
        <Button onClick={handleCreate} loading={create.isPending} disabled={!newName.trim()}>
          <Plus className="h-4 w-4" /> Add
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
              <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                <Tag className="h-4 w-4 shrink-0 text-foreground-muted" />
                <span className="flex-1 font-medium">{c.name}</span>
                {c.isSystem && <Badge tone="neutral">Default</Badge>}
                <span className="text-xs text-foreground-muted">
                  {c.expenseCount} expense{c.expenseCount === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  title="Rename"
                  onClick={() => setRenameTarget(c)}
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
              </li>
            ))}
          </ul>
        )}
      </div>

      {renameTarget && <RenameDialog category={renameTarget} onClose={() => setRenameTarget(null)} />}
      {deleteTarget && <DeleteDialog category={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </div>
  );
}
