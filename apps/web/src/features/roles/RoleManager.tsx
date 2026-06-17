"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2, Lock, Search, ShieldCheck } from "lucide-react";
import {
  ASSIGNABLE_PERMISSIONS,
  createRoleSchema,
  type CreateRoleInput,
  type Role,
} from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useTableQuery } from "@/lib/use-table-query";
import { useCreateRole, useDeleteRole, useRoles } from "./api";

export function RoleManager() {
  const t = useTableQuery({ initialSort: { key: "name", dir: "asc" } });
  const { data, isLoading } = useRoles(t.baseParams);
  const createRole = useCreateRole();
  const deleteRole = useDeleteRole();
  const [open, setOpen] = useState(false);

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } =
    useForm<CreateRoleInput>({
      resolver: zodResolver(createRoleSchema),
      defaultValues: { name: "", description: "", permissions: [] },
    });

  const columns: Column<Role>[] = [
    {
      key: "name",
      header: "Role",
      sortable: true,
      cell: (role) => (
        <div>
          <div className="font-medium">{role.name}</div>
          <div className="text-xs text-foreground-subtle">{role.description || "—"}</div>
        </div>
      ),
    },
    {
      key: "permissions",
      header: "Permissions",
      cell: (role) => (
        <span className="text-foreground-muted">
          {role.permissions.includes("*") ? "All permissions" : `${role.permissions.length} permissions`}
        </span>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (role) =>
        role.isSystem ? (
          <Badge tone="primary">
            <Lock className="mr-1 h-3 w-3" /> System
          </Badge>
        ) : (
          <Badge>Custom</Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (role) =>
        role.isSystem ? null : (
          <Button variant="ghost" size="icon" onClick={() => deleteRole.mutate(role.id, { onSuccess: () => toast.success("Role deleted"), onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to delete role") })} aria-label={`Delete ${role.name}`}>
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        ),
    },
  ];

  function openModal() {
    reset();
    setOpen(true);
  }

  async function onSubmit(values: CreateRoleInput) {
    try {
      await createRole.mutateAsync(values);
      toast.success("Role created");
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to create role");
    }
  }

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={ShieldCheck}
        title="Roles"
        description="Define what each role can access. System roles are built in."
        action={
          <Button onClick={openModal}>
            <Plus className="h-4 w-4" /> New role
          </Button>
        }
      />

      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
        <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search roles…" className="pl-8" />
      </div>

      <ResponsiveModal open={open} onOpenChange={setOpen}>
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Create role</ResponsiveModalTitle>
            <ResponsiveModalDescription>Name the role and choose the permissions it grants.</ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="name">Role name</Label>
                <Input id="name" placeholder="e.g. Auditor" {...register("name")} />
                {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="description">Description</Label>
                <Input id="description" placeholder="Optional" {...register("description")} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Permissions</Label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {ASSIGNABLE_PERMISSIONS.map((perm) => (
                  <label key={perm} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-muted">
                    <input type="checkbox" value={perm} className="accent-[var(--primary)]" {...register("permissions")} />
                    <span className="font-mono text-xs">{perm}</span>
                  </label>
                ))}
              </div>
              {errors.permissions && <p className="text-xs text-danger">{errors.permissions.message}</p>}
            </div>
            <ResponsiveModalFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" loading={isSubmitting}>Create role</Button>
            </ResponsiveModalFooter>
          </form>
        </ResponsiveModalContent>
      </ResponsiveModal>

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
