"use client";

import { useEffect, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Search, Users2 } from "lucide-react";
import { createUserSchema, type CreateUserInput, type User } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
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
import { useRoles } from "@/features/roles/api";
import { useCreateUser, useUsers } from "./api";

export function UserManager() {
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  const [status, setStatus] = useState("all");
  const [tagIds, setTagIds] = useState<string[]>([]);
  useEffect(() => t.resetPage(), [status, tagIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useUsers({
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    tagIds: tagIds.length ? tagIds : undefined,
  });
  const { data: roles } = useRoles({ pageSize: 100 });
  const createUser = useCreateUser();

  const [open, setOpen] = useState(false);

  const { register, handleSubmit, control, reset, watch, setValue, formState: { errors, isSubmitting } } =
    useForm<CreateUserInput>({
      resolver: zodResolver(createUserSchema),
      defaultValues: { name: "", email: "", password: "", roleId: "", tagIds: [] },
    });

  const columns: Column<User>[] = [
    { key: "name", header: "Name", sortable: true, cell: (u) => <span className="font-medium">{u.name || "—"}</span> },
    { key: "email", header: "Email", sortable: true, cell: (u) => <span className="text-foreground-muted">{u.email}</span> },
    { key: "role", header: "Role", cell: (u) => u.role.name },
    { key: "tags", header: "Tags", cell: (u) => <TagList tags={u.tags} /> },
    {
      key: "status",
      header: "Status",
      sortable: true,
      cell: (u) => <Badge tone={u.status === "active" ? "success" : "warning"}>{u.status}</Badge>,
    },
  ];

  function openModal() {
    reset({ name: "", email: "", password: "", roleId: "", tagIds: [] });
    setOpen(true);
  }

  async function onSubmit(values: CreateUserInput) {
    try {
      await createUser.mutateAsync(values);
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
          <Button onClick={openModal}>
            <Plus className="h-4 w-4" /> New user
          </Button>
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
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.roleId && <p className="text-xs text-danger">{errors.roleId.message}</p>}
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
    </div>
  );
}
