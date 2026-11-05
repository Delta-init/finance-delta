"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Search, Pencil, Trash2, Building, RefreshCw, AlertTriangle } from "lucide-react";
import {
  createDepartmentSchema,
  type CreateDepartmentInput,
  type Department,
} from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useCan } from "@/lib/use-can";
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
  useSyncDepartmentsFromHrms,
  useUpdateDepartment,
  type DepartmentSyncResult,
} from "./api";

export function DepartmentManager() {
  const t = useTableQuery({ initialSort: { key: "name", dir: "asc" } });
  const { data, isLoading, isPlaceholderData } = useDepartments(t.baseParams);
  const createDepartment = useCreateDepartment();
  const updateDepartment = useUpdateDepartment();
  const deleteDepartment = useDeleteDepartment();
  const syncHrms = useSyncDepartmentsFromHrms();
  const { can } = useCan();
  const [synced, setSynced] = useState<DepartmentSyncResult | null>(null);

  async function syncNow() {
    try {
      const r = await syncHrms.mutateAsync();
      setSynced(r);
      const changed = r.created.length + r.linked.length + r.renamed.length + r.peopleMoved;
      if (changed) toast.success("Departments brought into line with HRMS");
      else if (!r.problems.length) toast.success("Already as HRMS has them");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't sync with HRMS");
    }
  }

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
      cell: (dept) => (
        <span className="font-medium">
          {dept.name}
          {/* Kept as HRMS has it — renamed with it, every hour (2026-11-05). */}
          {dept.hrmsNames?.length ? (
            <Badge tone="primary" className="ml-2" title={`Follows HRMS: ${dept.hrmsNames.join(", ")}`}>HRMS</Badge>
          ) : null}
        </span>
      ),
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
          <div className="flex flex-wrap gap-2">
            {can("department:update") && (
              <Button variant="secondary" loading={syncHrms.isPending} onClick={syncNow} title="Brings in HRMS's departments, renames ours as HRMS has them, and moves people with them — it also runs every hour">
                <RefreshCw className="h-4 w-4" /> Sync from HRMS
              </Button>
            )}
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" /> New department
            </Button>
          </div>
        }
      />

      {synced && <SyncResult r={synced} onClose={() => setSynced(null)} />}

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
        isLoading={isLoading} isFetching={isPlaceholderData}
        emptyMessage="No departments yet. Create your first department."
      />
    </div>
  );
}

/** What the sync did: each department made, linked or renamed, the people moved, and what it couldn't do. */
function SyncResult({ r, onClose }: { r: DepartmentSyncResult; onClose: () => void }) {
  const lines = [
    ...r.created.map((x) => `Made "${x.name}" (from ${x.from})`),
    ...r.linked.map((x) => `Linked "${x.name}" to HRMS (${x.from})`),
    ...r.renamed.map((x) => `Renamed "${x.from}" to "${x.to}"`),
    ...(r.peopleMoved ? [`${r.peopleMoved} ${r.peopleMoved === 1 ? "person" : "people"} moved to their HRMS department`] : []),
  ];
  return (
    <Card className="space-y-2 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">
          {lines.length ? "Brought into line with HRMS" : "Nothing to change — already as HRMS has them"}
          <span className="ml-2 font-normal text-foreground-muted">
            {r.organizations} HRMS organization{r.organizations === 1 ? "" : "s"} read
            {r.inactiveLeft ? ` · ${r.inactiveLeft} inactive in HRMS, not brought in` : ""}
          </span>
        </p>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>
      {lines.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5">
          {lines.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
      {r.problems.length > 0 && (
        <div className="space-y-1 rounded-md border border-warning/30 bg-warning/5 p-2.5">
          {r.problems.map((p) => (
            <p key={p} className="flex items-start gap-2 text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{p}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}
