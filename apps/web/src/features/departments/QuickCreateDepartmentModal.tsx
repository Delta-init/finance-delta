"use client";

import { useState } from "react";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCreateDepartment } from "@/features/departments/api";

/**
 * Add a department without leaving the form that needed one.
 *
 * Somebody filing a claim against a department that does not exist yet would
 * otherwise have to abandon what they were typing, go to the admin screens, and
 * come back — which in practice means picking the wrong department instead.
 */
export function QuickCreateDepartmentModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateDepartment();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function close() {
    setName("");
    setDescription("");
    onClose();
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const dept = await create.mutateAsync({ name: trimmed, description: description.trim() });
      toast.success(`${dept.name} added`);
      onCreated(dept.id);
      close();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not add the department");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-foreground-muted" /> New department
          </DialogTitle>
          <DialogDescription>
            It becomes available everywhere departments are used, not just here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="dept-name">Name</Label>
            <Input
              id="dept-name"
              value={name}
              maxLength={80}
              autoFocus
              placeholder="e.g. Digital Academy"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                // Enter submits the dialog, not the form underneath it.
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dept-desc">Description</Label>
            <Input
              id="dept-desc"
              value={description}
              maxLength={300}
              placeholder="Optional"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
          <Button
            type="button"
            loading={create.isPending}
            disabled={name.trim().length === 0}
            onClick={submit}
          >
            Add department
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
