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
import { useCan } from "@/lib/use-can";
import { useRoles } from "@/features/roles/api";
import { useAllDepartments } from "@/features/departments/api";
import { SUPER_ADMIN_OPTION } from "./super-admin";
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
  const { isSuperAdmin: viewerIsSuperAdmin } = useCan();
  const { data: roles } = useRoles({ pageSize: 100, sort: "name", dir: "asc" });
  const { data: departments } = useAllDepartments();

  // Super admin is a flag rather than a role, so it shares the role picker: it
  // is what somebody means when they set what this person may do.
  const initialRole = () => (user.isSuperAdmin ? SUPER_ADMIN_OPTION : user.role.id);

  const [name, setName] = useState(user.name);
  const [roleId, setRoleId] = useState(initialRole);
  const [departmentId, setDepartmentId] = useState(user.department?.id ?? "");

  useEffect(() => {
    if (!open) return;
    setName(user.name);
    setRoleId(user.isSuperAdmin ? SUPER_ADMIN_OPTION : user.role.id);
    setDepartmentId(user.department?.id ?? "");
  }, [open, user]);

  const adminRoleId = (roles?.data ?? []).find((r) => r.key === "admin")?.id;
  const wantsSuperAdmin = roleId === SUPER_ADMIN_OPTION;

  async function submit() {
    if (name.trim().length < 2) return;
    if (wantsSuperAdmin && !adminRoleId) {
      toast.error("This organization has no Administrator role to attach super admin to");
      return;
    }
    try {
      await update.mutateAsync({
        id: user.id,
        input: {
          name: name.trim(),
          roleId: wantsSuperAdmin ? adminRoleId! : roleId,
          departmentId: departmentId || null,
          // Sent only when it changes, so an ordinary edit by an ordinary
          // administrator never touches the field they may not set.
          ...(wantsSuperAdmin !== (user.isSuperAdmin ?? false)
            ? { isSuperAdmin: wantsSuperAdmin }
            : {}),
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
                {/* Shown to a super admin, and to anybody looking at one — so
                    the picker can say what this person actually is rather than
                    silently reading back the role underneath the flag. */}
                {(viewerIsSuperAdmin || user.isSuperAdmin) && (
                  <SelectItem value={SUPER_ADMIN_OPTION} disabled={!viewerIsSuperAdmin}>
                    Super Admin
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            {wantsSuperAdmin && (
              <p className="text-xs text-foreground-muted">
                Full access to every organization on the platform, and to everything in them.
              </p>
            )}
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
