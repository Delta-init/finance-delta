"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil, Plus, Search, Trash2, Truck } from "lucide-react";
import { createVendorSchema, type CreateVendorInput, type Vendor } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { ResponsiveModal, ResponsiveModalContent, ResponsiveModalDescription, ResponsiveModalFooter, ResponsiveModalHeader, ResponsiveModalTitle } from "@/components/ui/responsive-modal";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useTableQuery } from "@/lib/use-table-query";
import { TagList } from "@/features/tags/TagBadge";
import { TagPicker } from "@/features/tags/TagPicker";
import { useVendors, useCreateVendor, useUpdateVendor, useDeleteVendor } from "@/features/vendors/api";
import { useCurrency } from "@/lib/currency-context";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR", "QAR", "KWD", "BHD", "OMR"];

function defaultValues(currency: string): CreateVendorInput {
  return { name: "", email: "", phone: "", companyName: "", currency, vatNumber: "", billingAddress: { street: "", city: "", state: "", zip: "", country: "" }, tagIds: [] };
}

function toFormValues(v: Vendor): CreateVendorInput {
  return { name: v.name, email: v.email, phone: v.phone, companyName: v.companyName, currency: v.currency, vatNumber: v.vatNumber, billingAddress: v.billingAddress ?? {}, tagIds: v.tags.map((t) => t.id) };
}

export default function VendorsPage() {
  const router = useRouter();
  const { currency: orgCurrency } = useCurrency();
  const t = useTableQuery({ initialSort: { key: "createdAt", dir: "desc" } });
  const [status, setStatus] = useState("all");
  useEffect(() => t.resetPage(), [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useVendors({ ...t.baseParams, status: status === "all" ? undefined : status });
  const createMutation = useCreateVendor();
  const updateMutation = useUpdateVendor();
  const deleteMutation = useDeleteVendor();

  const [modal, setModal] = useState<null | "create" | Vendor>(null);
  const [deletingVendor, setDeletingVendor] = useState<Vendor | null>(null);
  const isEditing = modal !== null && modal !== "create";

  const { register, handleSubmit, reset, setValue, watch, formState: { errors, isSubmitting } } =
    useForm<CreateVendorInput>({ resolver: zodResolver(createVendorSchema), defaultValues: defaultValues(orgCurrency) });

  async function onSubmit(values: CreateVendorInput) {
    try {
      if (isEditing) {
        await updateMutation.mutateAsync({ id: (modal as Vendor).id, input: values });
        toast.success("Vendor updated");
      } else {
        await createMutation.mutateAsync(values);
        toast.success("Vendor created");
      }
      setModal(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed");
    }
  }

  const columns: Column<Vendor>[] = [
    { key: "code", header: "ID", sortable: true, cell: (v) => <span className="font-mono text-xs text-foreground-muted">{v.vendorCode}</span> },
    { key: "name", header: "Name", sortable: true, cell: (v) => <div><p className="font-medium">{v.name}</p>{v.companyName && <p className="text-xs text-foreground-muted">{v.companyName}</p>}</div> },
    { key: "email", header: "Email", sortable: true, cell: (v) => <span className="text-foreground-muted">{v.email}</span> },
    { key: "phone", header: "Phone", cell: (v) => <span className="text-foreground-muted">{v.phone}</span> },
    { key: "tags", header: "Tags", cell: (v) => <TagList tags={v.tags} /> },
    { key: "status", header: "Status", sortable: true, cell: (v) => <Badge tone={v.status === "active" ? "success" : "neutral"}>{v.status}</Badge> },
    {
      key: "actions", header: "",
      cell: (v) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { reset(toFormValues(v)); setModal(v); }} className="rounded p-1.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
          <button onClick={() => setDeletingVendor(v)} className="rounded p-1.5 text-foreground-muted hover:bg-danger/10 hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader icon={Truck} title="Vendors" description="Manage your supplier relationships and purchase history."
        action={<Button onClick={() => { reset(defaultValues(orgCurrency)); setModal("create"); }}><Plus className="h-4 w-4" /> New vendor</Button>}
      />
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search vendors…" className="pl-8" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ResponsiveModal open={modal !== null} onOpenChange={(o) => !o && setModal(null)}>
        <ResponsiveModalContent className="max-h-[90vh] overflow-y-auto">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>{isEditing ? "Edit vendor" : "New vendor"}</ResponsiveModalTitle>
            <ResponsiveModalDescription>{isEditing ? "Update vendor details." : "Add a supplier to your organization."}</ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pb-2">
            <div className="space-y-1.5"><Label>Full Name *</Label><Input {...register("name")} />{errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}</div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>Email *</Label><Input type="email" {...register("email")} />{errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}</div>
              <div className="space-y-1.5"><Label>Phone *</Label><Input {...register("phone")} />{errors.phone && <p className="text-xs text-danger">{errors.phone.message}</p>}</div>
            </div>
            <div className="space-y-1.5"><Label>Company Name</Label><Input {...register("companyName")} /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>VAT / TRN Number</Label><Input {...register("vatNumber")} /></div>
              <div className="space-y-1.5">
                <Label>Currency</Label>
                <Select value={watch("currency") ?? orgCurrency} onValueChange={(v) => setValue("currency", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">Billing Address</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="sm:col-span-2"><Input {...register("billingAddress.street")} placeholder="Street" /></div>
                <Input {...register("billingAddress.city")} placeholder="City" />
                <Input {...register("billingAddress.state")} placeholder="State" />
                <Input {...register("billingAddress.zip")} placeholder="ZIP" />
                <Input {...register("billingAddress.country")} placeholder="Country" />
              </div>
            </div>
            <div className="space-y-1.5"><Label>Tags</Label><TagPicker value={watch("tagIds") ?? []} onChange={(v) => setValue("tagIds", v)} /></div>
            {isEditing && (
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={(watch("status" as keyof CreateVendorInput) as string) ?? "active"} onValueChange={(v) => setValue("status" as keyof CreateVendorInput, v as never)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="archived">Archived</SelectItem></SelectContent>
                </Select>
              </div>
            )}
            <ResponsiveModalFooter>
              <Button type="button" variant="ghost" onClick={() => setModal(null)}>Cancel</Button>
              <Button type="submit" loading={isSubmitting}>{isEditing ? "Save changes" : "Create vendor"}</Button>
            </ResponsiveModalFooter>
          </form>
        </ResponsiveModalContent>
      </ResponsiveModal>

      <Dialog open={!!deletingVendor} onOpenChange={(o) => !o && setDeletingVendor(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete vendor?</DialogTitle></DialogHeader>
          <p className="text-sm text-foreground-muted">Delete <strong>{deletingVendor?.name}</strong>? This cannot be undone.</p>
          <DialogFooter>
            <DialogClose asChild><Button variant="ghost" size="sm">Cancel</Button></DialogClose>
            <Button variant="destructive" size="sm" loading={deleteMutation.isPending} onClick={async () => { try { await deleteMutation.mutateAsync(deletingVendor!.id); toast.success("Deleted"); setDeletingVendor(null); } catch { toast.error("Failed to delete"); } }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DataTable columns={columns} data={data?.data} getRowId={(v) => v.id} total={data?.meta.total ?? 0}
        page={t.page} pageSize={t.pageSize} sort={t.sort} onPageChange={t.setPage} onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort} onRowClick={(v) => router.push(`/vendors/${v.id}`)} selectable isLoading={isLoading}
        emptyMessage="No vendors found." />
    </div>
  );
}
