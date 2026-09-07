"use client";

import { useEffect, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil, Plus, Search, Trash2, UserCheck, UserX, Users2 } from "lucide-react";
import { createUserSchema, type CreateUserInput, type User } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ExportButton } from "@/components/ui/export-button";
import type { ExportColumn } from "@/lib/export";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { TagList } from "@/features/tags/TagBadge";
import { TagPicker } from "@/features/tags/TagPicker";
import { Tooltip } from "@/components/ui/tooltip";
import { EditUserDialog } from "@/features/users/EditUserDialog";
import { SUPER_ADMIN_OPTION, roleLabel } from "./super-admin";
import {
  Dialog as ConfirmDialog,
  DialogContent as ConfirmContent,
  DialogHeader as ConfirmHeader,
  DialogTitle as ConfirmTitle,
  DialogDescription as ConfirmDescription,
  DialogFooter as ConfirmFooter,
} from "@/components/ui/dialog";
import { useCan } from "@/lib/use-can";
import { useRoles } from "@/features/roles/api";
import { useAllDepartments } from "@/features/departments/api";
import { useCreateUser, useRemoveUser, useUpdateUser, useUsers } from "./api";

const USERS_EXPORT_COLUMNS: ExportColumn<User>[] = [
  { header: "Name", value: (u) => u.name || "—" },
  { header: "Email", value: (u) => u.email },
  { header: "Role", value: (u) => roleLabel(u) },
  { header: "Department", value: (u) => u.department?.name ?? "—" },
  { header: "Tags", value: (u) => u.tags.map((tag) => tag.name).join(", ") },
  { header: "Status", value: (u) => u.status },
  { header: "Created", value: (u) => u.createdAt },
];

export function UserManager() {
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  const [status, setStatus] = useState("all");
  const [tagIds, setTagIds] = useState<string[]>([]);
  useEffect(() => t.resetPage(), [status, tagIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useUsers({
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    tagIds: tagIds.length ? tagIds : undefined,
    // This screen is the staff list. Accounts that exist only so a payroll
    // employee can be named as a salesperson hold no permissions and cannot be
    // signed into; listing them here buries the real users under the roster.
    // They appear in the salesperson pickers, and on the salesperson report.
    excludePayrollOnly: "true",
  });
  const { isSuperAdmin } = useCan();
  const { data: roles } = useRoles({ pageSize: 100 });
  const { data: departments } = useAllDepartments();
  const createUser = useCreateUser();

  const [open, setOpen] = useState(false);
  const update = useUpdateUser();
  const remove = useRemoveUser();
  const [editing, setEditing] = useState<User | null>(null);
  const [removing, setRemoving] = useState<User | null>(null);

  const { register, handleSubmit, control, reset, watch, setValue, formState: { errors, isSubmitting } } =
    useForm<CreateUserInput>({
      resolver: zodResolver(createUserSchema),
      defaultValues: { name: "", email: "", password: "", roleId: "", tagIds: [] },
    });

  const columns: Column<User>[] = [
    { key: "name", header: "Name", sortable: true, cell: (u) => <span className="font-medium">{u.name || "—"}</span> },
    { key: "email", header: "Email", sortable: true, cell: (u) => <span className="text-foreground-muted">{u.email}</span> },
    {
      key: "role",
      header: "Role",
      cell: (u) =>
        u.isSuperAdmin ? <Badge tone="primary">Super Admin</Badge> : u.role.name,
    },
    { key: "department", header: "Department", cell: (u) => u.department?.name ?? <span className="text-foreground-subtle">—</span> },
    { key: "tags", header: "Tags", cell: (u) => <TagList tags={u.tags} /> },
    {
      key: "status",
      header: "Status",
      sortable: true,
      cell: (u) => <Badge tone={u.status === "active" ? "success" : "warning"}>{u.status}</Badge>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      hideInDetail: true,
      cell: (u) => (
        <div className="flex items-center justify-end gap-2">
          <Tooltip label="Edit">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setEditing(u); }}
              className="text-foreground-subtle hover:text-primary"
              aria-label={`Edit ${u.name}`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </Tooltip>

          {/* Suspending is what "remove access" usually means: they cannot sign
              in, and everything with their name on it still says who did it. */}
          <Tooltip label={u.status === "active" ? "Suspend" : "Reactivate"}>
            <button
              type="button"
              disabled={update.isPending}
              onClick={(e) => { e.stopPropagation(); void toggleStatus(u); }}
              className="text-foreground-subtle hover:text-warning disabled:opacity-50"
              aria-label={u.status === "active" ? `Suspend ${u.name}` : `Reactivate ${u.name}`}
            >
              {u.status === "active" ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />}
            </button>
          </Tooltip>

          <Tooltip label="Remove">
            <button
              type="button"
              disabled={remove.isPending}
              onClick={(e) => { e.stopPropagation(); setRemoving(u); }}
              className="text-foreground-subtle hover:text-danger disabled:opacity-50"
              aria-label={`Remove ${u.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      ),
    },
  ];

  async function toggleStatus(u: User) {
    const next = u.status === "active" ? "suspended" : "active";
    try {
      await update.mutateAsync({ id: u.id, input: { status: next } });
      toast.success(next === "suspended" ? `${u.name} suspended` : `${u.name} reactivated`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not change their status");
    }
  }

  async function confirmRemove(u: User) {
    try {
      await remove.mutateAsync(u.id);
      toast.success(`${u.name} removed`);
      setRemoving(null);
    } catch (e) {
      // The server refuses while their name is on a document, and says what it
      // is on — worth showing in full rather than shortening to "failed".
      toast.error(e instanceof ApiError ? e.message : "Could not remove them");
    }
  }

  function openModal() {
    reset({ name: "", email: "", password: "", roleId: "", tagIds: [] });
    setOpen(true);
  }

  async function onSubmit(values: CreateUserInput) {
    const adminRoleId = roles?.data.find((r) => r.key === "admin")?.id;
    if (values.roleId === SUPER_ADMIN_OPTION && !adminRoleId) {
      toast.error("This organization has no Administrator role to attach super admin to");
      return;
    }
    const payload: CreateUserInput =
      values.roleId === SUPER_ADMIN_OPTION
        ? { ...values, roleId: adminRoleId!, isSuperAdmin: true }
        : values;
    try {
      await createUser.mutateAsync(payload);
      toast.success("User created");
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to create user");
    }
  }

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={Users2}
        title="Users"
        description="Team members who can sign in, scoped by their role."
        action={
          <div className="flex items-center gap-2">
            <ExportButton
              resource="users"
              params={{
                ...t.baseParams,
                status: status === "all" ? undefined : status,
                tagIds: tagIds.length ? tagIds : undefined,
                // Must match the table's own query, or the export hands back a
                // roster of payroll accounts the screen never showed.
                excludePayrollOnly: "true",
              }}
              columns={USERS_EXPORT_COLUMNS}
              filename="users"
              title="Users"
              size="md"
            />
            <Button onClick={openModal}>
              <Plus className="h-4 w-4" /> New user
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search users…" className="pl-8" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
        <div className="w-[220px]">
          <TagPicker value={tagIds} onChange={setTagIds} placeholder="Filter by tags…" />
        </div>
      </div>

      <ResponsiveModal open={open} onOpenChange={setOpen}>
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Create user</ResponsiveModalTitle>
            <ResponsiveModalDescription>Invite a team member and assign them a role.</ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="name">Full name</Label>
                <Input id="name" {...register("name")} />
                {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" {...register("email")} />
                {errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Temporary password</Label>
                <Input id="password" type="text" {...register("password")} />
                {errors.password && <p className="text-xs text-danger">{errors.password.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Role</Label>
                <Controller
                  control={control}
                  name="roleId"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a role…" />
                      </SelectTrigger>
                      <SelectContent>
                        {roles?.data.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.name}
                          </SelectItem>
                        ))}
                        {/* Offered only to somebody who already holds it — the
                            server refuses it from anybody else, so showing it
                            more widely would only produce a refusal. */}
                        {isSuperAdmin && (
                          <SelectItem value={SUPER_ADMIN_OPTION}>Super Admin</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.roleId && <p className="text-xs text-danger">{errors.roleId.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Department</Label>
                <Controller
                  control={control}
                  name="departmentId"
                  render={({ field }) => (
                    <Select value={field.value ?? ""} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a department…" />
                      </SelectTrigger>
                      <SelectContent>
                        {departments?.map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Tags</Label>
              <TagPicker value={watch("tagIds") ?? []} onChange={(v) => setValue("tagIds", v)} />
            </div>
            <ResponsiveModalFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" loading={isSubmitting}>Create user</Button>
            </ResponsiveModalFooter>
          </form>
        </ResponsiveModalContent>
      </ResponsiveModal>

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(u) => u.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        selectable
        isLoading={isLoading}
        emptyMessage="No users match your filters."
      />
      {editing && (
        <EditUserDialog user={editing} open onClose={() => setEditing(null)} />
      )}

      {/* Said in full: removing somebody is not the same as suspending them,
          and the difference is the part worth reading before clicking. */}
      <ConfirmDialog open={Boolean(removing)} onOpenChange={(o) => { if (!o) setRemoving(null); }}>
        <ConfirmContent className="max-w-md">
          <ConfirmHeader>
            <ConfirmTitle>Remove {removing?.name}?</ConfirmTitle>
            <ConfirmDescription>
              They lose their place in this organization entirely. If their name is on an invoice
              or an expense claim this will be refused — suspend them instead, which takes away
              their access and leaves the history intact.
            </ConfirmDescription>
          </ConfirmHeader>
          <ConfirmFooter>
            <Button variant="secondary" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => removing && confirmRemove(removing)}
            >
              Remove
            </Button>
          </ConfirmFooter>
        </ConfirmContent>
      </ConfirmDialog>

    </div>
  );
}
