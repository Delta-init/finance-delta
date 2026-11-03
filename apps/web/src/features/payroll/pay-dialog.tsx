"use client";

import { useEffect, useMemo, useState } from "react";
import { Banknote, AlertTriangle, PauseCircle, Plus, Search, X, CheckCircle2, XCircle } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { useBankAccounts } from "@/features/banking/api";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PayPayload } from "./api";
import type { RunLine } from "./types";

const today = () => new Date().toISOString().slice(0, 10);

/** A line's currency, or the run's for a line imported before lines carried one. */
const currencyOf = (l: RunLine, runCurrency: string) => (l.currency || runCurrency).trim().toUpperCase();
const owed = (l: RunLine) => l.payableMinor - l.amountPaidMinor;
/** A typed amount in minor units; NaN for anything that isn't one (more than two decimals, letters, nothing). */
const toMinor = (raw: string) => {
  const t = raw.replace(/,/g, "").trim();
  return t && /^\d*\.?\d{0,2}$/.test(t) ? Math.round(Number(t) * 100) : NaN;
};
const asTyped = (minor: number) => (minor / 100).toFixed(2).replace(/\.00$/, "");

const METHODS: Array<{ value: PayPayload["method"]; label: string }> = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
  { value: "card", label: "Card" },
  { value: "online", label: "Online" },
];
const methodLabel = (m: PayPayload["method"]) => METHODS.find((x) => x.value === m)?.label ?? m;

/** One payment of the several this dialog can record: its own method, account, day, reference and people. */
interface Draft {
  key: number;
  method: PayPayload["method"];
  bankAccountId: string;
  paidOn: string;
  reference: string;
  ids: string[];
  /** What was typed as a person's amount in this payment (2026-11-03). None: they take the rest of their pay here. */
  amounts: Record<string, string>;
  state: "draft" | "paying" | "done" | "failed";
  error?: string;
  /** What it came to when it was recorded — its people are paid since, and leave the list. */
  recordedMinor?: number;
  recordedCount?: number;
}

let nextKey = 1;
const draft = (ids: string[], method: PayPayload["method"] = "bank_transfer"): Draft => ({
  key: nextKey++, method, bankAccountId: "", paidOn: today(), reference: "", ids, amounts: {}, state: "draft",
});
const without = (d: Draft, ids: string[]): Draft => ({
  ...d,
  ids: d.ids.filter((x) => !ids.includes(x)),
  amounts: Object.fromEntries(Object.entries(d.amounts).filter(([id]) => !ids.includes(id))),
});

/** A person's pay across the payments still to record: what each pays them, what is wrong, what stays owed. */
interface Share {
  at: Map<number, number>;
  wrong: Map<number, string>;
  /** Typed amounts adding up to more than they are owed. */
  over: { typedMinor: number; owedMinor: number } | null;
  /** Left owed once these payments are recorded: they stay part paid. */
  leftMinor: number;
}

/**
 * Paying the run.
 *
 * The total is computed from the lines actually being paid rather than from the
 * run's headline figure, because held people are excluded and a part-paid
 * person only takes their remainder. Showing the run total here would promise a
 * transfer of a different size from the one about to happen.
 *
 * One currency at a time (2026-10-30). A bank account pays out in one currency,
 * and a month can hold salaries in dirhams and in rupees, so a payment covers
 * the people paid in the chosen currency, from an account in it.
 *
 * Several payments at once, each with its own people (the user, 2026-11-03: "multiple payment methods here and
 * specific users … with search"): most by bank transfer, a few in cash from petty cash, say. Each is recorded as its
 * own payment — its bank line, expense and HRMS payslips — one after the other. If one is refused the ones before it
 * stand, and it can be put right and tried again.
 *
 * One person paid in parts (the user, 2026-11-03: "some employees are paid by more than one payment method … how much
 * in each"): ticked in more than one payment, with an amount in each. The first payment they are in without a typed
 * amount pays the rest of what they are owed; typed amounts that leave some over leave them part paid, which is
 * allowed. Only when the API says it can (`parts`): one from before ignores amounts and pays everybody named in full.
 * Without it a person is in one payment at most, paid all they are still owed.
 */
export function PayDialog({
  open, onOpenChange, lines, selectedIds, runCurrency, parts = false, payOne, onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: RunLine[];
  /** Ticked on the run page: who the first payment starts with. Empty means everybody still owed. */
  selectedIds: string[];
  /** What a line without a currency of its own is paid in. */
  runCurrency: string;
  /** The API takes an amount per person, so a person can be paid in parts (the run's `payInParts`). */
  parts?: boolean;
  /** Records one payment; rejects with the API's reason. */
  payOne: (input: PayPayload) => Promise<unknown>;
  /** Every payment recorded. */
  onDone: () => void;
}) {
  const accounts = useBankAccounts({ page: 1, pageSize: 100 });
  const [chosen, setChosen] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [active, setActive] = useState(0);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  /** Somebody just ticked into a second payment: their amount box takes the cursor. */
  const [focus, setFocus] = useState("");

  /** The people in scope, per currency: the run's currency first, then by how many people. */
  const groups = useMemo(() => {
    const by = new Map<string, { currency: string; payable: RunLine[]; held: RunLine[] }>();
    for (const l of lines) {
      const currency = currencyOf(l, runCurrency);
      const g = by.get(currency) ?? { currency, payable: [], held: [] };
      if (l.status === "on_hold") g.held.push(l);
      else if (l.status !== "paid" && owed(l) > 0) g.payable.push(l);
      by.set(currency, g);
    }
    const lead = runCurrency.trim().toUpperCase();
    return [...by.values()]
      .filter((g) => g.payable.length > 0 || g.held.length > 0)
      .sort(
        (a, b) =>
          (a.currency === lead ? 0 : 1) - (b.currency === lead ? 0 : 1) ||
          b.payable.length - a.payable.length ||
          a.currency.localeCompare(b.currency),
      );
  }, [lines, runCurrency]);

  // Ticked on the run page: the first currency with any of them, else the first anybody can be paid in.
  const picked = new Set(selectedIds);
  const firstPayable =
    groups.find((g) => g.payable.some((l) => picked.has(l.id)))?.currency ??
    groups.find((g) => g.payable.length > 0)?.currency ?? groups[0]?.currency ?? "";
  const currency = groups.some((g) => g.currency === chosen) ? chosen : firstPayable;
  const group = groups.find((g) => g.currency === currency);
  const payable = useMemo(() => group?.payable ?? [], [group]);
  const held = group?.held ?? [];
  const lineOf = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);

  // A fresh start each time it opens or the currency changes: one payment, with whoever was ticked (or everybody).
  const seed = useMemo(() => {
    const ticked = payable.filter((l) => picked.has(l.id)).map((l) => l.id);
    return ticked.length ? ticked : payable.map((l) => l.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency, open]);
  useEffect(() => {
    if (!open) { setChosen(""); setDrafts([]); setQ(""); setActive(0); return; }
    setDrafts([draft(seed)]);
    setActive(0);
  }, [open, currency, seed]);

  const eligible = (accounts.data?.data ?? []).filter((a) => a.currency.trim().toUpperCase() === currency && a.isActive);
  /** The payments still to record that each person is in. */
  const where = new Map<string, number[]>();
  drafts.forEach((d, i) => { if (d.state !== "done") d.ids.forEach((id) => where.set(id, [...(where.get(id) ?? []), i])); });
  const payableIds = new Set(payable.map((l) => l.id));
  const peopleOf = (d: Draft) => d.ids.filter((id) => payableIds.has(id));

  // What each payment pays each person. A typed amount is that; the first payment somebody is in without one pays the
  // rest of what they are owed; a later one without one pays nothing until an amount is typed in it.
  const shares = new Map<string, Share>();
  for (const l of payable) {
    const ins = where.get(l.id);
    if (!ins) continue;
    const o = owed(l);
    const typed = new Map<number, number>();
    for (const i of ins) {
      const raw = drafts[i]!.amounts[l.id];
      if (raw !== undefined) typed.set(i, toMinor(raw));
    }
    const fine = (v: number) => Number.isFinite(v) && v > 0;
    const typedSum = [...typed.values()].reduce((a, v) => a + (fine(v) ? v : 0), 0);
    const restAt = ins.find((i) => !typed.has(i));
    const at = new Map<number, number>();
    const wrong = new Map<number, string>();
    for (const i of ins) {
      const t = typed.get(i);
      if (t !== undefined) {
        at.set(i, fine(t) ? t : 0);
        if (!fine(t)) wrong.set(i, "Type an amount above 0, at most two decimals");
      } else if (i === restAt) {
        at.set(i, Math.max(0, o - typedSum));
        if (o - typedSum <= 0) wrong.set(i, "Nothing of their pay is left for this payment — untick them here or lower the others");
      } else {
        at.set(i, 0);
        wrong.set(i, `Type how much this payment is — payment ${restAt! + 1} pays the rest`);
      }
    }
    const paid = [...at.values()].reduce((a, v) => a + v, 0);
    shares.set(l.id, {
      at,
      wrong,
      over: typedSum > o ? { typedMinor: typedSum, owedMinor: o } : null,
      leftMinor: Math.max(0, o - paid),
    });
  }
  const amountIn = (i: number, id: string) => shares.get(id)?.at.get(i) ?? 0;
  const wrongIn = (i: number) => peopleOf(drafts[i]!).some((id) => shares.get(id)?.wrong.has(i) || shares.get(id)?.over);
  const totalOf = (i: number) => peopleOf(drafts[i]!).reduce((a, id) => a + amountIn(i, id), 0);
  const open_ = drafts.filter((d) => d.state !== "done");
  const unassigned = payable.filter((l) => !where.has(l.id));
  const grand = drafts.reduce((a, d, i) => a + (d.state === "done" ? 0 : totalOf(i)), 0);
  const troubled = [...shares.values()].some((x) => x.over || x.wrong.size > 0);
  const partPaid = payable.filter((l) => (shares.get(l.id)?.leftMinor ?? 0) > 0);
  const ready = !busy && open_.length > 0 && !troubled
    && open_.every((d) => d.bankAccountId && d.paidOn && peopleOf(d).length > 0);

  const cur = drafts[active];
  const set = (i: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch, ...(d.state === "failed" ? { state: "draft" as const, error: undefined } : {}) } : d)));
  /** Into the payment shown, out of whichever it was in — or out of the payment shown. */
  const assign = (ids: string[], into: boolean) =>
    setDrafts((ds) => ds.map((d, j) => {
      if (d.state === "done") return d;
      if (j === active) return into ? { ...without(d, ids), ids: [...new Set([...d.ids, ...ids])] } : without(d, ids);
      return into ? without(d, ids) : d;
    }));
  /**
   * One person ticked or unticked in the payment shown. Paying in parts, ticking somebody already in another payment
   * puts them in this one too — for the amount typed here; the other keeps the rest.
   */
  const toggle = (id: string, into: boolean) => {
    if (!parts || !into || !where.has(id)) { assign([id], into); return; }
    setDrafts((ds) => ds.map((d, j) => (j === active && d.state !== "done" ? { ...d, ids: [...new Set([...d.ids, id])] } : d)));
    setFocus(id);
  };
  const type = (id: string, raw: string) =>
    setDrafts((ds) => ds.map((d, j) => (j === active ? { ...d, amounts: { ...d.amounts, [id]: raw } } : d)));

  const needle = q.trim().toLowerCase();
  const shown = [...payable, ...held].filter((l) =>
    !needle || [l.name, l.employeeCode, l.departmentName, l.designation].some((x) => (x ?? "").toLowerCase().includes(needle)));
  // Everybody the search shows who can be paid — "Select all" brings them into the payment shown, from any other.
  const shownFree = shown.filter((l) => l.status !== "on_hold");
  const allShownHere = shownFree.length > 0 && shownFree.every((l) => where.get(l.id)?.includes(active));

  async function record() {
    setBusy(true);
    // Fixed before the first is sent: once one is recorded the run reloads, and what people are owed shrinks under it.
    const plan = drafts.map((d, i) => peopleOf(d).map((id) => ({ lineId: id, amountMinor: amountIn(i, id) })));
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]!;
      if (d.state === "done") continue;
      const people = plan[i]!;
      const amount = people.reduce((a, x) => a + x.amountMinor, 0);
      setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, state: "paying", error: undefined } : x)));
      try {
        await payOne({
          ...(parts ? { amounts: people } : { lineIds: people.map((x) => x.lineId) }),
          bankAccountId: d.bankAccountId, method: d.method, paidOn: d.paidOn, reference: d.reference.trim() || undefined,
        });
        setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, state: "done", recordedMinor: amount, recordedCount: people.length } : x)));
      } catch (e) {
        const error = e instanceof ApiError || e instanceof Error ? e.message : "Could not record this payment";
        setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, state: "failed", error } : x)));
        setActive(i);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    onDone();
  }

  const anyDone = drafts.some((d) => d.state === "done");

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Pay {payable.length - unassigned.length} of {payable.length} {payable.length === 1 ? "person" : "people"}{currency ? ` in ${currency}` : ""}
          </DialogTitle>
          <DialogDescription>
            This records each transfer against a bank account and tells HRMS, which marks the payslips paid. It does
            not move money by itself — make the transfers first. Split it into several payments to pay some people
            another way (cash from petty cash, a cheque){parts ? " — or one person part by each, with an amount in each" : ""}.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          {groups.length > 1 && (
            <div className="space-y-1.5">
              <Label>Paying the people paid in</Label>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Currency">
                {groups.map((g) => (
                  <button
                    key={g.currency}
                    type="button"
                    role="radio"
                    aria-checked={g.currency === currency}
                    disabled={busy || anyDone}
                    onClick={() => setChosen(g.currency)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left text-sm disabled:opacity-60",
                      g.currency === currency ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                    )}
                  >
                    <span className="font-mono font-semibold">{g.currency}</span>
                    <span className="block text-xs text-foreground-muted">
                      {g.payable.length} {g.payable.length === 1 ? "person" : "people"} to pay
                      {g.held.length > 0 ? ` · ${g.held.length} held` : ""}
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-foreground-muted">
                A bank account pays out in one currency, so each currency is paid on its own. The others stay
                outstanding until they are paid.
              </p>
            </div>
          )}

          {/* The payments, one tab each. */}
          <div className="flex flex-wrap items-center gap-2">
            {drafts.map((d, i) => (
              <button
                key={d.key}
                type="button"
                onClick={() => setActive(i)}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-left text-xs",
                  i === active ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                  (d.state === "failed" || (d.state !== "done" && wrongIn(i))) && "border-danger",
                )}
              >
                <span className="flex items-center gap-1 font-semibold">
                  {d.state === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
                  {d.state === "failed" && <XCircle className="h-3.5 w-3.5 text-danger" />}
                  Payment {i + 1} · {methodLabel(d.method)}
                </span>
                <span className="text-foreground-muted">
                  {d.state === "done"
                    ? <>Recorded · {d.recordedCount} · <MoneyDisplay minor={d.recordedMinor ?? 0} currency={currency} /></>
                    : <>{peopleOf(d).length} {peopleOf(d).length === 1 ? "person" : "people"} · <MoneyDisplay minor={totalOf(i)} currency={currency} /></>}
                </span>
              </button>
            ))}
            {!busy && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => { setDrafts((ds) => [...ds, draft([], "cash")]); setActive(drafts.length); }}
              >
                <Plus className="h-3.5 w-3.5" /> Add another payment
              </Button>
            )}
          </div>

          {cur && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              {cur.state === "done" ? (
                <p className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle2 className="h-4 w-4" /> Recorded — {cur.recordedCount} paid by {methodLabel(cur.method).toLowerCase()}.
                </p>
              ) : (
                <>
                  {cur.error && (
                    <p className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-2 text-xs text-danger">
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Not recorded: {cur.error}
                    </p>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Method</Label>
                      <Select value={cur.method} onValueChange={(v) => set(active, { method: v as PayPayload["method"] })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Paid from</Label>
                      <Select value={cur.bankAccountId} onValueChange={(v) => set(active, { bankAccountId: v })}>
                        <SelectTrigger>
                          <SelectValue placeholder={eligible.length ? "Pick an account" : `No active ${currency} account`} />
                        </SelectTrigger>
                        <SelectContent>
                          {eligible.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.accountName} · <MoneyDisplay minor={a.currentBalanceMinor} currency={a.currency} />
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`paid-on-${cur.key}`}>Paid on</Label>
                      <Input id={`paid-on-${cur.key}`} type="date" value={cur.paidOn} onChange={(e) => set(active, { paidOn: e.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`pay-ref-${cur.key}`}>Reference (optional)</Label>
                      <Input
                        id={`pay-ref-${cur.key}`}
                        value={cur.reference}
                        onChange={(e) => set(active, { reference: e.target.value })}
                        placeholder={cur.method === "bank_transfer" ? "WPS batch or transfer id" : "Voucher or cheque number"}
                        maxLength={120}
                      />
                    </div>
                  </div>
                  {accounts.data && eligible.length === 0 && (
                    <p className="text-xs text-danger">
                      There is no active {currency} account. Add one under Banking to pay the people paid in {currency}.
                    </p>
                  )}
                  {drafts.length > 1 && !busy && (
                    <button
                      type="button"
                      className="text-xs text-foreground-muted hover:text-danger"
                      onClick={() => { setDrafts((ds) => ds.filter((_, j) => j !== active)); setActive(0); }}
                    >
                      Remove payment {active + 1} — its people come out of it
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* Who goes in the payment shown. */}
          {cur && cur.state !== "done" && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[200px] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code or department…" className="pl-8" />
                  {q && (
                    <button type="button" aria-label="Clear search" onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-subtle">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <Button type="button" variant="ghost" size="sm" disabled={busy || shownFree.length === 0} onClick={() => assign(shownFree.map((l) => l.id), !allShownHere)}>
                  {allShownHere ? "Clear" : "Select all"}{needle ? " shown" : ""}
                </Button>
              </div>
              <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {shown.length === 0 && <p className="p-3 text-sm text-foreground-muted">Nobody matches.</p>}
                {shown.map((l) => {
                  const isHeld = l.status === "on_hold";
                  const ins = where.get(l.id) ?? [];
                  const here = ins.includes(active);
                  const others = ins.filter((i) => i !== active);
                  const share = shares.get(l.id);
                  const raw = cur.amounts[l.id];
                  const amountHere = amountIn(active, l.id);
                  const wrongHere = share?.wrong.get(active);
                  return (
                    <div key={l.id} className={cn("px-3 py-2 text-sm", isHeld && "opacity-60")}>
                      <div className="flex items-center gap-3">
                        <Checkbox
                          checked={here}
                          aria-label={`Pay ${l.name} in payment ${active + 1}`}
                          onChange={() => { if (!isHeld && !busy) toggle(l.id, !here); }}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{l.name}</p>
                          <p className="truncate text-xs text-foreground-muted">
                            {[l.employeeCode, l.departmentName].filter(Boolean).join(" · ")}
                            {isHeld ? ` · held — ${l.holdReason || "no bank details"}` : !l.bank?.iban && !l.bank?.accountNumber ? " · no bank details" : ""}
                          </p>
                        </div>
                        {!isHeld && others.length > 0 && (
                          <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-xs text-foreground-muted">
                            {here ? "also " : ""}in payment {others.map((i) => i + 1).join(", ")}
                            {parts && <> · <MoneyDisplay minor={others.reduce((a, i) => a + amountIn(i, l.id), 0)} currency={currency} /></>}
                          </span>
                        )}
                        {parts && here ? (
                          <div className="flex shrink-0 flex-col items-end">
                            <Input
                              inputMode="decimal"
                              aria-label={`${l.name}'s amount in payment ${active + 1}`}
                              autoFocus={focus === l.id}
                              disabled={busy}
                              value={raw ?? (amountHere > 0 ? asTyped(amountHere) : "")}
                              placeholder="Amount"
                              onChange={(e) => type(l.id, e.target.value)}
                              className={cn("h-8 w-32 text-right font-numeric", (wrongHere || share?.over) && "border-danger")}
                            />
                            <span className="mt-0.5 text-[11px] text-foreground-muted">
                              of <MoneyDisplay minor={owed(l)} currency={currency} />
                            </span>
                          </div>
                        ) : (
                          <MoneyDisplay minor={owed(l)} currency={currency} className="shrink-0 font-medium" />
                        )}
                      </div>
                      {parts && here && (wrongHere || share?.over || (share?.leftMinor ?? 0) > 0) && (
                        <p className={cn("mt-1 pl-7 text-xs", wrongHere || share?.over ? "text-danger" : "text-warning")}>
                          {share?.over
                            ? <>The amounts add up to <MoneyDisplay minor={share.over.typedMinor} currency={currency} /> — they are owed <MoneyDisplay minor={share.over.owedMinor} currency={currency} />.</>
                            : wrongHere
                              ? wrongHere
                              : <><MoneyDisplay minor={share!.leftMinor} currency={currency} /> stays owed — they will be part paid.</>}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {held.length > 0 && (
            <p className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 p-2.5 text-xs">
              <PauseCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                {held.length} {held.length === 1 ? "person is" : "people are"} held and will not be paid or marked
                paid. They stay outstanding on this run.
              </span>
            </p>
          )}

          <div className="rounded-lg border border-border bg-surface-muted p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-foreground-muted">
                Total to transfer{open_.length > 1 ? ` · ${open_.length} payments` : ""}
              </span>
              <span className="text-right text-lg font-semibold">
                <MoneyDisplay minor={grand} currency={currency || runCurrency} showConverted />
              </span>
            </div>
            {unassigned.length > 0 && (
              <p className="mt-1 text-xs text-foreground-muted">
                {unassigned.length} {unassigned.length === 1 ? "person is" : "people are"} in no payment and stay
                outstanding ({<MoneyDisplay minor={unassigned.reduce((a, l) => a + owed(l), 0)} currency={currency} />}).
              </p>
            )}
            {partPaid.length > 0 && (
              <p className="mt-1 text-xs text-warning">
                Part paid: {partPaid.slice(0, 3).map((l) => l.name).join(", ")}
                {partPaid.length > 3 ? ` and ${partPaid.length - 3} more` : ""} — the rest
                ({<MoneyDisplay minor={partPaid.reduce((a, l) => a + (shares.get(l.id)?.leftMinor ?? 0), 0)} currency={currency} />})
                stays owed on this run.
              </p>
            )}
            {troubled && (
              <p className="mt-1 text-xs text-danger">An amount needs putting right before this can be recorded — see the payments and people marked in red.</p>
            )}
          </div>

          <p className="flex items-start gap-2 text-xs text-foreground-muted">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Recording a payment cannot be undone from this screen. If a transfer bounces, reverse it
            so the payslips go back to issued.
          </p>
        </div>

        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>{anyDone ? "Close" : "Cancel"}</Button>
          <Button loading={busy} disabled={!ready} onClick={() => void record()}>
            <Banknote className="h-4 w-4" />
            {open_.length > 1 ? `Record ${open_.length} payments` : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
