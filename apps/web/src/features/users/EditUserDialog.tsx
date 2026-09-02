"use client";

import { useEffect, useState } from "react";
import { UserCog } from "lucide-react";
import type { User } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useRoles } from "@/features/roles/api";
import { useAllDepartments } from "@/features/departments/api";
import { useUpdateUser } from "./api";

/** Radix reads "" as unset, so "no department" needs a value of its own. */
const NO_DEPARTMENT = "__none__";

/**
 * Changing who somebody is and what they may do.
 *
 * The email is shown and cannot be edited: it is how they sign in and what
 * every invite and notification was sent to, so changing it here would quietly
 * lock somebody out rather than correct a typo. A wrong address means a new
 * account.
 */
export function EditUserDialog({
  user,
  open,
  onClose,
}: {
  user: User;
  open: boolean;
  onClose: () => void;
}) {
  const update = useUpdateUser();
  const { data: roles } = useRoles({ pageSize: 100, sort: "name", dir: "asc" });
  const { data: departments } = useAllDepartments();

  const [name, setName] = useState(user.name);
  const [roleId, setRoleId] = useState(user.role.id);
  const [departmentId, setDepartmentId] = useState(user.department?.id ?? "");

  useEffect(() => {
    if (!open) return;
    setName(user.name);
    setRoleId(user.role.id);
    setDepartmentId(user.department?.id ?? "");
  }, [open, user]);

  async function submit() {
    if (name.trim().length < 2) return;
    try {
      await update.mutateAsync({
        id: user.id,
        input: {
          name: name.trim(),
          roleId,
          departmentId: departmentId || null,
        },
      });
      toast.success(`${name.trim()} saved`);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save the changes");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCog className="h-4 w-4 text-foreground-muted" /> Edit user
          </DialogTitle>
          <DialogDescription>{user.email}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="user-name">Name</Label>
            <Input
              id="user-name"
              value={name}
              maxLength={80}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void submit())}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger><SelectValue placeholder="Select a role" /></SelectTrigger>
              <SelectContent>
                {(roles?.data ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Department</Label>
            <Select
              value={departmentId || NO_DEPARTMENT}
              onValueChange={(v) => setDepartmentId(v === NO_DEPARTMENT ? "" : v)}
            >
              <SelectTrigger><SelectValue placeholder="No department" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DEPARTMENT}>No department</SelectItem>
                {(departments ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            loading={update.isPending}
            disabled={name.trim().length < 2 || !roleId}
            onClick={submit}
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
