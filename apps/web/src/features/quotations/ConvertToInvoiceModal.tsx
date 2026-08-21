"use client";

import { useMemo, useState } from "react";
import { formatMoney, toMinor, type Quotation, type ConvertToInvoiceInput } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConvertToInvoice } from "./api";

type Mode = "full" | "custom" | "per_line";
type CustomKind = "percentage" | "amount";

export function ConvertToInvoiceModal({
  quote,
  open,
  onClose,
  onConverted,
}: {
  quote: Quotation;
  open: boolean;
  onClose: () => void;
  onConverted: (invoiceId: string) => void;
}) {
  const convert = useConvertToInvoice();
  const currency = quote.currency;
  const quoteTotal = quote.totalMinor;
  const invoiced = quote.invoicedMinor ?? 0;
  const remaining = Math.max(0, quoteTotal - invoiced);

  const [mode, setMode] = useState<Mode>("full");
  const [customKind, setCustomKind] = useState<CustomKind>("percentage");
  const [customValue, setCustomValue] = useState("");
  const [lineAmounts, setLineAmounts] = useState<string[]>(() => quote.lineItems.map(() => ""));

  // Amount (minor) that will be invoiced for the current selection.
  const toBeInvoicedMinor = useMemo(() => {
    if (mode === "full") return remaining;
    if (mode === "custom") {
      const n = parseFloat(customValue);
      if (!isFinite(n) || n <= 0) return 0;
      return customKind === "percentage" ? Math.round((quoteTotal * n) / 100) : toMinor(n);
    }
    // per_line — sum of the ex-tax line amounts (tax is added on top, so this is an approximation)
    return lineAmounts.reduce((s, v) => s + (parseFloat(v) > 0 ? toMinor(v) : 0), 0);
  }, [mode, customKind, customValue, lineAmounts, quoteTotal, remaining]);

  const exceeds = mode !== "per_line" && toBeInvoicedMinor > remaining + 2;
  const canSubmit = toBeInvoicedMinor > 0 && !exceeds;

  async function handleConvert() {
    let input: ConvertToInvoiceInput;
    if (mode === "full") {
      input = { mode: "full" };
    } else if (mode === "custom") {
      input =
        customKind === "percentage"
          ? { mode: "percentage", percentage: parseFloat(customValue) || 0 }
          : { mode: "amount", amountMinor: toMinor(customValue) };
    } else {
      input = { mode: "per_line", lineAmountsMinor: lineAmounts.map((v) => (parseFloat(v) > 0 ? toMinor(v) : 0)) };
    }
    try {
      const res = await convert.mutateAsync({ id: quote.id, input });
      toast.success(`Invoice ${res.invoice.invoiceNumber} created`);
      onConverted(res.invoice.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to convert to invoice");
    }
  }

  const Radio = ({ value, label, children }: { value: Mode; label: string; children?: React.ReactNode }) => (
    <label className={`block rounded-lg border p-4 cursor-pointer transition-colors ${mode === value ? "border-primary bg-primary/5" : "border-border hover:bg-surface-muted"}`}>
      <div className="flex items-center gap-2">
        <input type="radio" name="convert-mode" checked={mode === value} onChange={() => setMode(value)} className="h-4 w-4 accent-primary" />
        <span className="text-sm font-medium">{label}</span>
      </div>
      {mode === value && children && <div className="mt-3 pl-6">{children}</div>}
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Convert to Invoice</DialogTitle></DialogHeader>

        <div className="rounded-lg border border-border bg-surface p-3 text-sm">
          <div className="flex justify-between"><span className="text-foreground-muted">Quote total</span><span className="font-numeric font-medium">{formatMoney(quoteTotal, currency)}</span></div>
          {invoiced > 0 && (
            <div className="flex justify-between"><span className="text-foreground-muted">Already invoiced</span><span className="font-numeric">{formatMoney(invoiced, currency)}</span></div>
          )}
          <div className="flex justify-between border-t border-border mt-1.5 pt-1.5"><span className="font-medium">Remaining balance</span><span className="font-numeric font-semibold text-warning">{formatMoney(remaining, currency)}</span></div>
        </div>

        <p className="text-sm text-foreground-muted">Choose how you want to invoice</p>
        <div className="space-y-2">
          <Radio value="full" label="Invoice the entire remaining amount" />

          <Radio value="custom" label="Invoice a custom amount or percentage">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="0.01"
                min="0"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                placeholder="0"
                className="w-40"
              />
              <div className="inline-flex rounded-md border border-border overflow-hidden">
                <button type="button" onClick={() => setCustomKind("percentage")} className={`px-3 py-1.5 text-sm ${customKind === "percentage" ? "bg-primary text-white" : "hover:bg-surface-muted"}`}>%</button>
                <button type="button" onClick={() => setCustomKind("amount")} className={`px-3 py-1.5 text-sm ${customKind === "amount" ? "bg-primary text-white" : "hover:bg-surface-muted"}`}>{currency}</button>
              </div>
            </div>
            <div className="mt-2 space-y-0.5 text-xs">
              <div className="flex justify-between"><span className="text-foreground-muted">To be invoiced</span><span className="font-numeric font-medium">{formatMoney(toBeInvoicedMinor, currency)}</span></div>
              {exceeds && <p className="text-danger">Exceeds the remaining balance of {formatMoney(remaining, currency)}</p>}
              {customKind === "percentage" && <p className="text-foreground-muted">Applied proportionally to every line item.</p>}
            </div>
          </Radio>

          <Radio value="per_line" label="Invoice a custom amount for each line item">
            <div className="space-y-2">
              {quote.lineItems.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_120px] items-center gap-2">
                  <span className="truncate text-sm" title={l.description}>{l.description}</span>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={lineAmounts[i]}
                    onChange={(e) => setLineAmounts((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                    placeholder={`0.00 ${currency}`}
                    className="h-8 text-right"
                  />
                </div>
              ))}
              <p className="text-xs text-foreground-muted">Amounts are pre-tax; tax is added per line. Leave a line at 0 to skip it.</p>
            </div>
          </Radio>
        </div>

        <DialogFooter>
          <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
          <Button onClick={handleConvert} loading={convert.isPending} disabled={!canSubmit}>Create invoice</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
