"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil, Plus, Search, Trash2, Users2 } from "lucide-react";
import { createCustomerSchema, type CreateCustomerInput, type Customer } from "@delta/shared";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
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
import { useCreateCustomer, useCustomers, useDeleteCustomer, useUpdateCustomer } from "./api";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR", "QAR", "KWD", "BHD", "OMR"];

function emptyAddress() {
  return { street: "", city: "", state: "", zip: "", country: "" };
}

function toFormValues(c: Customer): CreateCustomerInput {
  return {
    name: c.name,
    email: c.email,
    phone: c.phone,
    companyName: c.companyName,
    currency: c.currency,
    vatNumber: c.vatNumber,
    discountPct: c.discountPct,
    billingAddress: c.billingAddress ?? emptyAddress(),
    shippingAddress: c.shippingAddress ?? emptyAddress(),
    tagIds: c.tags.map((t) => t.id),
  };
}

function defaultValues(): CreateCustomerInput {
  return {
    name: "",
    email: "",
    phone: "",
    companyName: "",
    currency: "AED",
    vatNumber: "",
    discountPct: 0,
    billingAddress: emptyAddress(),
    shippingAddress: emptyAddress(),
    tagIds: [],
  };
}

function AddressFields({
  prefix,
  register,
}: {
  prefix: "billingAddress" | "shippingAddress";
  register: ReturnType<typeof useForm<CreateCustomerInput>>["register"];
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Input {...register(`${prefix}.street`)} placeholder="Street" />
      </div>
      <Input {...register(`${prefix}.city`)} placeholder="City" />
      <Input {...register(`${prefix}.state`)} placeholder="State / Emirate" />
      <Input {...register(`${prefix}.zip`)} placeholder="ZIP / Postal code" />
      <Input {...register(`${prefix}.country`)} placeholder="Country" />
    </div>
  );
}

export function CustomerManager() {
  const router = useRouter();
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  const [status, setStatus] = useState<string>("all");
  const [tagIds, setTagIds] = useState<string[]>([]);
  useEffect(() => t.resetPage(), [status, tagIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useCustomers({
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    tagIds: tagIds.length ? tagIds : undefined,
  });

  const createMutation = useCreateCustomer();
  const updateMutation = useUpdateCustomer();
  const deleteMutation = useDeleteCustomer();

  // Modal state: null = closed, "create" = creating, Customer = editing
  const [modal, setModal] = useState<null | "create" | Customer>(null);
  const [deletingCustomer, setDeletingCustomer] = useState<Customer | null>(null);

  const isEditing = modal !== null && modal !== "create";
  const isOpen = modal !== null;

  const { register, handleSubmit, reset, setValue, watch, formState: { errors, isSubmitting } } =
    useForm<CreateCustomerInput>({
      resolver: zodResolver(createCustomerSchema),
      defaultValues: defaultValues(),
    });

  function openCreate() {
    reset(defaultValues());
    setModal("create");
  }

  function openEdit(customer: Customer) {
    reset(toFormValues(customer));
    setModal(customer);
  }

  async function onSubmit(values: CreateCustomerInput) {
    try {
      if (isEditing) {
        await updateMutation.mutateAsync({ id: (modal as Customer).id, input: values });
        toast.success("Customer updated");
      } else {
        await createMutation.mutateAsync(values);
        toast.success("Customer created");
      }
      setModal(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : isEditing ? "Failed to update" : "Failed to create");
    }
  }

  async function confirmDelete() {
    if (!deletingCustomer) return;
    try {
      await deleteMutation.mutateAsync(deletingCustomer.id);
      toast.success("Customer deleted");
      setDeletingCustomer(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to delete");
    }
  }

  const columns: Column<Customer>[] = [
    {
      key: "code",
      header: "ID",
      sortable: true,
      cell: (c) => <span className="font-mono text-xs text-foreground-muted">{c.customerCode}</span>,
    },
    {
      key: "name",
      header: "Name",
      sortable: true,
      cell: (c) => (
        <div>
          <p className="font-medium">{c.name}</p>
          {c.companyName && <p className="text-xs text-foreground-muted">{c.companyName}</p>}
        </div>
      ),
    },
    {
      key: "email",
      header: "Email",
      sortable: true,
      cell: (c) => <span className="text-foreground-muted">{c.email}</span>,
    },
    {
      key: "phone",
      header: "Phone",
      cell: (c) => <span className="text-foreground-muted">{c.phone}</span>,
    },
    { key: "tags", header: "Tags", cell: (c) => <TagList tags={c.tags} /> },
    {
      key: "status",
      header: "Status",
      sortable: true,
      cell: (c) => <Badge tone={c.status === "active" ? "success" : "neutral"}>{c.status}</Badge>,
    },
    {
      key: "actions",
      header: "",
      cell: (c) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => openEdit(c)}
            className="rounded p-1.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground"
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setDeletingCustomer(c)}
            className="rounded p-1.5 text-foreground-muted hover:bg-danger/10 hover:text-danger"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={Users2}
        title="Customers"
        description="People and companies you bill and send quotations to."
        action={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> New customer
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search customers…" className="pl-8" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
        <div className="w-[220px]">
          <TagPicker value={tagIds} onChange={setTagIds} placeholder="Filter by tags…" />
        </div>
      </div>

      {/* Create / Edit modal */}
      <ResponsiveModal open={isOpen} onOpenChange={(o) => !o && setModal(null)}>
        <ResponsiveModalContent className="max-h-[90vh] overflow-y-auto">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>{isEditing ? "Edit customer" : "Create customer"}</ResponsiveModalTitle>
            <ResponsiveModalDescription>
              {isEditing ? "Update customer details." : "Add a customer to bill and send quotations to."}
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-5 pb-2">
            {/* Core fields */}
            <div className="space-y-1.5">
              <Label htmlFor="name">Full Name *</Label>
              <Input id="name" {...register("name")} />
              {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email *</Label>
                <Input id="email" type="email" {...register("email")} />
                {errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="phone">Phone *</Label>
                <Input id="phone" {...register("phone")} />
                {errors.phone && <p className="text-xs text-danger">{errors.phone.message}</p>}
              </div>
            </div>

            {/* Optional */}
            <div className="space-y-1.5">
              <Label htmlFor="companyName">Company Name</Label>
              <Input id="companyName" {...register("companyName")} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="vatNumber">VAT / TRN Number</Label>
                <Input id="vatNumber" {...register("vatNumber")} placeholder="e.g. 100123456789003" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discountPct">Default Discount %</Label>
                <Input
                  id="discountPct"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  {...register("discountPct", { valueAsNumber: true })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Select value={watch("currency") ?? "AED"} onValueChange={(v) => setValue("currency", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Billing address */}
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">Billing Address</Label>
              <AddressFields prefix="billingAddress" register={register} />
            </div>

            {/* Shipping address */}
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">Shipping Address</Label>
              <AddressFields prefix="shippingAddress" register={register} />
            </div>

            {/* Tags */}
            <div className="space-y-1.5">
              <Label>Tags</Label>
              <TagPicker value={watch("tagIds") ?? []} onChange={(v) => setValue("tagIds", v)} />
            </div>

            {/* Status (edit only) */}
            {isEditing && (
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select
                  value={watch("status" as keyof CreateCustomerInput) as string ?? "active"}
                  onValueChange={(v) => setValue("status" as keyof CreateCustomerInput, v as never)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <ResponsiveModalFooter>
              <Button type="button" variant="ghost" onClick={() => setModal(null)}>Cancel</Button>
              <Button type="submit" loading={isSubmitting || createMutation.isPending || updateMutation.isPending}>
                {isEditing ? "Save changes" : "Create customer"}
              </Button>
            </ResponsiveModalFooter>
          </form>
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/* Delete confirm */}
      <Dialog open={!!deletingCustomer} onOpenChange={(o) => !o && setDeletingCustomer(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete customer?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-foreground-muted">
            Are you sure you want to delete <strong>{deletingCustomer?.name}</strong>? This cannot be undone.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              loading={deleteMutation.isPending}
              onClick={confirmDelete}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(c) => c.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        onRowClick={(c) => router.push(`/customers/${c.id}`)}
        selectable
        isLoading={isLoading}
        emptyMessage="No customers match your filters."
      />
    </div>
  );
}
