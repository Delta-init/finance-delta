"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, Landmark, Plus, Trash2 } from "lucide-react";
import { formatMoney, type TdsReportRow } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { DateField } from "@/components/ui/date-field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUrlParam } from "@/lib/url-state";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { toDmy, todayDubai } from "@/lib/dates";
import { useCan } from "@/lib/use-can";
import { useBankAccounts } from "@/features/banking/api";
import { useDeleteTdsPayment, useRecordTdsPayment, useTdsConfig, useTdsReport } from "@/features/tds/api";

/* TDS report (Bangalore, 2026-11-11: "TDS section required") — what was deducted from vendor bills, by month and
   section, against what was paid to the government; the bills behind it with each vendor's PAN; the payments, each a
   line in Banking. Indian financial year by default (April on). */

const fyStart = () => {
  const t = todayDubai();
  const y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
  return `${m >= 4 ? y : y - 1}-04-01`;
};
const monthName = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return y && m ? new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : p;
};

function download(name: string, head: string[], rows: unknown[][]) {
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const blob = new Blob(["﻿" + [head, ...rows].map((r) => r.map(cell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

export default function TdsReportPage() {
  const router = useRouter();
  const { can } = useCan();
  const [from, setFrom] = useUrlParam("from", fyStart());
  const [to, setTo] = useUrlParam("to", todayDubai());
  const { data: cfg, isLoading: cfgLoading } = useTdsConfig();
  const { data, isLoading, error } = useTdsReport({ from, to }, !!cfg?.available);
  const [paying, setPaying] = useState<{ period: string; section: string; amountMinor: number } | null>(null);
  const remove = useDeleteTdsPayment();
  const currency = data?.currency ?? "INR";
  const canPay = can("banking:write");

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Landmark}
        title="TDS report"
        description="TDS deducted from vendor bills by month and section, what was paid to the government, and what is still owed."
        action={<Button variant="outline" onClick={() => router.push("/reports")}><ArrowLeft className="h-4 w-4" /> All reports</Button>}
      />
      {cfgLoading ? <p className="text-sm text-foreground-muted">Loading…</p> : !cfg?.available ? (
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-foreground-muted">
          TDS is for the organization that keeps its books in INR (Bangalore). Switch to it to see its TDS.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1"><Label>From</Label><DatePicker value={from} onChange={setFrom} className="w-[160px]" /></div>
            <div className="space-y-1"><Label>To</Label><DatePicker value={to} onChange={setTo} className="w-[160px]" /></div>
            {!cfg.enabled && <p className="text-xs text-warning">TDS is turned off in Settings → Taxes — new bills aren&apos;t deducted.</p>}
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" disabled={!data?.bills.length}
                onClick={() => data && download(`tds-bills-${from}-to-${to}.csv`,
                  ["Bill", "Bill date", "Vendor", "PAN", "Section", "Rate %", `Base (${currency})`, `TDS (${currency})`, "Status"],
                  data.bills.map((b) => [b.billNumber, toDmy(b.billDate), b.vendorName, b.pan, b.section, b.ratePct, b.baseMinor / 100, b.tdsMinor / 100, b.status]))}>
                <Download className="mr-1.5 h-4 w-4" />Export bills
              </Button>
              {canPay && <Button size="sm" onClick={() => setPaying({ period: todayDubai().slice(0, 7), section: "", amountMinor: 0 })}><Plus className="mr-1.5 h-4 w-4" />Record TDS paid</Button>}
            </div>
          </div>

          {isLoading ? <p className="text-sm text-foreground-muted">Loading…</p> : error ? (
            <p className="text-sm text-danger">{error instanceof ApiError ? error.message : "Could not load the TDS report"}</p>
          ) : data && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                {[["TDS deducted", data.totals.tdsMinor, ""], ["Paid to the government", data.totals.paidMinor, ""], ["Still owed", data.totals.owedMinor, data.totals.owedMinor > 0 ? "text-danger" : ""]].map(([label, v, tone]) => (
                  <div key={String(label)} className="rounded-lg border border-border bg-surface p-4">
                    <p className="text-xs text-foreground-muted">{label}</p>
                    <p className={`mt-1 text-xl font-semibold ${tone}`}>{formatMoney(Number(v), currency)}</p>
                  </div>
                ))}
              </div>

              <section className="overflow-x-auto rounded-lg border border-border bg-surface">
                <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">By month and section</h2>
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-foreground-subtle">
                    <tr><th className="px-4 py-2">Month</th><th className="px-4 py-2">Section</th><th className="px-4 py-2 text-right">Bills</th><th className="px-4 py-2 text-right">Before GST</th><th className="px-4 py-2 text-right">TDS</th><th className="px-4 py-2 text-right">Paid</th><th className="px-4 py-2 text-right">Owed</th><th className="px-4 py-2" /></tr>
                  </thead>
                  <tbody>
                    {!data.rows.length && <tr><td colSpan={8} className="px-4 py-8 text-center text-foreground-muted">No TDS in these dates.</td></tr>}
                    {data.rows.map((r: TdsReportRow) => (
                      <tr key={`${r.period}|${r.section}`} className="border-t border-border">
                        <td className="px-4 py-2">{monthName(r.period)}</td>
                        <td className="px-4 py-2" title={r.label}>{r.section || "All sections"}</td>
                        <td className="px-4 py-2 text-right">{r.bills}</td>
                        <td className="px-4 py-2 text-right font-numeric">{formatMoney(r.baseMinor, currency)}</td>
                        <td className="px-4 py-2 text-right font-numeric">{formatMoney(r.tdsMinor, currency)}</td>
                        <td className="px-4 py-2 text-right font-numeric">{formatMoney(r.paidMinor, currency)}</td>
                        <td className={`px-4 py-2 text-right font-numeric ${r.owedMinor > 0 ? "text-danger" : ""}`}>{formatMoney(r.owedMinor, currency)}</td>
                        <td className="px-4 py-2 text-right">
                          {canPay && r.owedMinor > 0 && <Button size="sm" variant="outline" onClick={() => setPaying({ period: r.period, section: r.section, amountMinor: r.owedMinor })}>Record paid</Button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="overflow-x-auto rounded-lg border border-border bg-surface">
                <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">TDS paid</h2>
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-foreground-subtle">
                    <tr><th className="px-4 py-2">Paid on</th><th className="px-4 py-2">For</th><th className="px-4 py-2">From</th><th className="px-4 py-2">Challan</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2" /></tr>
                  </thead>
                  <tbody>
                    {!data.payments.length && <tr><td colSpan={6} className="px-4 py-6 text-center text-foreground-muted">Nothing recorded as paid in these dates.</td></tr>}
                    {data.payments.map((p) => (
                      <tr key={p.id} className="border-t border-border">
                        <td className="px-4 py-2">{toDmy(p.paidOn)}</td>
                        <td className="px-4 py-2">{monthName(p.period)} · {p.section || "All sections"}</td>
                        <td className="px-4 py-2">{p.accountName}{!p.inBank && <span className="ml-1 text-xs text-warning">(its line was removed from Banking)</span>}</td>
                        <td className="px-4 py-2">{p.challanNo || "—"}</td>
                        <td className="px-4 py-2 text-right font-numeric">{formatMoney(p.amountMinor, currency)}</td>
                        <td className="px-4 py-2 text-right">
                          {canPay && (
                            <button type="button" className="text-foreground-subtle hover:text-danger disabled:opacity-50" disabled={remove.isPending} aria-label="Take this payment back"
                              onClick={async () => {
                                if (!confirm("Take this TDS payment back? Its line comes out of Banking.")) return;
                                try { await remove.mutateAsync(p.id); toast.success("Taken back"); } catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not take it back"); }
                              }}>
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="overflow-x-auto rounded-lg border border-border bg-surface">
                <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Bills with TDS</h2>
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-foreground-subtle">
                    <tr><th className="px-4 py-2">Bill</th><th className="px-4 py-2">Date</th><th className="px-4 py-2">Vendor</th><th className="px-4 py-2">PAN</th><th className="px-4 py-2">Section</th><th className="px-4 py-2 text-right">Before GST</th><th className="px-4 py-2 text-right">TDS</th></tr>
                  </thead>
                  <tbody>
                    {!data.bills.length && <tr><td colSpan={7} className="px-4 py-6 text-center text-foreground-muted">No bills with TDS in these dates.</td></tr>}
                    {data.bills.map((b) => (
                      <tr key={b.id} className="border-t border-border">
                        <td className="px-4 py-2"><Link href={`/bills/${b.id}`} className="font-medium text-primary hover:underline">{b.billNumber}</Link></td>
                        <td className="px-4 py-2">{toDmy(b.billDate)}</td>
                        <td className="px-4 py-2">{b.vendorName}</td>
                        <td className="px-4 py-2">{b.pan || <span className="text-warning">no PAN</span>}</td>
                        <td className="px-4 py-2">{b.section} · {b.ratePct}%</td>
                        <td className="px-4 py-2 text-right font-numeric">{formatMoney(b.baseMinor, currency)}</td>
                        <td className="px-4 py-2 text-right font-numeric">{formatMoney(b.tdsMinor, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </>
      )}
      {paying && cfg && <RecordTdsPaidDialog initial={paying} currency={currency} sections={cfg.sections.map((s) => s.code)} onClose={() => setPaying(null)} />}
    </div>
  );
}

function RecordTdsPaidDialog({ initial, currency, sections, onClose }: {
  initial: { period: string; section: string; amountMinor: number }; currency: string; sections: string[]; onClose: () => void;
}) {
  const { data: accountList } = useBankAccounts({ isActive: "true", pageSize: 100 });
  const accounts = (accountList?.data ?? []).filter((a) => a.currency === currency);
  const record = useRecordTdsPayment();
  const [period, setPeriod] = useState(initial.period);
  const [section, setSection] = useState(initial.section);
  const [amount, setAmount] = useState(initial.amountMinor ? (initial.amountMinor / 100).toFixed(2) : "");
  const [paidOn, setPaidOn] = useState(todayDubai());
  const [accountId, setAccountId] = useState("");
  const [challanNo, setChallanNo] = useState("");
  const save = async () => {
    const amountMinor = Math.round(Number(amount.replace(/,/g, "")) * 100);
    if (!(amountMinor > 0)) { toast.error("Enter the amount paid"); return; }
    if (!accountId) { toast.error("Choose the account it was paid from"); return; }
    try {
      await record.mutateAsync({ period, section, amountMinor, paidOn, bankAccountId: accountId, challanNo, notes: "" });
      toast.success("TDS payment recorded — it's in Banking");
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not record it");
    }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record TDS paid</DialogTitle>
          <DialogDescription>Paid to the government for a month&apos;s TDS. It goes out of the account as a line in Banking.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="tds-period">For the month</Label><Input id="tds-period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></div>
          <div className="space-y-1">
            <Label htmlFor="tds-section">Section</Label>
            <select id="tds-section" value={section} onChange={(e) => setSection(e.target.value)} className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm">
              <option value="">All sections</option>
              {sections.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="space-y-1"><Label htmlFor="tds-amount">Amount ({currency})</Label><Input id="tds-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="tds-paid-on">Paid on</Label><DateField id="tds-paid-on" value={paidOn} onChange={setPaidOn} /></div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="tds-account">Paid from</Label>
            <select id="tds-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm">
              <option value="">Choose the account</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountName}</option>)}
            </select>
            {!accounts.length && <p className="text-xs text-warning">No open {currency} account — add one under Banking.</p>}
          </div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="tds-challan">Challan number</Label><Input id="tds-challan" value={challanNo} onChange={(e) => setChallanNo(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={record.isPending}>Cancel</Button>
          <Button onClick={save} disabled={record.isPending}>{record.isPending ? "Saving…" : "Record"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
