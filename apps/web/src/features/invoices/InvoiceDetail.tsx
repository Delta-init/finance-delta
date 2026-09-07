"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Pencil, Send, Ban, ReceiptText, RefreshCw,
  CreditCard, Download, Plus, RotateCcw, FileX, ExternalLink, Paperclip, X,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  formatMoney, PAYMENT_METHODS, emiDetailInputSchema,
  type Invoice, type RecordPaymentInput, type Payment, approvalBlocksSending, approvalBlocksEditing, paymentMethodLabel,} from "@delta/shared";

const paymentFormSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount: z.coerce.number().positive("Amount must be greater than zero"),
  paidOn: z.string().min(1, "Payment date is required"),
  reference: z.string().max(200).default(""),
  notes: z.string().max(1000).default(""),
  accountName: z.string().max(100).default(""),
  charges: z.coerce.number().min(0).default(0),
  emi: emiDetailInputSchema.optional(),
});
type PaymentFormValues = z.infer<typeof paymentFormSchema>;
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { TagList } from "@/features/tags/TagBadge";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useInvoice, useSendInvoice, useVoidInvoice, useRecordPayment, useUpdatePayment, useResendInvoice } from "./api";
import { INVOICE_STATUS_TONE } from "./status";
import { useCan } from "@/lib/use-can";
import { ApprovalPanel } from "@/features/invoices/ApprovalPanel";
import { downloadInvoicePdf } from "@/features/invoices/invoice-pdf";
import { useOrganization } from "@/features/organization/api";
import { useCustomer } from "@/features/customers/api";
import { useBankAccount } from "@/features/banking/api";
import { InvoiceAttachments } from "@/features/invoices/InvoiceAttachments";

export function InvoiceDetail({ id }: { id: string }) {
  const router = useRouter();
  const { data: invoice, isLoading } = useInvoice(id);
  // Everything the PDF prints beyond the invoice itself. Cheap here: all three
  // are already cached by the time somebody reaches for the download.
  const { data: org } = useOrganization();
  const { data: customer } = useCustomer(invoice?.customerId);
  const { data: bankAccount } = useBankAccount(org?.invoiceDefaults?.bankAccountId || undefined);
  const { can } = useCan();
  const send = useSendInvoice();
  const voidInv = useVoidInvoice();
  const resend = useResendInvoice();
  const [payOpen, setPayOpen] = useState(false);
  const [editingPayment, setEditingPayment] = useState<Payment | null>(null);
  const [resendOpen, setResendOpen] = useState(false);
  const [resendMsg, setResendMsg] = useState("");

  if (isLoading) return <div className="p-6 text-foreground-muted text-sm">Loading…</div>;
  if (!invoice) return <div className="p-6 text-foreground-muted text-sm">Invoice not found.</div>;

  const isDraft = invoice.status === "draft";

  // Raising and sending your own invoices is `invoice:write:own`. Voiding one,
  // recording money against it and raising a credit note are all the broad
  // `invoice:write`, and the server refuses them without it — so somebody
  // billing their own work was being shown three buttons that only ever
  // returned an error.
  const canManage = can("invoice:write");

  // An unapproved invoice gates everything it can do. The server refuses these
  // before approval, so offering them would only produce a refusal — and the
  // panel above already says what is waiting on whom.
  const awaitingApproval = approvalBlocksSending(invoice.approval?.state);

  // Editing stays open while it is a draft — correcting something that came
  // back is exactly what should happen next — but it cannot go to the client.
  const canSend = isDraft && !awaitingApproval;

  /*
   * Approval is worth nothing if the figures can move afterwards, so once an
   * invoice is approved — or is part-way through being read by an approver —
   * the person who raised it may no longer edit it. Accounts still can, and a
   * correction goes through them.
   *
   * The server enforces this; hiding the button here spares somebody a click
   * that only ever returns an error.
   */
  const canEdit = isDraft && (canManage || !approvalBlocksEditing(invoice.approval?.state));

  const canVoid = canManage && invoice.status !== "paid" && invoice.status !== "void";
  const canPay =
    canManage && !awaitingApproval &&
    invoice.status !== "paid" && invoice.status !== "void" && invoice.balanceMinor > 0;
  const canCreditNote =
    canManage && ["sent", "paid", "partial"].includes(invoice.status);

  return (
    <div className="space-y-6 p-6">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground"
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-50 text-primary-700">
              <ReceiptText className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">{invoice.invoiceNumber}</h1>
              <p className="text-xs text-foreground-muted">{invoice.customerName}</p>
            </div>
          </div>
          <Badge tone={INVOICE_STATUS_TONE[invoice.status]} className="capitalize ml-1">
            {invoice.status}
          </Badge>
          {invoice.recurring && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2.5 py-0.5 text-xs text-foreground-muted">
              <RefreshCw className="h-3 w-3" /> {invoice.recurring.frequency}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              downloadInvoicePdf({ invoice, org, customer, bankAccount })
            }
            title="Download this invoice as a PDF"
          >
            <Download className="h-3.5 w-3.5" /> PDF
          </Button>
          {canEdit && (
            <Link href={`/invoices/${id}/edit`}>
              <Button variant="outline" size="sm"><Pencil className="h-3.5 w-3.5" /> Edit</Button>
            </Link>
          )}
          {canSend && (
            <Button
              size="sm"
              loading={send.isPending}
              onClick={() => send.mutate(id, {
                onSuccess: () => toast.success("Invoice sent"),
                onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to send invoice"),
              })}
            >
              <Send className="h-3.5 w-3.5" /> Send
            </Button>
          )}
          {!isDraft && invoice.status !== "void" && (
            <Button variant="outline" size="sm" onClick={() => setResendOpen(true)}>
              <RotateCcw className="h-3.5 w-3.5" /> Resend
            </Button>
          )}
          {canCreditNote && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/credit-notes/new?invoiceId=${id}`)}
            >
              <FileX className="h-3.5 w-3.5" /> Credit Note
            </Button>
          )}
          {canPay && (
            <Button size="sm" onClick={() => setPayOpen(true)}>
              <CreditCard className="h-3.5 w-3.5" /> Record Payment
            </Button>
          )}
          {canVoid && !isDraft && (
            <Button
              variant="outline"
              size="sm"
              loading={voidInv.isPending}
              onClick={() => voidInv.mutate(id, {
                onSuccess: () => toast.success("Invoice voided"),
                onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to void invoice"),
              })}
              className="text-danger hover:border-danger/50"
            >
              <Ban className="h-3.5 w-3.5" /> Void
            </Button>
          )}
        </div>
      </div>

      {/* The enrolment and its decision, above the invoice itself: whether
          this has been approved governs everything below it. */}
      <ApprovalPanel invoice={invoice} />

      <InvoiceAttachments invoice={invoice} />

      <PaymentDialog
        open={payOpen}
        onClose={() => { setPayOpen(false); setEditingPayment(null); }}
        invoiceId={id}
        balanceMinor={invoice.balanceMinor}
        currency={invoice.currency}
        editing={editingPayment}
      />

      {/* Resend dialog */}
      <Dialog open={resendOpen} onOpenChange={(o) => !o && setResendOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Resend Invoice</DialogTitle></DialogHeader>
          <div className="space-y-3 pt-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground-muted">
                Custom message <span className="text-foreground-subtle">(optional)</span>
              </label>
              <textarea
                value={resendMsg}
                onChange={(e) => setResendMsg(e.target.value)}
                rows={3}
                placeholder="Add a personal note to the email…"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 resize-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="sm">Cancel</Button>
              </DialogClose>
              <Button
                size="sm"
                loading={resend.isPending}
                onClick={() => resend.mutate({ id, message: resendMsg || undefined }, {
                  onSuccess: () => { toast.success("Invoice resent"); setResendOpen(false); setResendMsg(""); },
                  onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to resend"),
                })}
              >
                <Send className="h-3.5 w-3.5" /> Send
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Meta grid */}
      <div className="grid gap-4 rounded-lg border border-border bg-surface p-5 sm:grid-cols-2 lg:grid-cols-4">
        <Meta label="Customer" value={invoice.customerName} />
        <Meta label="Salesperson" value={invoice.salespersonName} />
        {invoice.reference && <Meta label="Reference" value={invoice.reference} />}
        <Meta label="Issue date" value={invoice.issueDate} />
        <Meta label="Due date" value={invoice.dueDate} />
        <Meta label="Currency" value={invoice.currency} />
        {invoice.tags.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-foreground-muted">Tags</p>
            <TagList tags={invoice.tags} />
          </div>
        )}
      </div>

      {/* Progress info */}
      {invoice.progress && (
        <div className="rounded-lg border border-border bg-surface p-5 space-y-2">
          <h3 className="text-sm font-semibold">Progress Invoice</h3>
          <div className="grid gap-3 sm:grid-cols-3 text-sm">
            <Meta label="Contract" value={invoice.progress.contractDescription} />
            <Meta label="Contract value" value={formatMoney(invoice.progress.contractValueMinor, invoice.currency)} />
            <Meta label="Stage" value={`${invoice.progress.stageName} (#${invoice.progress.stageNumber})`} />
            <Meta label="% of contract" value={`${invoice.progress.pctOfContract}%`} />
          </div>
        </div>
      )}

      {/* Line items */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-primary text-primary-foreground">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">Description</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">Qty</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">Unit price</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">Disc %</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">Taxes</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.map((line, i) => (
              <tr key={i} className="border-t border-border">
                <td className="px-4 py-3">{line.description}</td>
                <td className="px-4 py-3 text-right text-foreground-muted">{line.quantity}</td>
                <td className="px-4 py-3 text-right font-numeric text-foreground-muted">
                  {formatMoney(line.unitPriceMinor, invoice.currency)}
                </td>
                <td className="px-4 py-3 text-right text-foreground-muted">
                  {line.discountPct > 0 ? `${line.discountPct}%` : "—"}
                </td>
                <td className="px-4 py-3 text-right text-foreground-muted">
                  {line.taxes.length > 0
                    ? line.taxes.map((t) => `${t.code} ${t.rate}%`).join(", ")
                    : "—"}
                </td>
                <td className="px-4 py-3 text-right font-numeric font-medium">
                  {formatMoney(line.lineTotalMinor, invoice.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Totals + notes */}
      <div className="flex flex-col gap-6 lg:flex-row lg:justify-between">
        <div className="flex-1 space-y-4">
          {invoice.notes && (
            <div>
              <p className="mb-1 text-xs font-medium text-foreground-muted">Notes</p>
              <p className="text-sm whitespace-pre-wrap">{invoice.notes}</p>
            </div>
          )}
          {invoice.terms && (
            <div>
              <p className="mb-1 text-xs font-medium text-foreground-muted">Terms</p>
              <p className="text-sm whitespace-pre-wrap">{invoice.terms}</p>
            </div>
          )}
        </div>

        <div className="w-full max-w-xs space-y-2 rounded-lg border border-border bg-surface p-4 lg:self-start">
          <TotalRow label="Subtotal" value={invoice.subtotalMinor} currency={invoice.currency} />
          {invoice.discountTotalMinor > 0 && (
            <TotalRow label="Discount" value={invoice.discountTotalMinor} currency={invoice.currency} />
          )}
          {invoice.taxBreakdown.map((t) => (
            <TotalRow key={t.code} label={`Tax (${t.code})`} value={t.amountMinor} currency={invoice.currency} />
          ))}
          <TotalRow label="Total" value={invoice.totalMinor} currency={invoice.currency} strong />
          {invoice.amountPaidMinor > 0 && (
            <TotalRow label="Paid" value={invoice.amountPaidMinor} currency={invoice.currency} />
          )}
          <TotalRow label="Balance due" value={invoice.balanceMinor} currency={invoice.currency} strong={invoice.balanceMinor > 0} />
        </div>
      </div>

      {/* Payment history */}
      {invoice.payments.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Payment History</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-muted">
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Method</th>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 font-medium">Reference</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {invoice.payments.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-4 py-2.5 text-foreground-muted align-top">{p.paidOn}</td>
                  <td className="px-4 py-2.5 align-top">
                    <span className="capitalize">{paymentMethodLabel(p.method)}</span>
                    {p.emi && (
                      <span className="mt-0.5 block text-xs text-foreground-muted">
                        {p.emi.tenureMonths} mo{p.emi.interestPct ? ` · ${p.emi.interestPct}%` : ""}{p.emi.bank ? ` · ${p.emi.bank}` : ""}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-foreground-muted align-top">{p.accountName || "—"}</td>
                  <td className="px-4 py-2.5 text-foreground-muted align-top">{p.reference || p.emi?.transactionId || "—"}</td>
                  <td className="px-4 py-2.5 text-right align-top">
                    <span className="font-numeric font-medium text-success">{formatMoney(p.amountMinor, invoice.currency)}</span>
                    {p.chargesMinor > 0 && (
                      <span className="mt-0.5 block text-xs text-foreground-muted">
                        charges {formatMoney(p.chargesMinor, invoice.currency)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {p.proofUrl && (
                        <a
                          href={p.proofUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          title="View proof of payment"
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                        </a>
                      )}
                      {canManage && invoice.status !== "void" && (
                        <button
                          onClick={() => { setEditingPayment(p); setPayOpen(true); }}
                          className="inline-flex items-center gap-1 text-xs text-foreground-muted hover:text-foreground"
                          title="Edit payment"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => router.push(`/invoices/${id}/payments/${p.id}/receipt`)}
                        className="inline-flex items-center gap-1 text-xs text-foreground-muted hover:text-foreground"
                        title="View receipt"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PaymentDialog({
  open,
  onClose,
  invoiceId,
  balanceMinor,
  currency,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  invoiceId: string;
  balanceMinor: number;
  currency: string;
  editing?: Payment | null;
}) {
  const record = useRecordPayment(invoiceId);
  const update = useUpdatePayment(invoiceId);
  const isEdit = !!editing;
  const [proofFile, setProofFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: {
      method: "bank_transfer",
      amount: balanceMinor / 100,
      paidOn: new Date().toISOString().slice(0, 10),
      reference: "",
      notes: "",
      accountName: "",
    },
  });

  // Sync the form to the payment being edited (or reset to defaults) each open.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      reset({
        method: editing.method,
        amount: editing.amountMinor / 100,
        paidOn: editing.paidOn,
        reference: editing.reference ?? "",
        notes: editing.notes ?? "",
        accountName: editing.accountName ?? "",
        charges: (editing.chargesMinor ?? 0) / 100,
        emi: editing.emi ? { ...editing.emi } : undefined,
      });
    } else {
      reset({
        method: "bank_transfer",
        amount: balanceMinor / 100,
        paidOn: new Date().toISOString().slice(0, 10),
        reference: "",
        notes: "",
        accountName: "",
        charges: 0,
        emi: undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const method = watch("method");

  function handleClose() {
    reset();
    setProofFile(null);
    onClose();
  }

  function handleMethodChange(v: string) {
    setValue("method", v as PaymentFormValues["method"]);
    if (v === "easebuzz_emi") {
      setValue("emi", { bank: "", tenureMonths: 3, monthlyAmountMinor: 0, interestPct: 0, processingFeeMinor: 0, transactionId: "" });
    } else {
      setValue("emi", undefined);
    }
  }

  async function onSubmit(data: PaymentFormValues) {
    const input: RecordPaymentInput = {
      method: data.method,
      amountMinor: Math.round(data.amount * 100),
      paidOn: data.paidOn,
      reference: data.reference,
      notes: data.notes,
      accountName: data.accountName,
      chargesMinor: Math.round((data.charges || 0) * 100),
      ...(data.method === "easebuzz_emi" && data.emi ? { emi: data.emi } : {}),
    };
    try {
      if (editing) {
        await update.mutateAsync({ paymentId: editing.id, input });
        toast.success("Payment updated");
      } else {
        await record.mutateAsync({ input, file: proofFile ?? undefined });
        toast.success("Payment recorded");
      }
      reset();
      setProofFile(null);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Failed to ${editing ? "update" : "record"} payment`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Payment" : "Record Payment"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-xs font-medium text-foreground-muted">Method</label>
              <Select value={method} onValueChange={handleMethodChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>{paymentMethodLabel(m)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {method === "easebuzz_emi" && (
              <div className="col-span-2 rounded-md border border-border bg-surface-muted/40 p-3">
                <p className="mb-2 text-xs font-semibold text-foreground-muted">Easebuzz EMI details</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-foreground-muted">Bank / Provider</label>
                    <Input {...register("emi.bank")} placeholder="e.g. HDFC Bank" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-foreground-muted">Tenure (months)</label>
                    <Input
                      key={`tenure-${editing?.id ?? "new"}`}
                      type="number"
                      min={1}
                      max={60}
                      defaultValue={editing?.emi?.tenureMonths ?? 3}
                      onChange={(e) => setValue("emi.tenureMonths", parseInt(e.target.value || "0", 10))}
                    />
                    {errors.emi?.tenureMonths && <p className="mt-1 text-xs text-danger">{errors.emi.tenureMonths.message}</p>}
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-foreground-muted">Monthly EMI ({currency})</label>
                    <Input key={`monthly-${editing?.id ?? "new"}`} type="number" step="0.01" placeholder="0.00" defaultValue={editing?.emi?.monthlyAmountMinor ? editing.emi.monthlyAmountMinor / 100 : undefined} onChange={(e) => setValue("emi.monthlyAmountMinor", Math.round((parseFloat(e.target.value) || 0) * 100))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-foreground-muted">Interest %</label>
                    <Input key={`interest-${editing?.id ?? "new"}`} type="number" step="0.01" placeholder="0" defaultValue={editing?.emi?.interestPct || undefined} onChange={(e) => setValue("emi.interestPct", parseFloat(e.target.value) || 0)} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-foreground-muted">Processing Fee ({currency})</label>
                    <Input key={`procfee-${editing?.id ?? "new"}`} type="number" step="0.01" placeholder="0.00" defaultValue={editing?.emi?.processingFeeMinor ? editing.emi.processingFeeMinor / 100 : undefined} onChange={(e) => setValue("emi.processingFeeMinor", Math.round((parseFloat(e.target.value) || 0) * 100))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-foreground-muted">Easebuzz Txn ID</label>
                    <Input {...register("emi.transactionId")} placeholder="Transaction / reference id" />
                  </div>
                </div>
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground-muted">
                Amount ({currency})
              </label>
              <Input
                type="number"
                step="0.01"
                min="0.01"
                {...register("amount", { valueAsNumber: true })}
              />
              {errors.amount && (
                <p className="mt-1 text-xs text-danger">{errors.amount.message}</p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground-muted">Date</label>
              <Input type="date" {...register("paidOn")} />
              {errors.paidOn && (
                <p className="mt-1 text-xs text-danger">{errors.paidOn.message}</p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground-muted">
                Account <span className="text-foreground-subtle">(optional)</span>
              </label>
              <Input {...register("accountName")} placeholder="Bank account name…" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground-muted">
                Charges ({currency}) <span className="text-foreground-subtle">(optional)</span>
              </label>
              <Input type="number" step="0.01" min="0" placeholder="0.00" {...register("charges", { valueAsNumber: true })} />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs font-medium text-foreground-muted">
                Reference <span className="text-foreground-subtle">(optional)</span>
              </label>
              <Input {...register("reference")} placeholder="Cheque #, txn ID…" />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs font-medium text-foreground-muted">
                Notes <span className="text-foreground-subtle">(optional)</span>
              </label>
              <Input {...register("notes")} placeholder="Any additional notes…" />
            </div>
            <div className={`col-span-2 ${isEdit ? "hidden" : ""}`}>
              <label className="mb-1 block text-xs font-medium text-foreground-muted">
                Proof of Payment <span className="text-foreground-subtle">(optional)</span>
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className="hidden"
                onChange={(e) => setProofFile(e.target.files?.[0] ?? null)}
              />
              {proofFile ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm">
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{proofFile.name}</span>
                  <span className="shrink-0 text-xs text-foreground-muted">
                    {(proofFile.size / 1024).toFixed(0)} KB
                  </span>
                  <button
                    type="button"
                    onClick={() => { setProofFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                    className="shrink-0 rounded p-0.5 text-foreground-muted hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-foreground-muted transition-colors hover:border-primary hover:text-foreground"
                >
                  <Paperclip className="h-4 w-4" />
                  Attach receipt, screenshot, or PDF…
                </button>
              )}
            </div>
          </div>
          <p className="text-xs text-foreground-muted">
            Balance due: <span className="font-numeric font-medium">{formatMoney(balanceMinor, currency)}</span>
          </p>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm" onClick={handleClose}>Cancel</Button>
            </DialogClose>
            <Button type="submit" size="sm" loading={isSubmitting || record.isPending}>
              <Plus className="h-3.5 w-3.5" /> {isEdit ? "Save changes" : "Save Payment"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mb-0.5 text-xs font-medium text-foreground-muted">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  );
}

function TotalRow({
  label,
  value,
  currency,
  strong,
}: {
  label: string;
  value: number;
  currency: string;
  strong?: boolean;
}) {
  return (
    <div className={`flex justify-between gap-8 ${strong ? "border-t border-border pt-2 font-semibold" : "text-sm text-foreground-muted"}`}>
      <span>{label}</span>
      <MoneyDisplay minor={value} currency={currency} className="font-numeric" />
    </div>
  );
}
