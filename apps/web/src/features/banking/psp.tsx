"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  formatMoney, pspChargesVatMinor,
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
import { DateField } from "@/components/ui/date-field";
import { todayDubai } from "@/lib/dates";

/*
 * PSP accounts (the user, 2026-11-06): Tabby, Tamara, Billexpro, Easebuzz, a card acquirer. Clients' payments land in
 * one whole; when the provider pays them on to a bank, less its charges, that is a settlement — recorded here. The
 * account's settings say where it settles and the VAT rate on its charges. What it charges is not a setting (the user,
 * 2026-11-14: "each settlement has its own charges… remove that from the settings"): every settlement's charges are
 * typed when it is recorded — or what arrived is, and the charges are the rest — and booked as an expense in Bank Fees
 * & Charges › Payment Gateway Fees. Nothing is guessed from a rate. API: modules/psp-settlement.
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

export type PspDraft = { provider: string; feeVatPct: string; settlementAccountId: string; settlementDays: string; startDate: string };

export function draftOf(p: BankAccount["psp"] | null | undefined): PspDraft {
  return {
    provider: p?.provider ?? "",
    feeVatPct: p ? String(p.feeVatPct) : "5", settlementAccountId: p?.settlementAccountId ?? "", settlementDays: p ? String(p.settlementDays) : "7",
    startDate: p?.startDate ?? todayDubai(),
  };
}
const num = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? 0 : Number(v));
export function settingsOf(d: PspDraft): PspSettings {
  return {
    provider: d.provider.trim(), feeVatPct: num(d.feeVatPct),
    settlementAccountId: d.settlementAccountId, settlementDays: Math.round(num(d.settlementDays)), startDate: d.startDate || undefined,
  };
}

/** Where a PSP settles and the VAT on its charges — in the new-account form and the settings dialog. */
export function PspSettingsFields({ value, onChange, currency, selfId }: {
  value: PspDraft; onChange: (v: PspDraft) => void; currency: string; selfId?: string;
}) {
  const { data } = useBankAccounts({ page: 1, pageSize: 100, isActive: "true" });
  const banks = (data?.data ?? []).filter((a) => a.id !== selfId && a.accountType !== "psp" && a.currency === currency);
  const set = (k: keyof PspDraft) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
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
          <Label>VAT on its charges (%)</Label>
          <Input type="number" min={0} max={100} step="0.01" value={value.feeVatPct} onChange={set("feeVatPct")} />
        </div>
        <div className="space-y-1">
          <Label>Settles after (days)</Label>
          <Input type="number" min={0} max={120} value={value.settlementDays} onChange={set("settlementDays")} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label>Settlements start on</Label>
          <DateField value={value.startDate} onChange={(v) => set("startDate")({ target: { value: v } })} className="max-w-[12rem]" aria-label="Start date" />
          <p className="text-xs text-foreground-muted">Money that came in before this day counts as settled already.</p>
        </div>
      </div>
      <p className="rounded-md bg-surface-muted px-3 py-2 text-xs text-foreground-muted">
        What it charges is not set here: each settlement has its own charges, typed when the settlement is recorded. The VAT rate
        above only splits those charges into net and VAT in the expense.
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
            Payments land here whole. When the provider pays them on to your bank, record the settlement with its own
            charges — what arrived moves to the bank and the charges are booked as an expense.
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
            {"Settles into "}<b>{p.settlementAccountName || "—"}</b>{` after ${p.settlementDays} days · from ${p.startDate}`}
            {" · charges typed with each settlement"}{p.feeVatPct > 0 ? ` (VAT ${p.feeVatPct}% in them)` : ""}
          </p>
        </div>
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> Settings</Button>
            <Button size="sm" onClick={() => setSettling(true)} disabled={!s?.unsettledCount}><Plus className="h-4 w-4" /> Record settlement</Button>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md bg-surface-muted p-3">
          <p className="text-xs text-foreground-muted">Waiting to be settled</p>
          <MoneyDisplay minor={s?.unsettledMinor ?? 0} currency={cur} className="text-lg font-semibold" />
          <p className="text-xs text-foreground-muted">{s?.unsettledCount ?? 0} payments · before its charges</p>
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
                  <th className="px-3 py-2 text-right font-medium">Charges</th>
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
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canWrite && (
                        <button
                          type="button"
                          className="text-foreground-muted hover:text-danger"
                          title="Take this settlement back"
                          onClick={async () => {
                            if (!confirm(`Take ${x.number} back? Its transfer to ${x.bankAccountName} and its charges expense are removed, and its payments wait to be settled again.`)) return;
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
  const [date, setDate] = useState(todayDubai());
  // This settlement's own charges (2026-11-14): typed, or what arrived is and the charges are the rest. Whichever box
  // was typed in last is the one kept; the other follows it, also when other payments are picked. Nothing is guessed.
  const [typed, setTyped] = useState<{ box: "charges" | "received"; text: string } | null>(null);
  const [reference, setReference] = useState("");

  const all = lines ?? [];
  const needle = q.trim().toLowerCase();
  const shown = all.filter((l) => (!needle || [l.description, l.reference, l.invoice?.number ?? ""].some((x) => x.toLowerCase().includes(needle))) && (!upTo || l.date <= upTo));
  const chosen = useMemo(() => all.filter((l) => picked.has(l.id)), [all, picked]);
  const gross = chosen.reduce((a, l) => a + l.amountMinor, 0);
  const typedMinor = typed && typed.text.trim() !== "" && Number.isFinite(Number(typed.text)) && Number(typed.text) >= 0 ? Math.round(Number(typed.text) * 100) : null;
  const fee = typedMinor === null ? null : typed!.box === "charges" ? typedMinor : gross - typedMinor;
  const receivedMinor = fee === null ? null : gross - fee;
  const boxText = (box: "charges" | "received", minor: number | null) => (typed?.box === box ? typed.text : minor === null || chosen.length === 0 ? "" : (minor / 100).toFixed(2));
  const problem = chosen.length === 0 || fee === null || receivedMinor === null ? ""
    : fee < 0 ? "More arrived than the payments picked come to. Pick the rest of what was settled."
    : receivedMinor <= 0 ? "The charges can't take all of what was settled." : "";
  const vatInFee = fee !== null && fee > 0 ? pspChargesVatMinor(fee, p.feeVatPct) : 0;
  const allShown = shown.length > 0 && shown.every((l) => picked.has(l.id));
  const ready = chosen.length > 0 && fee !== null && receivedMinor !== null && fee >= 0 && receivedMinor > 0 && !!date;

  async function save() {
    if (fee === null || receivedMinor === null) return;
    try {
      const s = await create.mutateAsync({ lineIds: chosen.map((l) => l.id), date, receivedMinor, feeMinor: fee, reference: reference.trim(), notes: "" });
      toast.success(`${s.number} recorded — ${formatMoney(s.receivedMinor, cur)} to ${s.bankAccountName}${s.feeMinor ? `, charges ${formatMoney(s.feeMinor, cur)}` : ", no charges"}`);
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
            Pick the payments it paid on to {p.settlementAccountName}, and type this settlement&apos;s charges — or what arrived. What
            arrived moves to {p.settlementAccountName}; the charges are booked as an expense.
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
              <DateField value={upTo} onChange={setUpTo} className="w-[10rem]" aria-label="Up to" />
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <Label>Date it arrived</Label>
              <DateField value={date} onChange={setDate} aria-label="Date" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="psp-charges">Charges on this settlement ({cur})</Label>
              <Input
                id="psp-charges" type="number" min={0} step="0.01" inputMode="decimal" placeholder="What it kept"
                value={boxText("charges", fee)}
                onChange={(e) => setTyped({ box: "charges", text: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="psp-received">Arrived in {p.settlementAccountName} ({cur})</Label>
              <Input
                id="psp-received" type="number" min={0} step="0.01" inputMode="decimal" placeholder="What reached the bank"
                value={boxText("received", receivedMinor)}
                onChange={(e) => setTyped({ box: "received", text: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Reference (UTR)</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} placeholder="Settlement or transfer id" />
            </div>
          </div>
          <p className="text-xs text-foreground-muted">
            Type the charges or what arrived, from the provider&apos;s settlement statement — the other fills itself. Nothing is worked out from a rate.
          </p>

          <div className="rounded-lg border border-border bg-surface-muted p-3 text-sm">
            <div className="flex justify-between"><span className="text-foreground-muted">{chosen.length} payments settled</span><MoneyDisplay minor={gross} currency={cur} className="font-medium" /></div>
            {fee === null || receivedMinor === null || chosen.length === 0 ? (
              <p className="mt-1 text-xs text-foreground-muted">
                {chosen.length === 0 ? "Pick the payments this settlement covers." : "Type this settlement's charges, or what arrived, to record it."}
              </p>
            ) : (
              <>
                <div className="flex justify-between">
                  <span className="text-foreground-muted">
                    Charges booked as an expense{vatInFee > 0 ? ` (of which VAT ${formatMoney(vatInFee, cur)} at ${p.feeVatPct}%)` : ""}
                  </span>
                  <MoneyDisplay minor={Math.max(0, fee)} currency={cur} className="font-medium" />
                </div>
                <div className="flex justify-between border-t border-border pt-1 mt-1">
                  <span className="text-foreground-muted">Arrives in {p.settlementAccountName}</span>
                  <MoneyDisplay minor={Math.max(0, receivedMinor)} currency={cur} className="font-semibold text-success" />
                </div>
                {problem && <p className="mt-1 flex items-center gap-1 text-xs text-danger"><AlertTriangle className="h-3.5 w-3.5" /> {problem}</p>}
              </>
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
