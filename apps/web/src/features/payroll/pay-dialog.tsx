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
  state: "draft" | "paying" | "done" | "failed";
  error?: string;
  /** What it came to when it was recorded — its people are paid since, and leave the list. */
  recordedMinor?: number;
  recordedCount?: number;
}

let nextKey = 1;
const draft = (ids: string[], method: PayPayload["method"] = "bank_transfer"): Draft => ({
  key: nextKey++, method, bankAccountId: "", paidOn: today(), reference: "", ids, state: "draft",
});

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
 * own payment — its bank line, expense and HRMS payslips — one after the other; a person is in one of them at most,
 * paid what they are still owed. If one is refused the ones before it stand, and it can be put right and tried again.
 */
export function PayDialog({
  open, onOpenChange, lines, selectedIds, runCurrency, payOne, onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: RunLine[];
  /** Ticked on the run page: who the first payment starts with. Empty means everybody still owed. */
  selectedIds: string[];
  /** What a line without a currency of its own is paid in. */
  runCurrency: string;
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
  const owner = new Map<string, number>();
  drafts.forEach((d, i) => { if (d.state !== "done") d.ids.forEach((id) => owner.set(id, i)); });
  const payableIds = new Set(payable.map((l) => l.id));
  const peopleOf = (d: Draft) => d.ids.filter((id) => payableIds.has(id));
  const totalOf = (d: Draft) => peopleOf(d).reduce((a, id) => a + owed(lineOf.get(id)!), 0);
  const open_ = drafts.filter((d) => d.state !== "done");
  const unassigned = payable.filter((l) => !owner.has(l.id));
  const grand = open_.reduce((a, d) => a + totalOf(d), 0);
  const ready = !busy && open_.length > 0
    && open_.every((d) => d.bankAccountId && d.paidOn && peopleOf(d).length > 0);

  const cur = drafts[active];
  const set = (i: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch, ...(d.state === "failed" ? { state: "draft" as const, error: undefined } : {}) } : d)));
  /** Into the payment shown, out of whichever it was in. */
  const assign = (ids: string[], into: boolean) =>
    setDrafts((ds) => ds.map((d, j) => {
      if (d.state === "done") return d;
      if (j === active) return { ...d, ids: into ? [...new Set([...d.ids, ...ids])] : d.ids.filter((x) => !ids.includes(x)) };
      return into ? { ...d, ids: d.ids.filter((x) => !ids.includes(x)) } : d;
    }));

  const needle = q.trim().toLowerCase();
  const shown = [...payable, ...held].filter((l) =>
    !needle || [l.name, l.employeeCode, l.departmentName, l.designation].some((x) => (x ?? "").toLowerCase().includes(needle)));
  // Everybody the search shows who can be paid — "Select all" brings them into the payment shown, from any other.
  const shownFree = shown.filter((l) => l.status !== "on_hold");
  const allShownHere = shownFree.length > 0 && shownFree.every((l) => owner.get(l.id) === active);

  async function record() {
    setBusy(true);
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]!;
      if (d.state === "done") continue;
      const ids = peopleOf(d);
      const amount = totalOf(d);
      setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, state: "paying", error: undefined } : x)));
      try {
        await payOne({ lineIds: ids, bankAccountId: d.bankAccountId, method: d.method, paidOn: d.paidOn, reference: d.reference.trim() || undefined });
        setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, state: "done", recordedMinor: amount, recordedCount: ids.length } : x)));
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
            another way (cash from petty cash, a cheque).
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
                  d.state === "failed" && "border-danger",
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
                    : <>{peopleOf(d).length} {peopleOf(d).length === 1 ? "person" : "people"} · <MoneyDisplay minor={totalOf(d)} currency={currency} /></>}
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
                      Remove payment {active + 1} — its people go back to nobody's
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
                  const where = owner.get(l.id);
                  const here = where === active;
                  return (
                    <div key={l.id} className={cn("flex items-center gap-3 px-3 py-2 text-sm", isHeld && "opacity-60")}>
                      <Checkbox
                        checked={here}
                        aria-label={`Pay ${l.name} in payment ${active + 1}`}
                        onChange={() => { if (!isHeld && !busy) assign([l.id], !here); }}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{l.name}</p>
                        <p className="truncate text-xs text-foreground-muted">
                          {[l.employeeCode, l.departmentName].filter(Boolean).join(" · ")}
                          {isHeld ? ` · held — ${l.holdReason || "no bank details"}` : !l.bank?.iban && !l.bank?.accountNumber ? " · no bank details" : ""}
                        </p>
                      </div>
                      {!isHeld && where !== undefined && !here && (
                        <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-xs text-foreground-muted">
                          in payment {where + 1}
                        </span>
                      )}
                      <MoneyDisplay minor={owed(l)} currency={currency} className="shrink-0 font-medium" />
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
