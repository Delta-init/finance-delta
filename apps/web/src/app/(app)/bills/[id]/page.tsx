"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, Building2, CheckCircle, XCircle, Ban, CreditCard, Paperclip, Upload, Download, Trash2, FileText, Save, Pencil } from "lucide-react";
import { formatMoney, recordBillPaymentSchema, type RecordBillPaymentInput, type Bill } from "@delta/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  useBill,
  useApproveBill,
  useRejectBill,
  useVoidBill,
  useRecordBillPayment,
  useUpdateBillPayment,
  useUpdateBillNotes,
  useAddBillAttachment,
  useRemoveBillAttachment,
} from "@/features/bills/api";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral", pending_approval: "warning", approved: "primary",
  partially_paid: "warning", paid: "success", overdue: "danger", voided: "neutral",
};

const PAYMENT_METHODS = ["bank_transfer", "cash", "cheque", "card", "online", "easebuzz_emi"] as const;
const METHOD_LABELS: Record<string, string> = {
  bank_transfer: "Bank Transfer",
  cash: "Cash",
  cheque: "Cheque",
  card: "Card",
  online: "Online",
  easebuzz_emi: "Easebuzz EMI",
};

const ACCEPTED_TYPE_SET = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function toMinorFromInput(val: string): number {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function BillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: bill, isLoading } = useBill(id);
  const approveBill = useApproveBill(id);
  const rejectBill = useRejectBill(id);
  const voidBill = useVoidBill(id);
  const recordPayment = useRecordBillPayment(id);
  const updatePayment = useUpdateBillPayment(id);
  const updateNotes = useUpdateBillNotes(id);
  const addAttachment = useAddBillAttachment(id);
  const removeAttachment = useRemoveBillAttachment(id);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [editingPayment, setEditingPayment] = useState<Bill["payments"][number] | null>(null);
  const isEdit = !!editingPayment;
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { register, handleSubmit, watch, setValue, reset, formState: { errors, isSubmitting } } =
    useForm<RecordBillPaymentInput & { amountDisplay: string }>({
      resolver: zodResolver(recordBillPaymentSchema.extend({ amountDisplay: recordBillPaymentSchema.shape.amountMinor.optional() })),
      defaultValues: { method: "bank_transfer", amountMinor: 0, paidOn: new Date().toISOString().slice(0, 10), reference: "", accountName: "", notes: "" },
    });

  const method = watch("method");

  useEffect(() => {
    if (paymentOpen && editingPayment) {
      reset({
        method: editingPayment.method,
        amountMinor: editingPayment.amountMinor,
        paidOn: editingPayment.paidOn,
        reference: editingPayment.reference ?? "",
        accountName: editingPayment.accountName ?? "",
        notes: editingPayment.notes ?? "",
        chargesMinor: editingPayment.chargesMinor ?? 0,
        emi: editingPayment.emi ? { ...editingPayment.emi } : undefined,
      });
    } else if (paymentOpen && !editingPayment) {
      reset({
        method: "bank_transfer",
        amountMinor: 0,
        paidOn: new Date().toISOString().slice(0, 10),
        reference: "",
        accountName: "",
        notes: "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentOpen, editingPayment]);

  function handleMethodChange(v: string) {
    setValue("method", v as RecordBillPaymentInput["method"]);
    if (v === "easebuzz_emi") {
      setValue("emi", { bank: "", tenureMonths: 3, monthlyAmountMinor: 0, interestPct: 0, processingFeeMinor: 0, transactionId: "" });
    } else {
      setValue("emi", undefined);
    }
  }

  async function handleAction(action: () => Promise<unknown>, msg: string) {
    try {
      await action();
      toast.success(msg);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Action failed");
    }
  }

  async function onPaymentSubmit(values: RecordBillPaymentInput) {
    const payload: RecordBillPaymentInput = { ...values };
    if (payload.method !== "easebuzz_emi") delete (payload as { emi?: unknown }).emi;
    try {
      if (editingPayment) {
        await updatePayment.mutateAsync({ paymentId: editingPayment.id, input: payload });
        toast.success("Payment updated");
      } else {
        await recordPayment.mutateAsync(payload);
        toast.success("Payment recorded");
      }
      setPaymentOpen(false);
      setEditingPayment(null);
      reset();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Failed to ${editingPayment ? "update" : "record"} payment`);
    }
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.type && !ACCEPTED_TYPE_SET.has(file.type)) {
      toast.error("Unsupported file type. Upload JPG, PNG, WebP, GIF, or PDF.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error("File exceeds the 10 MB limit.");
      return;
    }
    try {
      await addAttachment.mutateAsync({ file });
      toast.success("Attachment uploaded");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Upload failed");
    }
  }

  async function handleRemoveAttachment(attId: string) {
    try {
      await removeAttachment.mutateAsync(attId);
      toast.success("Attachment removed");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed");
    }
  }

  if (isLoading) return <div className="flex h-64 items-center justify-center text-foreground-muted">Loading…</div>;
  if (!bill) return <div className="flex h-64 items-center justify-center text-foreground-muted">Bill not found.</div>;

  const canPay = bill.status === "approved" || bill.status === "partially_paid" || bill.status === "overdue";
  const canApprove = bill.approvalStatus === "pending";
  const notesValue = notesDraft ?? bill.notes ?? "";
  const notesDirty = notesDraft !== null && notesDraft !== (bill.notes ?? "");

  async function handleSaveNotes() {
    try {
      await updateNotes.mutateAsync(notesValue);
      toast.success("Notes saved");
      setNotesDraft(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save notes");
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/bills" className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{bill.billNumber}</h1>
            <Badge tone={STATUS_TONE[bill.status] ?? "neutral"} className="capitalize">{bill.status.replace("_", " ")}</Badge>
            {canApprove && <Badge tone="warning">Pending approval</Badge>}
          </div>
          <p className="text-sm text-foreground-muted">{bill.vendorName}</p>
        </div>
        <div className="flex items-center gap-2">
          {bill.status !== "voided" && (
            <Link href={`/bills/${id}/edit`}>
              <Button variant="outline" size="sm">
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            </Link>
          )}
          {canApprove && (
            <>
              <Button variant="outline" size="sm" onClick={() => handleAction(() => rejectBill.mutateAsync(undefined), "Bill rejected")} loading={rejectBill.isPending}>
                <XCircle className="h-4 w-4" /> Reject
              </Button>
              <Button size="sm" onClick={() => handleAction(() => approveBill.mutateAsync(undefined), "Bill approved")} loading={approveBill.isPending}>
                <CheckCircle className="h-4 w-4" /> Approve
              </Button>
            </>
          )}
          {canPay && (
            <Button size="sm" onClick={() => { setEditingPayment(null); setPaymentOpen(true); }}>
              <CreditCard className="h-4 w-4" /> Record Payment
            </Button>
          )}
          {(bill.status === "draft" || bill.status === "approved") && (
            <Button variant="outline" size="sm" onClick={() => handleAction(() => voidBill.mutateAsync(undefined), "Bill voided")} loading={voidBill.isPending}>
              <Ban className="h-4 w-4" /> Void
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Bill Date</p>
          <p className="font-medium">{bill.billDate}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Due Date</p>
          <p className="font-medium">{bill.dueDate}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Amount Paid</p>
          <MoneyDisplay minor={bill.amountPaidMinor} currency={bill.currency} className="font-medium" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
          <p className="text-xs text-foreground-muted">Balance Due</p>
          <MoneyDisplay minor={bill.balanceMinor} currency={bill.currency} className={bill.balanceMinor > 0 ? "font-semibold text-danger" : "font-semibold"} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-lg border border-border bg-surface overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <h2 className="text-sm font-semibold">Line Items</h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-foreground-muted">
                  <th className="px-5 py-2.5 text-left font-medium">Description</th>
                  <th className="px-3 py-2.5 text-right font-medium">Qty</th>
                  <th className="px-3 py-2.5 text-right font-medium">Unit Price</th>
                  <th className="px-3 py-2.5 text-right font-medium">Disc</th>
                  <th className="px-3 py-2.5 text-right font-medium">Tax</th>
                  <th className="px-5 py-2.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {bill.lineItems.map((line, i) => (
                  <tr key={i}>
                    <td className="px-5 py-3">{line.description}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{line.quantity}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{formatMoney(line.unitPriceMinor, bill.currency)}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{line.discountPct > 0 ? `${line.discountPct}%` : "—"}</td>
                    <td className="px-3 py-3 text-right text-foreground-muted">{line.taxPct > 0 ? `${line.taxPct}%` : "—"}</td>
                    <td className="px-5 py-3 text-right font-medium"><MoneyDisplay minor={line.lineTotalMinor} currency={bill.currency} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-border px-5 py-4 space-y-1.5">
              <div className="flex justify-end gap-12 text-sm">
                <span className="text-foreground-muted">Subtotal</span>
                <MoneyDisplay minor={bill.subtotalMinor} currency={bill.currency} className="w-28 text-right" />
              </div>
              <div className="flex justify-end gap-12 text-sm">
                <span className="text-foreground-muted">Tax</span>
                <MoneyDisplay minor={bill.taxTotalMinor} currency={bill.currency} className="w-28 text-right" />
              </div>
              <div className="flex justify-end gap-12 text-sm font-semibold">
                <span>Total</span>
                <MoneyDisplay minor={bill.totalMinor} currency={bill.currency} className="w-28 text-right" />
              </div>
            </div>
          </div>

          {bill.payments.length > 0 && (
            <div className="rounded-lg border border-border bg-surface overflow-hidden">
              <div className="px-5 py-3 border-b border-border">
                <h2 className="text-sm font-semibold">Payments</h2>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-foreground-muted">
                    <th className="px-5 py-2.5 text-left font-medium">Date</th>
                    <th className="px-3 py-2.5 text-left font-medium">Method</th>
                    <th className="px-3 py-2.5 text-left font-medium">Account</th>
                    <th className="px-3 py-2.5 text-left font-medium">Reference</th>
                    <th className="px-5 py-2.5 text-right font-medium">Amount</th>
                    <th className="px-3 py-2.5 font-medium"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {bill.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="px-5 py-3 text-foreground-muted align-top">{p.paidOn}</td>
                      <td className="px-3 py-3 align-top">
                        {METHOD_LABELS[p.method] ?? p.method.replace("_", " ")}
                        {p.emi && (
                          <span className="mt-0.5 block text-xs text-foreground-muted">
                            {p.emi.tenureMonths} mo{p.emi.interestPct ? ` · ${p.emi.interestPct}%` : ""}{p.emi.bank ? ` · ${p.emi.bank}` : ""}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-foreground-muted align-top">{p.accountName || "—"}</td>
                      <td className="px-3 py-3 text-foreground-muted align-top">{p.reference || p.emi?.transactionId || "—"}</td>
                      <td className="px-5 py-3 text-right align-top">
                        <MoneyDisplay minor={p.amountMinor} currency={bill.currency} className="font-medium" />
                        {p.chargesMinor > 0 && (
                          <span className="mt-0.5 block text-xs text-foreground-muted">charges {formatMoney(p.chargesMinor, bill.currency)}</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right align-top">
                        {bill.status !== "voided" && (
                          <button
                            type="button"
                            onClick={() => { setEditingPayment(p); setPaymentOpen(true); }}
                            className="inline-flex items-center text-foreground-muted hover:text-foreground"
                            title="Edit payment"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Attachments */}
          <div className="rounded-lg border border-border bg-surface overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-foreground-muted" />
                <h2 className="text-sm font-semibold">Attachments</h2>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                className="hidden"
                onChange={onFilePicked}
              />
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} loading={addAttachment.isPending}>
                <Upload className="h-3.5 w-3.5" /> Upload
              </Button>
            </div>
            {bill.attachments.length === 0 ? (
              <p className="px-5 py-4 text-sm text-foreground-muted">
                No attachments yet. Upload a bill PDF, receipt, or supporting document (JPG, PNG, WebP, GIF or PDF, max 10&nbsp;MB).
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {bill.attachments.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                    <FileText className="h-4 w-4 shrink-0 text-foreground-muted" />
                    <a href={a.url} target="_blank" rel="noreferrer" className="flex-1 truncate text-sm text-primary hover:underline">{a.name}</a>
                    {a.size > 0 && <span className="text-xs text-foreground-muted">{formatBytes(a.size)}</span>}
                    <a href={a.url} target="_blank" rel="noreferrer" className="rounded p-1 text-foreground-muted hover:bg-surface-muted" title="Open / download">
                      <Download className="h-4 w-4" />
                    </a>
                    <button
                      type="button"
                      onClick={() => handleRemoveAttachment(a.id)}
                      className="rounded p-1 text-foreground-muted hover:bg-danger/10 hover:text-danger"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Notes (editable) */}
          <div className="rounded-lg border border-border bg-surface p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Notes</h2>
              {notesDirty && (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setNotesDraft(null)}>Cancel</Button>
                  <Button size="sm" onClick={handleSaveNotes} loading={updateNotes.isPending}>
                    <Save className="h-3.5 w-3.5" /> Save
                  </Button>
                </div>
              )}
            </div>
            <textarea
              value={notesValue}
              onChange={(e) => setNotesDraft(e.target.value)}
              rows={3}
              placeholder="Add notes about this bill…"
              disabled={bill.status === "voided"}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm shadow-xs focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
            />
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-surface p-5 space-y-3">
            <h2 className="text-sm font-semibold">Vendor</h2>
            <div className="flex items-start gap-2">
              <Building2 className="h-4 w-4 text-foreground-muted shrink-0 mt-0.5" />
              <p className="font-medium">{bill.vendorName}</p>
            </div>
            <Link href={`/vendors/${bill.vendorId}`} className="text-xs text-primary hover:underline">View vendor →</Link>
            {bill.sourcePONumber && (
              <div className="pt-1 border-t border-border">
                <p className="text-xs text-foreground-muted">From PO</p>
                <Link href={`/purchase-orders/${bill.sourcePOId}`} className="text-sm font-medium text-primary hover:underline">{bill.sourcePONumber}</Link>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-surface p-5 space-y-2">
            <h2 className="text-sm font-semibold">Summary</h2>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-foreground-muted">Total</span>
                <MoneyDisplay minor={bill.totalMinor} currency={bill.currency} className="font-medium" />
              </div>
              <div className="flex justify-between">
                <span className="text-foreground-muted">Paid</span>
                <MoneyDisplay minor={bill.amountPaidMinor} currency={bill.currency} className="font-medium text-success" />
              </div>
              <div className="flex justify-between border-t border-border pt-1.5">
                <span className="font-semibold">Balance</span>
                <MoneyDisplay minor={bill.balanceMinor} currency={bill.currency} className={bill.balanceMinor > 0 ? "font-semibold text-danger" : "font-semibold"} />
              </div>
            </div>
          </div>

          {bill.paymentTerms && (
            <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
              <p className="text-xs text-foreground-muted">Payment Terms</p>
              <p className="text-sm font-medium">{bill.paymentTerms}</p>
            </div>
          )}
        </div>
      </div>

      <Dialog open={paymentOpen} onOpenChange={(o) => { if (!o) { setPaymentOpen(false); setEditingPayment(null); reset(); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{isEdit ? "Edit Payment" : "Record Payment"}</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit(onPaymentSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Payment Method *</Label>
              <Select value={method} onValueChange={handleMethodChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>{METHOD_LABELS[m] ?? m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Amount ({bill.currency}) *</Label>
                <Input
                  key={editingPayment?.id ?? "new"}
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  defaultValue={editingPayment ? (editingPayment.amountMinor / 100).toString() : ""}
                  onChange={(e) => setValue("amountMinor", toMinorFromInput(e.target.value))}
                />
                {errors.amountMinor && <p className="text-xs text-danger">{errors.amountMinor.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Payment Date *</Label>
                <Input type="date" {...register("paidOn")} />
                {errors.paidOn && <p className="text-xs text-danger">{errors.paidOn.message}</p>}
              </div>
            </div>

            {method === "easebuzz_emi" && (
              <div className="rounded-md border border-border bg-surface-muted/40 p-3 space-y-3">
                <p className="text-xs font-semibold text-foreground-muted">Easebuzz EMI details</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Bank / Provider</Label>
                    <Input {...register("emi.bank")} placeholder="e.g. HDFC Bank" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Tenure (months) *</Label>
                    <Input
                      key={editingPayment?.id ?? "new"}
                      type="number"
                      min={1}
                      max={60}
                      defaultValue={editingPayment?.emi?.tenureMonths ?? 3}
                      onChange={(e) => setValue("emi.tenureMonths", parseInt(e.target.value || "0", 10))}
                    />
                    {errors.emi?.tenureMonths && <p className="text-xs text-danger">{errors.emi.tenureMonths.message}</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label>Monthly EMI ({bill.currency})</Label>
                    <Input key={editingPayment?.id ?? "new"} type="number" step="0.01" placeholder="0.00" defaultValue={editingPayment?.emi?.monthlyAmountMinor ? (editingPayment.emi.monthlyAmountMinor / 100).toString() : ""} onChange={(e) => setValue("emi.monthlyAmountMinor", toMinorFromInput(e.target.value))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Interest %</Label>
                    <Input key={editingPayment?.id ?? "new"} type="number" step="0.01" placeholder="0" defaultValue={editingPayment?.emi?.interestPct ? editingPayment.emi.interestPct.toString() : ""} onChange={(e) => setValue("emi.interestPct", parseFloat(e.target.value || "0"))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Processing Fee ({bill.currency})</Label>
                    <Input key={editingPayment?.id ?? "new"} type="number" step="0.01" placeholder="0.00" defaultValue={editingPayment?.emi?.processingFeeMinor ? (editingPayment.emi.processingFeeMinor / 100).toString() : ""} onChange={(e) => setValue("emi.processingFeeMinor", toMinorFromInput(e.target.value))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Easebuzz Txn ID</Label>
                    <Input {...register("emi.transactionId")} placeholder="Transaction / reference id" />
                  </div>
                </div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Account / Bank</Label>
                <Input {...register("accountName")} placeholder="Account name" />
              </div>
              <div className="space-y-1.5">
                <Label>Reference</Label>
                <Input {...register("reference")} placeholder="Ref / check #" />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Charges ({bill.currency})</Label>
                <Input key={editingPayment?.id ?? "new"} type="number" step="0.01" min="0" placeholder="0.00" defaultValue={editingPayment?.chargesMinor ? (editingPayment.chargesMinor / 100).toString() : ""} onChange={(e) => setValue("chargesMinor", toMinorFromInput(e.target.value))} />
              </div>
              <div className="space-y-1.5">
                <Label>Notes</Label>
                <Input {...register("notes")} placeholder="Optional notes" />
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild><Button type="button" variant="ghost" onClick={() => setEditingPayment(null)}>Cancel</Button></DialogClose>
              <Button type="submit" loading={isSubmitting}>{isEdit ? "Save changes" : "Record payment"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
