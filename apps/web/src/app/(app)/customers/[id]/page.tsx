"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, Pencil, Building2, Mail, Phone, Tag, BadgePercent, Landmark } from "lucide-react";
import { createCustomerSchema, formatMoney, type CreateCustomerInput, type Customer } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { TagList } from "@/features/tags/TagBadge";
import { TagPicker } from "@/features/tags/TagPicker";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCustomer, useCustomerStatement, useUpdateCustomer } from "@/features/customers/api";
import { useCurrency } from "@/lib/currency-context";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR", "QAR", "KWD", "BHD", "OMR"];

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "primary"> = {
  draft: "neutral",
  sent: "primary",
  viewed: "primary",
  partial: "warning",
  paid: "success",
  overdue: "danger",
  void: "neutral",
  voided: "neutral",
};

function InfoRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs text-foreground-muted">{label}</p>
      <p className="mt-0.5 text-sm font-medium">{value}</p>
    </div>
  );
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

function formatAddress(addr?: { street?: string; city?: string; state?: string; zip?: string; country?: string }) {
  if (!addr) return "";
  return [addr.street, addr.city, addr.state, addr.zip, addr.country].filter(Boolean).join(", ");
}

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { currency: orgCurrency } = useCurrency();
  const { data: customer, isLoading } = useCustomer(id);
  const { data: statement, isLoading: statLoading } = useCustomerStatement(id);
  const updateMutation = useUpdateCustomer();
  const [editOpen, setEditOpen] = useState(false);

  const { register, handleSubmit, reset, setValue, watch, formState: { errors, isSubmitting } } =
    useForm<CreateCustomerInput>({
      resolver: zodResolver(createCustomerSchema),
    });

  function openEdit(c: Customer) {
    reset({
      name: c.name,
      email: c.email,
      phone: c.phone,
      companyName: c.companyName,
      currency: c.currency,
      vatNumber: c.vatNumber,
      discountPct: c.discountPct,
      billingAddress: c.billingAddress ?? {},
      shippingAddress: c.shippingAddress ?? {},
      tagIds: c.tags.map((t) => t.id),
    });
    setEditOpen(true);
  }

  async function onSubmit(values: CreateCustomerInput) {
    try {
      await updateMutation.mutateAsync({ id, input: values });
      toast.success("Customer updated");
      setEditOpen(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to update");
    }
  }

  if (isLoading) {
    return <div className="flex h-48 items-center justify-center text-sm text-foreground-muted p-6">Loading…</div>;
  }
  if (!customer) {
    return <div className="flex h-48 items-center justify-center text-sm text-foreground-muted p-6">Customer not found.</div>;
  }

  const billing = formatAddress(customer.billingAddress);
  const shipping = formatAddress(customer.shippingAddress);
  const s = statement?.summary;

  return (
    <div className="space-y-6 p-6 max-w-5xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <Link href="/customers" className="flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Customers
        </Link>
        <span>/</span>
        <span className="font-medium text-foreground">{customer.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary">
            {customer.name.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <h1 className="text-xl font-semibold">{customer.name}</h1>
            <p className="text-sm text-foreground-muted">
              {customer.customerCode}
              {customer.companyName && ` · ${customer.companyName}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={customer.status === "active" ? "success" : "neutral"}>{customer.status}</Badge>
          <Button size="sm" variant="secondary" onClick={() => openEdit(customer)}>
            <Pencil className="h-4 w-4" /> Edit
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      {s && (
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { label: "Total Invoiced", value: formatMoney(s.totalInvoicedMinor, s.currency) },
            { label: "Total Paid", value: formatMoney(s.totalPaidMinor, s.currency), className: "text-success" },
            { label: "Outstanding", value: formatMoney(s.outstandingMinor, s.currency), className: s.outstandingMinor > 0 ? "text-danger" : "text-foreground" },
          ].map((card) => (
            <div key={card.label} className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-foreground-muted">{card.label}</p>
              <p className={`mt-1 text-xl font-semibold font-numeric ${card.className ?? ""}`}>{card.value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Info panel */}
        <div className="space-y-4 lg:col-span-1">
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h2 className="text-sm font-semibold">Contact</h2>
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 shrink-0 text-foreground-muted" />
                <a href={`mailto:${customer.email}`} className="text-primary hover:underline truncate">{customer.email}</a>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Phone className="h-4 w-4 shrink-0 text-foreground-muted" />
                <span>{customer.phone}</span>
              </div>
              {customer.companyName && (
                <div className="flex items-center gap-2 text-sm">
                  <Building2 className="h-4 w-4 shrink-0 text-foreground-muted" />
                  <span>{customer.companyName}</span>
                </div>
              )}
              {customer.vatNumber && (
                <div className="flex items-center gap-2 text-sm">
                  <Landmark className="h-4 w-4 shrink-0 text-foreground-muted" />
                  <span className="text-foreground-muted">VAT: {customer.vatNumber}</span>
                </div>
              )}
              {customer.discountPct > 0 && (
                <div className="flex items-center gap-2 text-sm">
                  <BadgePercent className="h-4 w-4 shrink-0 text-foreground-muted" />
                  <span className="text-foreground-muted">{customer.discountPct}% default discount</span>
                </div>
              )}
              <div className="flex items-center gap-2 text-sm">
                <span className="text-xs font-mono rounded bg-surface-muted px-1.5 py-0.5 border border-border">{customer.currency}</span>
                <span className="text-foreground-muted text-xs">currency</span>
              </div>
            </div>
          </div>

          {customer.tags.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-5 space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Tag className="h-4 w-4" /> Tags
              </div>
              <TagList tags={customer.tags} />
            </div>
          )}

          {(billing || shipping) && (
            <div className="rounded-xl border border-border bg-card p-5 space-y-4">
              <h2 className="text-sm font-semibold">Addresses</h2>
              {billing && <InfoRow label="Billing" value={billing} />}
              {shipping && <InfoRow label="Shipping" value={shipping} />}
            </div>
          )}
        </div>

        {/* Statement */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-border bg-surface shadow-sm overflow-hidden">
            <div className="bg-primary px-5 py-3.5">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-primary-foreground">Invoice Statement</h2>
            </div>
            {statLoading ? (
              <p className="px-5 py-8 text-center text-sm text-foreground-muted">Loading…</p>
            ) : !statement?.rows.length ? (
              <p className="px-5 py-8 text-center text-sm text-foreground-subtle">No invoices yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-muted">
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-foreground-muted">Invoice</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-foreground-muted">Date</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-foreground-muted">Due</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-foreground-muted">Status</th>
                      <th className="px-4 py-2.5 text-right text-xs font-semibold text-foreground-muted">Total</th>
                      <th className="px-4 py-2.5 text-right text-xs font-semibold text-foreground-muted">Paid</th>
                      <th className="px-4 py-2.5 text-right text-xs font-semibold text-foreground-muted">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.rows.map((row) => (
                      <tr key={row.id} className="border-t border-border hover:bg-surface-muted transition-colors">
                        <td className="px-4 py-2.5">
                          <Link href={`/invoices/${row.id}`} className="font-medium text-primary hover:underline">
                            {row.number}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-foreground-muted">{row.date}</td>
                        <td className="px-4 py-2.5 text-foreground-muted">{row.dueDate}</td>
                        <td className="px-4 py-2.5">
                          <Badge tone={STATUS_TONE[row.status] ?? "neutral"} className="capitalize">{row.status}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-right font-numeric">{formatMoney(row.totalMinor, row.currency)}</td>
                        <td className="px-4 py-2.5 text-right font-numeric text-success">{formatMoney(row.amountPaidMinor, row.currency)}</td>
                        <td className="px-4 py-2.5 text-right font-numeric font-medium" style={{ color: row.balanceMinor > 0 ? "var(--color-danger)" : "inherit" }}>
                          {formatMoney(row.balanceMinor, row.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Edit modal */}
      <ResponsiveModal open={editOpen} onOpenChange={(o) => !o && setEditOpen(false)}>
        <ResponsiveModalContent className="max-h-[90vh] overflow-y-auto">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Edit customer</ResponsiveModalTitle>
            <ResponsiveModalDescription>Update customer details.</ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-5 pb-2">
            <div className="space-y-1.5">
              <Label>Full Name *</Label>
              <Input {...register("name")} />
              {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Email *</Label>
                <Input type="email" {...register("email")} />
                {errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Phone *</Label>
                <Input {...register("phone")} />
                {errors.phone && <p className="text-xs text-danger">{errors.phone.message}</p>}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Company Name</Label>
              <Input {...register("companyName")} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>VAT / TRN Number</Label>
                <Input {...register("vatNumber")} />
              </div>
              <div className="space-y-1.5">
                <Label>Default Discount %</Label>
                <Input type="number" min={0} max={100} step="0.01" {...register("discountPct", { valueAsNumber: true })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Select value={watch("currency") ?? orgCurrency} onValueChange={(v) => setValue("currency", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select
                value={(watch("status" as keyof CreateCustomerInput) as string) ?? "active"}
                onValueChange={(v) => setValue("status" as keyof CreateCustomerInput, v as never)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">Billing Address</Label>
              <AddressFields prefix="billingAddress" register={register} />
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">Shipping Address</Label>
              <AddressFields prefix="shippingAddress" register={register} />
            </div>
            <div className="space-y-1.5">
              <Label>Tags</Label>
              <TagPicker value={watch("tagIds") ?? []} onChange={(v) => setValue("tagIds", v)} />
            </div>
            <ResponsiveModalFooter>
              <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button type="submit" loading={isSubmitting || updateMutation.isPending}>Save changes</Button>
            </ResponsiveModalFooter>
          </form>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
