"use client";

import { useState } from "react";
import { Plus, Trash2, Lock, Search, ShieldCheck, Pencil } from "lucide-react";
import { summarisePermissions, type Role } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useTableQuery } from "@/lib/use-table-query";
import { PermissionPicker } from "./PermissionPicker";
import { useCreateRole, useDeleteRole, useRoles, useUpdateRole } from "./api";

/**
 * The Administrator role is the one thing here nobody may change.
 *
 * Every other built-in role is an opinion about how this organization works and
 * can be edited to match it. Administrator is the way back in: a permission
 * removed from it could lock the last administrator out of the screen that
 * would let them put it back.
 */
const isLocked = (role: Role) => role.permissions.includes("*") || role.key === "admin";

type Draft = { id?: string; name: string; description: string; permissions: string[] };

const EMPTY: Draft = { name: "", description: "", permissions: [] };

export function RoleManager() {
  const t = useTableQuery({ initialSort: { key: "name", dir: "asc" } });
  const { data, isLoading } = useRoles(t.baseParams);
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const deleteRole = useDeleteRole();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Role | null>(null);
  const [saving, setSaving] = useState(false);

  const editing = Boolean(draft?.id);

  function openNew() {
    setDraft({ ...EMPTY });
  }

  function openEdit(role: Role) {
    setDraft({
      id: role.id,
      name: role.name,
      description: role.description ?? "",
      permissions: [...role.permissions],
    });
  }

  async function save() {
    if (!draft) return;
    if (draft.name.trim().length < 2) {
      toast.error("Give the role a name of at least two characters");
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        permissions: draft.permissions,
      };
      if (draft.id) {
        await updateRole.mutateAsync({ id: draft.id, input });
        toast.success("Role updated");
      } else {
        await createRole.mutateAsync(input);
        toast.success("Role created");
      }
      setDraft(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save the role");
    } finally {
      setSaving(false);
    }
  }

  async function remove(role: Role) {
    try {
      await deleteRole.mutateAsync(role.id);
      toast.success(`${role.name} deleted`);
      setConfirmDelete(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not delete the role");
    }
  }

  const columns: Column<Role>[] = [
    {
      key: "name",
      header: "Role",
      sortable: true,
      cell: (role) => (
        <div>
          <div className="flex items-center gap-1.5 font-medium">
            {role.name}
            {isLocked(role) && (
              <Tooltip label="The way back in — this one cannot be changed">
                <Lock className="h-3 w-3 text-foreground-subtle" />
              </Tooltip>
            )}
          </div>
          <div className="text-xs text-foreground-subtle">{role.description || "—"}</div>
        </div>
      ),
    },
    {
      // Names what the role reaches. A count told somebody choosing a role for a
      // new colleague nothing at all.
      key: "permissions",
      header: "Can reach",
      cell: (role) => (
        <span className="text-sm text-foreground-muted">
          {summarisePermissions(role.permissions)}
        </span>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (role) =>
        role.isSystem ? <Badge tone="primary">Built in</Badge> : <Badge>Custom</Badge>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (role) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => openEdit(role)}
            aria-label={isLocked(role) ? `View ${role.name}` : `Edit ${role.name}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          {/* Built-in roles stay: something in the application expects them to
              exist, and a custom role in use is somebody's access today. */}
          {!role.isSystem && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setConfirmDelete(role)}
              aria-label={`Delete ${role.name}`}
            >
              <Trash2 className="h-4 w-4 text-danger" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  const locked = draft?.id ? isLocked(data?.data?.find((r) => r.id === draft.id) ?? ({} as Role)) : false;

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={ShieldCheck}
        title="Roles"
        description="What each role can reach. Built-in roles can be adjusted to how you work — only Administrator is fixed."
        action={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" /> New role
          </Button>
        }
      />

      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
        <Input
          value={t.q}
          onChange={(e) => t.setQ(e.target.value)}
          placeholder="Search roles…"
          className="pl-8"
        />
      </div>

      <ResponsiveModal open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <ResponsiveModalContent className="sm:max-w-3xl">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>
              {locked ? draft?.name : editing ? `Edit ${draft?.name || "role"}` : "New role"}
            </ResponsiveModalTitle>
            <ResponsiveModalDescription>
              {locked
                ? "The Administrator role holds every permission and cannot be changed — it is what guarantees somebody can always get back in."
                : "Name the role, then choose what it can reach. Changes apply to everyone holding it."}
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>

          {draft && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="role-name">Role name</Label>
                  <Input
                    id="role-name"
                    value={draft.name}
                    disabled={locked}
                    placeholder="e.g. Auditor"
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="role-description">Description</Label>
                  <Input
                    id="role-description"
                    value={draft.description}
                    disabled={locked}
                    placeholder="What this role is for"
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Permissions</Label>
                {locked ? (
                  <p className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-foreground-muted">
                    Every permission, including any added in future.
                  </p>
                ) : (
                  <PermissionPicker
                    value={draft.permissions}
                    onChange={(permissions) => setDraft({ ...draft, permissions })}
                  />
                )}
              </div>
            </div>
          )}

          <ResponsiveModalFooter>
            <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
              {locked ? "Close" : "Cancel"}
            </Button>
            {!locked && (
              <Button onClick={save} loading={saving}>
                {editing ? "Save changes" : "Create role"}
              </Button>
            )}
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>

      <Dialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {confirmDelete?.name}?</DialogTitle>
            <DialogDescription>
              This cannot be undone. A role somebody still holds cannot be deleted — reassign them
              first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={deleteRole.isPending}
              onClick={() => confirmDelete && remove(confirmDelete)}
            >
              Delete role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(r) => r.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        isLoading={isLoading}
        emptyMessage="No roles match your search."
      />
    </div>
  );
}
