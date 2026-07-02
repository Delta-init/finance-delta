"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, Mail, Phone, Building2, Landmark, BadgePercent, Pencil } from "lucide-react";
import { createVendorSchema, type CreateVendorInput, type Vendor } from "@delta/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ResponsiveModal, ResponsiveModalContent, ResponsiveModalDescription,
  ResponsiveModalFooter, ResponsiveModalHeader, ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { MoneyDisplay } from "@/components/ui/money";
import { TagList } from "@/features/tags/TagBadge";
import { TagPicker } from "@/features/tags/TagPicker";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useVendor, useUpdateVendor } from "@/features/vendors/api";
import { usePurchaseOrders } from "@/features/purchase-orders/api";
import { useBills } from "@/features/bills/api";
import { useCurrency } from "@/lib/currency-context";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR", "QAR", "KWD", "BHD", "OMR"];

const PO_STATUS_TONE: Record<string, "neutral" | "primary" | "warning" | "success" | "danger"> = {
  draft: "neutral", sent: "primary", received: "warning", billed: "success", cancelled: "danger",
};

const BILL_STATUS_TONE: Record<string, "neutral" | "primary" | "warning" | "success" | "danger"> = {
  draft: "neutral", pending_approval: "warning", approved: "primary",
  partially_paid: "warning", paid: "success", overdue: "danger", voided: "neutral",
};

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs text-foreground-muted">{label}</p>
      <p className="mt-0.5 text-sm font-medium">{value}</p>
    </div>
  );
}

function toFormValues(v: Vendor): CreateVendorInput {
  return {
    name: v.name, email: v.email, phone: v.phone, companyName: v.companyName,
    currency: v.currency, vatNumber: v.vatNumber, billingAddress: v.billingAddress ?? {},
    tagIds: v.tags.map((t) => t.id),
  };
}

export default function VendorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { currency: orgCurrency } = useCurrency();
  const { data: vendor, isLoading } = useVendor(id);
  const updateVendor = useUpdateVendor();
  const { data: poData } = usePurchaseOrders({ vendorId: id, limit: "50", sort: "createdAt", dir: "desc" });
  const { data: billData } = useBills({ vendorId: id, limit: "50", sort: "createdAt", dir: "desc" });

  const [editOpen, setEditOpen] = useState(false);
  const { register, handleSubmit, watch, setValue, reset, formState: { errors, isSubmitting } } =
    useForm<CreateVendorInput>({ resolver: zodResolver(createVendorSchema) });

  function openEdit() {
    if (vendor) { reset(toFormValues(vendor)); setEditOpen(true); }
  }

  async function onSubmit(values: CreateVendorInput) {
    try {
      await updateVendor.mutateAsync({ id, input: values });
      toast.success("Vendor updated");
      setEditOpen(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed");
    }
  }

  if (isLoading) return <div className="flex h-64 items-center justify-center text-foreground-muted">Loading…</div>;
  if (!vendor) return <div className="flex h-64 items-center justify-center text-foreground-muted">Vendor not found.</div>;

  const initials = vendor.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const pos = poData?.data ?? [];
  const bills = billData?.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/vendors" className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          {initials}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{vendor.name}</h1>
            <Badge tone={vendor.status === "active" ? "success" : "neutral"}>{vendor.status}</Badge>
          </div>
          {vendor.companyName && <p className="text-sm text-foreground-muted">{vendor.companyName}</p>}
          <p className="text-xs text-foreground-muted font-mono">{vendor.vendorCode}</p>
        </div>
        <Button variant="outline" size="sm" onClick={openEdit}><Pencil className="h-4 w-4" /> Edit</Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-surface p-5 space-y-3">
            <h2 className="text-sm font-semibold">Contact</h2>
            {vendor.email && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-foreground-muted shrink-0" />
                <span>{vendor.email}</span>
              </div>
            )}
            {vendor.phone && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="h-4 w-4 text-foreground-muted shrink-0" />
                <span>{vendor.phone}</span>
              </div>
            )}
            {vendor.companyName && (
              <div className="flex items-center gap-2 text-sm">
                <Building2 className="h-4 w-4 text-foreground-muted shrink-0" />
                <span>{vendor.companyName}</span>
              </div>
            )}
            {vendor.vatNumber && (
              <div className="flex items-center gap-2 text-sm">
                <Landmark className="h-4 w-4 text-foreground-muted shrink-0" />
                <span>VAT: {vendor.vatNumber}</span>
              </div>
            )}
            <div className="space-y-0.5">
              <p className="text-xs text-foreground-muted">Currency</p>
              <p className="text-sm font-medium">{vendor.currency}</p>
            </div>
            {vendor.tags.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-foreground-muted">Tags</p>
                <TagList tags={vendor.tags} />
              </div>
            )}
          </div>

          {vendor.billingAddress && (Object.values(vendor.billingAddress).some(Boolean)) && (
            <div className="rounded-lg border border-border bg-surface p-5 space-y-2">
              <h2 className="text-sm font-semibold">Billing Address</h2>
              <div className="text-sm text-foreground-muted space-y-0.5">
                {vendor.billingAddress.street && <p>{vendor.billingAddress.street}</p>}
                {(vendor.billingAddress.city || vendor.billingAddress.state) && (
                  <p>{[vendor.billingAddress.city, vendor.billingAddress.state].filter(Boolean).join(", ")}</p>
                )}
                {vendor.billingAddress.zip && <p>{vendor.billingAddress.zip}</p>}
                {vendor.billingAddress.country && <p>{vendor.billingAddress.country}</p>}
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-2 space-y-4">
          {pos.length > 0 && (
            <div className="rounded-lg border border-border bg-surface overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-border">
                <h2 className="text-sm font-semibold">Purchase Orders</h2>
                <Link href={`/purchase-orders/new`} className="text-xs text-primary hover:underline">+ New PO</Link>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-foreground-muted">
                    <th className="px-5 py-2.5 text-left font-medium">PO #</th>
                    <th className="px-3 py-2.5 text-left font-medium">Date</th>
                    <th className="px-3 py-2.5 text-left font-medium">Status</th>
                    <th className="px-5 py-2.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pos.map((po) => (
                    <tr key={po.id} className="cursor-pointer hover:bg-surface-muted" onClick={() => router.push(`/purchase-orders/${po.id}`)}>
                      <td className="px-5 py-2.5 font-medium text-primary">{po.poNumber}</td>
                      <td className="px-3 py-2.5 text-foreground-muted">{po.issueDate}</td>
                      <td className="px-3 py-2.5"><Badge tone={PO_STATUS_TONE[po.status] ?? "neutral"} className="capitalize">{po.status}</Badge></td>
                      <td className="px-5 py-2.5 text-right"><MoneyDisplay minor={po.totalMinor} currency={po.currency} className="font-medium" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {bills.length > 0 && (
            <div className="rounded-lg border border-border bg-surface overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-border">
                <h2 className="text-sm font-semibold">Bills</h2>
                <Link href={`/bills/new`} className="text-xs text-primary hover:underline">+ New Bill</Link>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-foreground-muted">
                    <th className="px-5 py-2.5 text-left font-medium">Bill #</th>
                    <th className="px-3 py-2.5 text-left font-medium">Due</th>
                    <th className="px-3 py-2.5 text-left font-medium">Status</th>
                    <th className="px-5 py-2.5 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {bills.map((bill) => (
                    <tr key={bill.id} className="cursor-pointer hover:bg-surface-muted" onClick={() => router.push(`/bills/${bill.id}`)}>
                      <td className="px-5 py-2.5 font-medium text-primary">{bill.billNumber}</td>
                      <td className="px-3 py-2.5 text-foreground-muted">{bill.dueDate}</td>
                      <td className="px-3 py-2.5"><Badge tone={BILL_STATUS_TONE[bill.status] ?? "neutral"} className="capitalize">{bill.status.replace("_", " ")}</Badge></td>
                      <td className="px-5 py-2.5 text-right"><MoneyDisplay minor={bill.balanceMinor} currency={bill.currency} className={bill.balanceMinor > 0 ? "font-medium text-danger" : "font-medium"} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pos.length === 0 && bills.length === 0 && (
            <div className="rounded-lg border border-border bg-surface p-8 text-center text-foreground-muted text-sm">
              No purchase orders or bills yet.{" "}
              <Link href="/purchase-orders/new" className="text-primary hover:underline">Create a PO</Link> or{" "}
              <Link href="/bills/new" className="text-primary hover:underline">record a bill</Link>.
            </div>
          )}
        </div>
      </div>

      <ResponsiveModal open={editOpen} onOpenChange={(o) => !o && setEditOpen(false)}>
        <ResponsiveModalContent className="max-h-[90vh] overflow-y-auto">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Edit vendor</ResponsiveModalTitle>
            <ResponsiveModalDescription>Update vendor details.</ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pb-2">
            <div className="space-y-1.5"><Label>Full Name *</Label><Input {...register("name")} />{errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}</div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>Email *</Label><Input type="email" {...register("email")} />{errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}</div>
              <div className="space-y-1.5"><Label>Phone *</Label><Input {...register("phone")} />{errors.phone && <p className="text-xs text-danger">{errors.phone.message}</p>}</div>
            </div>
            <div className="space-y-1.5"><Label>Company Name</Label><Input {...register("companyName")} /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>VAT / TRN</Label><Input {...register("vatNumber")} /></div>
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
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={(watch("status" as keyof CreateVendorInput) as string) ?? "active"} onValueChange={(v) => setValue("status" as keyof CreateVendorInput, v as never)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="archived">Archived</SelectItem></SelectContent>
              </Select>
            </div>
            <ResponsiveModalFooter>
              <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button type="submit" loading={isSubmitting}>Save changes</Button>
            </ResponsiveModalFooter>
          </form>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
