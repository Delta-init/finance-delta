"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Search, Pencil, Trash2, Building } from "lucide-react";
import {
  createDepartmentSchema,
  type CreateDepartmentInput,
  type Department,
} from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  useCreateDepartment,
  useDeleteDepartment,
  useDepartments,
  useUpdateDepartment,
} from "./api";

export function DepartmentManager() {
  const t = useTableQuery({ initialSort: { key: "name", dir: "asc" } });
  const { data, isLoading } = useDepartments(t.baseParams);
  const createDepartment = useCreateDepartment();
  const updateDepartment = useUpdateDepartment();
  const deleteDepartment = useDeleteDepartment();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } =
    useForm<CreateDepartmentInput>({
      resolver: zodResolver(createDepartmentSchema),
      defaultValues: { name: "", description: "" },
    });

  function openCreate() {
    setEditing(null);
    reset({ name: "", description: "" });
    setOpen(true);
  }
  function openEdit(dept: Department) {
    setEditing(dept);
    reset({ name: dept.name, description: dept.description });
    setOpen(true);
  }

  async function onSubmit(values: CreateDepartmentInput) {
    try {
      if (editing) {
        await updateDepartment.mutateAsync({ id: editing.id, input: values });
        toast.success("Department updated");
      } else {
        await createDepartment.mutateAsync(values);
        toast.success("Department created");
      }
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save department");
    }
  }

  const columns: Column<Department>[] = [
    {
      key: "name",
      header: "Department",
      sortable: true,
      cell: (dept) => <span className="font-medium">{dept.name}</span>,
    },
    {
      key: "description",
      header: "Description",
      cell: (dept) => (
        <span className="text-foreground-muted">{dept.description || "—"}</span>
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      cell: (dept) => (
        <span className="text-sm text-foreground-muted">
          {new Date(dept.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (dept) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => openEdit(dept)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete"
            onClick={() =>
              deleteDepartment.mutate(dept.id, {
                onSuccess: () => toast.success("Department deleted"),
                onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to delete department"),
              })
            }
          >
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={Building}
        title="Departments"
        description="Organize salespersons and customers into departments."
        action={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> New department
          </Button>
        }
      />

      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
        <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search departments…" className="pl-8" />
      </div>

      <ResponsiveModal open={open} onOpenChange={setOpen}>
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>{editing ? "Edit department" : "Create department"}</ResponsiveModalTitle>
            <ResponsiveModalDescription>
              Departments can be assigned to salespersons and customers.
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="dept-name">Name</Label>
              <Input id="dept-name" {...register("name")} placeholder="e.g. Sales — North" />
              {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dept-description">Description</Label>
              <Input id="dept-description" {...register("description")} placeholder="Optional" />
            </div>
            <ResponsiveModalFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={isSubmitting}>
                {editing ? "Save changes" : "Create department"}
              </Button>
            </ResponsiveModalFooter>
          </form>
        </ResponsiveModalContent>
      </ResponsiveModal>

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(dept) => dept.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        isLoading={isLoading}
        emptyMessage="No departments yet. Create your first department."
      />
    </div>
  );
}
