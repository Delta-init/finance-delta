"use client";

import { useEffect, useState } from "react";
import { Mail, UserCog } from "lucide-react";
import type { User } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useInviteUser, useUpdateUser } from "./api";

/** Radix reads "" as unset, so "no department" needs a value of its own. */
const NO_DEPARTMENT = "__none__";

/**
 * Changing who somebody is and what they may do — everything about them (the user, 2026-10-20: "we can edit
 * everything").
 *
 * The email is how they sign in and where every invite and notification goes, so changing it says so before it is
 * saved; another account already using it is refused. A new password is set here by an administrator, or an invite
 * sent so they set their own.
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
  const invite = useInviteUser();
  const { isSuperAdmin: viewerIsSuperAdmin } = useCan();
  const { data: roles } = useRoles({ pageSize: 100, sort: "name", dir: "asc" });
  const { data: departments } = useAllDepartments();

  // Super admin is a flag rather than a role, so it shares the role picker: it
  // is what somebody means when they set what this person may do.
  const initialRole = () => (user.isSuperAdmin ? SUPER_ADMIN_OPTION : user.role.id);

  const [name, setName] = useState(user.name);
  const [roleId, setRoleId] = useState(initialRole);
  const [departmentId, setDepartmentId] = useState(user.department?.id ?? "");
  const [isManager, setIsManager] = useState(user.isManager ?? false);
  const [email, setEmail] = useState(user.email);
  const [status, setStatus] = useState<"active" | "suspended">(user.status);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(user.name);
    setEmail(user.email);
    setStatus(user.status);
    setPassword("");
    setRoleId(user.isSuperAdmin ? SUPER_ADMIN_OPTION : user.role.id);
    setDepartmentId(user.department?.id ?? "");
    setIsManager(user.isManager ?? false);
  }, [open, user]);

  const adminRoleId = (roles?.data ?? []).find((r) => r.key === "admin")?.id;
  const wantsSuperAdmin = roleId === SUPER_ADMIN_OPTION;

  const emailChanged = email.trim().toLowerCase() !== user.email.toLowerCase();
  const emailOk = /^\S+@\S+\.\S+$/.test(email.trim());
  const passwordOk = password === "" || password.length >= 8;

  async function sendInvite() {
    try {
      const r = await invite.mutateAsync(user.id);
      (r.delivered ? toast.success : toast.error)(r.message);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not send the invite");
    }
  }

  async function submit() {
    if (name.trim().length < 2 || !emailOk || !passwordOk) return;
    if (wantsSuperAdmin && !adminRoleId) {
      toast.error("This organization has no Administrator role to attach super admin to");
      return;
    }
    try {
      await update.mutateAsync({
        id: user.id,
        input: {
          name: name.trim(),
          ...(emailChanged ? { email: email.trim().toLowerCase() } : {}),
          ...(password ? { password } : {}),
          status,
          roleId: wantsSuperAdmin ? adminRoleId! : roleId,
          departmentId: departmentId || null,
          isManager,
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
          <DialogDescription>Everything about {user.name}: how they sign in, what they may do, and where.</DialogDescription>
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
            <Label htmlFor="user-email">Email</Label>
            <Input id="user-email" type="email" value={email} maxLength={160} onChange={(e) => setEmail(e.target.value)} />
            {emailChanged && emailOk && (
              <p className="text-xs text-warning">They sign in with {email.trim().toLowerCase()} from now on, and invites and notices go there.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as "active" | "suspended")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active — can sign in</SelectItem>
                <SelectItem value="suspended">Suspended — can&apos;t sign in, history kept</SelectItem>
              </SelectContent>
            </Select>
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

          {/* The Manager tag (2026-10-17): approves or rejects what is entered with an old date. */}
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-3">
            <Checkbox checked={isManager} onChange={() => setIsManager((v) => !v)} aria-label="Manager" className="mt-0.5" />
            <span>
              <span className="block text-sm font-medium">Manager</span>
              <span className="block text-xs text-foreground-muted">
                Sees Late Entries, and approves or rejects expenses, bills and payments entered with an old date.
              </span>
            </span>
          </label>

          <div className="space-y-1.5 rounded-md border border-border p-3">
            <Label htmlFor="user-password">New password</Label>
            <Input id="user-password" type="password" autoComplete="new-password" value={password}
              placeholder="Leave empty to keep their password" onChange={(e) => setPassword(e.target.value)} />
            {!passwordOk && <p className="text-xs text-danger">At least 8 characters.</p>}
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-xs text-foreground-muted">Or email them a link to set their own.</span>
              <Button size="sm" variant="secondary" loading={invite.isPending} disabled={status !== "active" || user.status !== "active"} onClick={sendInvite}>
                <Mail className="h-4 w-4" /> Send invite
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            loading={update.isPending}
            disabled={name.trim().length < 2 || !roleId || !emailOk || !passwordOk}
            onClick={submit}
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
