"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { FolderPlus } from "lucide-react";
import { createExpenseCategorySchema, type ExpenseCategoryRecord } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useCreateExpenseCategory } from "./api";

type Values = z.infer<typeof createExpenseCategorySchema>;

/**
 * A category, made where you noticed you needed one.
 *
 * Claiming a spend that no category described meant leaving the claim, going
 * to the categories page, adding one, and coming back to type the claim again
 * — so in practice people picked "Other" instead, and the reports filled up
 * with a column that says nothing.
 *
 * "Other" is still there, and still right for a genuine one-off. This is for
 * the case it was standing in for: a kind of spend that will come round again
 * and deserves its own line in the report.
 */
export function QuickCreateCategoryModal({
  open,
  onClose,
  onCreated,
  existing,
}: {
  open: boolean;
  onClose: () => void;
  /** The new category's slug, which is what the picker stores. */
  onCreated: (slug: string, name: string) => void;
  /** Used to catch a duplicate before the server has to. */
  existing?: ExpenseCategoryRecord[];
}) {
  const createCategory = useCreateExpenseCategory();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(createExpenseCategorySchema),
    defaultValues: { name: "" },
  });

  // Said while typing rather than after submitting, and it points at the
  // category that already exists instead of only refusing.
  const typed = (watch("name") ?? "").trim().toLowerCase();
  const clash = typed
    ? existing?.find((c) => c.name.trim().toLowerCase() === typed)
    : undefined;

  async function submit(values: Values) {
    setServerError(null);
    if (clash) {
      onCreated(clash.slug, clash.name);
      reset();
      return;
    }
    try {
      const category = await createCategory.mutateAsync(values);
      reset();
      onCreated(category.slug, category.name);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Failed to create category");
    }
  }

  function handleClose() {
    reset();
    setServerError(null);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus className="h-4 w-4" />
            New Category
          </DialogTitle>
          <DialogDescription>
            It will be available on every expense from now on, and gets its own line in the
            expense reports.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name *</Label>
            <Input
              {...register("name")}
              placeholder="e.g. Staff welfare"
              maxLength={60}
              autoFocus
            />
            {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
            {clash && (
              <p className="text-xs text-foreground-muted">
                “{clash.name}” already exists — this will just select it.
              </p>
            )}
          </div>
          {serverError && <p className="text-sm text-danger">{serverError}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClose}>Cancel</Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : clash ? "Use existing" : "Create Category"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
