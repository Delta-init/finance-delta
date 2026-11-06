"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  expectedPspFeeMinor, formatMoney,
  type BankAccount, type CreatePspSettlementInput, type PspSettings, type PspSettlementDTO, type PspSummary, type PspUnsettledLine,
} from "@delta/shared";
import { AlertTriangle, Landmark, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useBankAccounts, useUpdateBankAccount } from "./api";

/*
 * PSP accounts (the user, 2026-11-06): Tabby, Tamara, Billexpro, Easebuzz, a card acquirer. Clients' payments land in
 * one whole; when the provider pays them on to a bank, less its fee, that is a settlement — recorded here. The account's
 * settings say what each payment should cost and where it settles; what arrives decides the fee booked (an expense in
 * Bank Fees & Charges › Payment Gateway Fees). API: modules/psp-settlement.
 */

const KEY = ["bank-accounts"] as const;
const pspKey = (id: string) => [...KEY, id, "psp"] as const;

export function usePspSummary(id: string, enabled = true) {
  return useQuery({ queryKey: [...pspKey(id), "summary"], queryFn: () => api.get<PspSummary>(`bank-accounts/${id}/psp/summary`), enabled });
}
export function usePspUnsettled(id: string, enabled = true) {
  return useQuery({ queryKey: [...pspKey(id), "unsettled"], queryFn: () => api.get<PspUnsettledLine[]>(`bank-accounts/${id}/psp/unsettled`), enabled });
}
export function usePspSettlements(id: string, enabled = true) {
  return useQuery({ queryKey: [...pspKey(id), "settlements"], queryFn: () => api.get<PspSettlementDTO[]>(`bank-accounts/${id}/psp/settlements`), enabled });
}
/** A settlement moves money in two accounts and adds an expense: everything banking and expenses show is refreshed. */
function useRefreshAll() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: KEY });
    qc.invalidateQueries({ queryKey: ["expenses"] });
    qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith("bank") });
  };
}
export function useCreatePspSettlement(id: string) {
  const refresh = useRefreshAll();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreatePspSettlementInput) => api.post<PspSettlementDTO>(`bank-accounts/${id}/psp/settlements`, input),
    onSuccess: refresh,
  });
}
export function useDeletePspSettlement(id: string) {
  const refresh = useRefreshAll();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (settlementId: string) => api.del<void>(`bank-accounts/${id}/psp/settlements/${settlementId}`),
    onSuccess: refresh,
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────

export type PspDraft = { provider: string; feePct: string; fixedFee: string; feeVatPct: string; settlementAccountId: string; settlementDays: string; startDate: string };

export function draftOf(p: BankAccount["psp"] | null | undefined): PspDraft {
  return {
    provider: p?.provider ?? "", feePct: p ? String(p.feePct) : "", fixedFee: p ? String(p.fixedFeeMinor / 100) : "",
    feeVatPct: p ? String(p.feeVatPct) : "5", settlementAccountId: p?.settlementAccountId ?? "", settlementDays: p ? String(p.settlementDays) : "7",
    startDate: p?.startDate ?? new Date().toISOString().slice(0, 10),
  };
}
const num = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? 0 : Number(v));
export function settingsOf(d: PspDraft): PspSettings {
  return {
    provider: d.provider.trim(), feePct: num(d.feePct), fixedFeeMinor: Math.round(num(d.fixedFee) * 100), feeVatPct: num(d.feeVatPct),
    settlementAccountId: d.settlementAccountId, settlementDays: Math.round(num(d.settlementDays)), startDate: d.startDate || undefined,
  };
}

/** What a PSP charges and where it settles — in the new-account form and the settings dialog. */
export function PspSettingsFields({ value, onChange, currency, selfId }: {
  value: PspDraft; onChange: (v: PspDraft) => void; currency: string; selfId?: string;
}) {
  const { data } = useBankAccounts({ page: 1, pageSize: 100, isActive: "true" });
  const banks = (data?.data ?? []).filter((a) => a.id !== selfId && a.accountType !== "psp" && a.currency === currency);
  const set = (k: keyof PspDraft) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const example = expectedPspFeeMinor(100_000, settingsOf(value));
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Provider</Label>
          <Input value={value.provider} onChange={set("provider")} placeholder="Tabby, Tamara, Billexpro…" maxLength={60} />
        </div>
        <div className="space-y-1">
          <Label>Settles into *</Label>
          <Select value={value.settlementAccountId} onValueChange={(v) => onChange({ ...value, settlementAccountId: v })}>
            <SelectTrigger><SelectValue placeholder={banks.length ? "Pick the bank account" : `No ${currency} bank account`} /></SelectTrigger>
            <SelectContent>
              {banks.map((a) => <SelectItem key={a.id} value={a.id}>{a.accountName}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Fee (% of each payment)</Label>
          <Input type="number" min={0} max={100} step="0.01" value={value.feePct} onChange={set("feePct")} placeholder="e.g. 5.5" />
        </div>
        <div className="space-y-1">
          <Label>Fixed fee per payment ({currency})</Label>
          <Input type="number" min={0} step="0.01" value={value.fixedFee} onChange={set("fixedFee")} placeholder="e.g. 1" />
        </div>
        <div className="space-y-1">
          <Label>VAT on the fee (%)</Label>
          <Input type="number" min={0} max={100} step="0.01" value={value.feeVatPct} onChange={set("feeVatPct")} />
        </div>
        <div className="space-y-1">
          <Label>Settles after (days)</Label>
          <Input type="number" min={0} max={120} value={value.settlementDays} onChange={set("settlementDays")} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label>Settlements start on</Label>
          <Input type="date" value={value.startDate} onChange={set("startDate")} className="max-w-[12rem]" />
          <p className="text-xs text-foreground-muted">Money that came in before this day counts as settled already.</p>
        </div>
      </div>
      <p className="rounded-md bg-surface-muted px-3 py-2 text-xs text-foreground-muted">
        A payment of {formatMoney(100_000, currency)} should cost about <b>{formatMoney(example, currency)}</b> (fee and VAT). The fee
        actually booked is what was settled less what arrives in the bank.
      </p>
    </div>
  );
}

/** Make an account a PSP, or change its settings. */
export function PspSettingsDialog({ account, onClose }: { account: BankAccount; onClose: () => void }) {
  const [draft, setDraft] = useState<PspDraft>(() => draftOf(account.psp));
  const update = useUpdateBankAccount(account.id);
  async function save() {
    try {
      await update.mutateAsync({ accountType: "psp", psp: settingsOf(draft) } as never);
      toast.success(account.accountType === "psp" ? "PSP settings saved" : `${account.accountName} is now a PSP account`);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save the PSP settings");
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{account.accountType === "psp" ? "PSP settings" : `Make ${account.accountName} a PSP account`}</DialogTitle>
          <DialogDescription>
            Payments land here whole. When the provider pays them on to your bank, record the settlement — what arrived
            moves to the bank and the rest is booked as its fee.
          </DialogDescription>
        </DialogHeader>
        <PspSettingsFields value={draft} onChange={setDraft} currency={account.currency} selfId={account.id} />
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={update.isPending} disabled={!draft.settlementAccountId} onClick={() => void save()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── The PSP account's page ───────────────────────────────────────────────────

/** On a bank account's page: set it up as a PSP — or, for one, its settings, what waits, and its settlements. */
export function PspPanel({ account, canWrite }: { account: BankAccount; canWrite: boolean }) {
  const isPsp = account.accountType === "psp" && !!account.psp;
  const [editing, setEditing] = useState(false);
  const [settling, setSettling] = useState(false);
  const summary = usePspSummary(account.id, isPsp);
  const settlements = usePspSettlements(account.id, isPsp);
  const del = useDeletePspSettlement(account.id);
  const cur = account.currency;

  if (!isPsp) {
    if (!canWrite || account.accountType === "petty_cash") return null;
    return (
      <>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-surface px-4 py-3 text-sm">
          <span className="text-foreground-muted">Is this a payment provider&apos;s account (Tabby, Tamara, card…) that settles into your bank later?</span>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Landmark className="h-4 w-4" /> Set up as a PSP</Button>
        </div>
        {editing && <PspSettingsDialog account={account} onClose={() => setEditing(false)} />}
      </>
    );
  }

  const p = account.psp!;
  const s = summary.data;
  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Landmark className="h-4 w-4" /> PSP{p.provider ? ` · ${p.provider}` : ""}</h2>
          <p className="mt-0.5 text-xs text-foreground-muted">
            {p.feePct}% {p.fixedFeeMinor > 0 ? `+ ${formatMoney(p.fixedFeeMinor, cur)} a payment` : ""}{p.feeVatPct > 0 ? ` · VAT ${p.feeVatPct}% on the fee` : ""}
            {" · settles into "}<b>{p.settlementAccountName || "—"}</b>{` after ${p.settlementDays} days · from ${p.startDate}`}
          </p>
        </div>
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> Settings</Button>
            <Button size="sm" onClick={() => setSettling(true)} disabled={!s?.unsettledCount}><Plus className="h-4 w-4" /> Record settlement</Button>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md bg-surface-muted p-3">
          <p className="text-xs text-foreground-muted">Waiting to be settled</p>
          <MoneyDisplay minor={s?.unsettledMinor ?? 0} currency={cur} className="text-lg font-semibold" />
          <p className="text-xs text-foreground-muted">{s?.unsettledCount ?? 0} payments</p>
        </div>
        <div className="rounded-md bg-surface-muted p-3">
          <p className="text-xs text-foreground-muted">Expected fees on them</p>
          <MoneyDisplay minor={s?.expectedFeeMinor ?? 0} currency={cur} className="text-lg font-semibold" />
          <p className="text-xs text-foreground-muted">≈ {formatMoney((s?.unsettledMinor ?? 0) - (s?.expectedFeeMinor ?? 0), cur)} to arrive</p>
        </div>
        <div className={`rounded-md p-3 ${s?.lateCount ? "bg-danger/10" : "bg-surface-muted"}`}>
          <p className="text-xs text-foreground-muted">Late — past the day expected</p>
          <MoneyDisplay minor={s?.lateMinor ?? 0} currency={cur} className={`text-lg font-semibold ${s?.lateCount ? "text-danger" : ""}`} />
          <p className="text-xs text-foreground-muted">{s?.lateCount ?? 0} payments</p>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted">Settlements</h3>
        {(settlements.data ?? []).length === 0 ? (
          <p className="text-sm text-foreground-muted">None yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-xs text-foreground-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Settlement</th>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Settled</th>
                  <th className="px-3 py-2 text-right font-medium">Arrived in {p.settlementAccountName}</th>
                  <th className="px-3 py-2 text-right font-medium">Fee</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {(settlements.data ?? []).map((x) => (
                  <tr key={x.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <p className="font-medium">{x.number}</p>
                      <p className="text-xs text-foreground-muted">{x.lineCount} payments{x.reference ? ` · ${x.reference}` : ""}</p>
                    </td>
                    <td className="px-3 py-2 text-foreground-muted">{x.date}</td>
                    <td className="px-3 py-2 text-right tabular-nums"><MoneyDisplay minor={x.grossMinor} currency={x.currency} /></td>
                    <td className="px-3 py-2 text-right tabular-nums text-success"><MoneyDisplay minor={x.receivedMinor} currency={x.currency} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <MoneyDisplay minor={x.feeMinor} currency={x.currency} />
                      {x.expense && <Link href={`/expenses/${x.expense.id}`} className="block text-xs text-primary hover:underline">{x.expense.number}</Link>}
                      {x.feeMinor !== x.expectedFeeMinor && (
                        <span className="block text-xs text-foreground-muted">expected {formatMoney(x.expectedFeeMinor, x.currency)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canWrite && (
                        <button
                          type="button"
                          className="text-foreground-muted hover:text-danger"
                          title="Take this settlement back"
                          onClick={async () => {
                            if (!confirm(`Take ${x.number} back? Its transfer to ${x.bankAccountName} and its fee expense are removed, and its payments wait to be settled again.`)) return;
                            try { await del.mutateAsync(x.id); toast.success(`${x.number} taken back`); }
                            catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not take it back"); }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && <PspSettingsDialog account={account} onClose={() => setEditing(false)} />}
      {settling && <SettlementDialog account={account} onClose={() => setSettling(false)} />}
    </div>
  );
}

/** Which payments the provider paid on, and what arrived. */
function SettlementDialog({ account, onClose }: { account: BankAccount; onClose: () => void }) {
  const cur = account.currency;
  const p = account.psp!;
  const { data: lines, isLoading } = usePspUnsettled(account.id);
  const create = useCreatePspSettlement(account.id);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [upTo, setUpTo] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [received, setReceived] = useState("");
  const [touched, setTouched] = useState(false);
  const [reference, setReference] = useState("");

  const all = lines ?? [];
  const needle = q.trim().toLowerCase();
  const shown = all.filter((l) => (!needle || [l.description, l.reference, l.invoice?.number ?? ""].some((x) => x.toLowerCase().includes(needle))) && (!upTo || l.date <= upTo));
  const chosen = useMemo(() => all.filter((l) => picked.has(l.id)), [all, picked]);
  const gross = chosen.reduce((a, l) => a + l.amountMinor, 0);
  const expectedFee = chosen.reduce((a, l) => a + l.expectedFeeMinor, 0);
  const receivedMinor = touched ? Math.round(num(received) * 100) : gross - expectedFee;
  const fee = gross - receivedMinor;
  const allShown = shown.length > 0 && shown.every((l) => picked.has(l.id));
  const ready = chosen.length > 0 && receivedMinor > 0 && receivedMinor <= gross && !!date;

  async function save() {
    try {
      const s = await create.mutateAsync({ lineIds: chosen.map((l) => l.id), date, receivedMinor, reference: reference.trim(), notes: "" });
      toast.success(`${s.number} recorded — ${formatMoney(s.receivedMinor, cur)} to ${s.bankAccountName}${s.feeMinor ? `, fee ${formatMoney(s.feeMinor, cur)}` : ""}`);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not record the settlement");
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !create.isPending) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Record a settlement from {p.provider || account.accountName}</DialogTitle>
          <DialogDescription>
            Pick the payments it paid on to {p.settlementAccountName}, and say what arrived. What arrived moves to {p.settlementAccountName};
            the rest is booked as its fee.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
          <div className="flex flex-wrap items-end gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search invoice, client, reference…" className="pl-8" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Paid up to</Label>
              <Input type="date" value={upTo} onChange={(e) => setUpTo(e.target.value)} className="w-[10rem]" />
            </div>
            <Button
              type="button" variant="ghost" size="sm" disabled={shown.length === 0}
              onClick={() => setPicked((prev) => { const n = new Set(prev); shown.forEach((l) => (allShown ? n.delete(l.id) : n.add(l.id))); return n; })}
            >
              {allShown ? "Clear" : "Select all"}{needle || upTo ? " shown" : ""}
            </Button>
          </div>

          <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
            {isLoading ? (
              <p className="p-4 text-center text-sm text-foreground-muted">Loading…</p>
            ) : shown.length === 0 ? (
              <p className="p-4 text-center text-sm text-foreground-muted">Nothing waiting{needle || upTo ? " that matches" : ""}.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {shown.map((l) => (
                    <tr key={l.id} className="border-b border-border last:border-0">
                      <td className="w-8 px-3 py-2">
                        <Checkbox checked={picked.has(l.id)} onChange={() => setPicked((prev) => { const n = new Set(prev); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; })} />
                      </td>
                      <td className="px-2 py-2">
                        <p className="truncate">{l.description}</p>
                        <p className="text-xs text-foreground-muted">
                          {l.date}{l.invoice ? ` · ${l.invoice.number}` : ""} · expected {l.expectedOn}
                          {l.late && <Badge tone="danger" className="ml-1.5">late</Badge>}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <MoneyDisplay minor={l.amountMinor} currency={cur} className="font-medium" />
                        <span className="block text-xs text-foreground-muted">fee ≈ {formatMoney(l.expectedFeeMinor, cur)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>Date it arrived</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Arrived in {p.settlementAccountName} ({cur})</Label>
              <Input
                type="number" min={0} step="0.01"
                value={touched ? received : (Math.max(0, gross - expectedFee) / 100).toFixed(2)}
                onChange={(e) => { setTouched(true); setReceived(e.target.value); }}
              />
            </div>
            <div className="space-y-1">
              <Label>Reference (UTR)</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} placeholder="Settlement or transfer id" />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface-muted p-3 text-sm">
            <div className="flex justify-between"><span className="text-foreground-muted">{chosen.length} payments settled</span><MoneyDisplay minor={gross} currency={cur} className="font-medium" /></div>
            <div className="flex justify-between"><span className="text-foreground-muted">Arrives in {p.settlementAccountName}</span><MoneyDisplay minor={Math.max(0, receivedMinor)} currency={cur} className="font-medium text-success" /></div>
            <div className="flex justify-between border-t border-border pt-1 mt-1">
              <span className="text-foreground-muted">Fee booked (expected {formatMoney(expectedFee, cur)})</span>
              <MoneyDisplay minor={Math.max(0, fee)} currency={cur} className="font-semibold" />
            </div>
            {receivedMinor > gross && (
              <p className="mt-1 flex items-center gap-1 text-xs text-danger"><AlertTriangle className="h-3.5 w-3.5" /> More than the payments picked — pick the rest of what was settled.</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button loading={create.isPending} disabled={!ready} onClick={() => void save()}>Record settlement</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
