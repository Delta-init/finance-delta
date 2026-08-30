"use client";

import { useState } from "react";
import { Landmark, Pencil } from "lucide-react";
import type { BankAccount } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import { useUpdateBankAccount } from "@/features/banking/api";

/**
 * The details a client needs in order to pay this account.
 *
 * Editable from the account itself because the accounts that most need an IFSC
 * or an IBAN are the ones that already existed before there was anywhere to put
 * one — leaving these on the create form only would mean re-creating an account
 * to add a sort code to it.
 *
 * Which fields apply depends on where the account is held, so nothing here is
 * required and the invoice prints only what has been filled in.
 */
const FIELDS = [
  { key: "bankName", label: "Bank name", placeholder: "e.g. Federal Bank" },
  { key: "branch", label: "Branch", placeholder: "e.g. Kozhikode" },
  { key: "ifsc", label: "IFSC", placeholder: "Indian accounts" },
  { key: "swift", label: "SWIFT / BIC", placeholder: "International transfers" },
  { key: "iban", label: "IBAN", placeholder: "UAE and European accounts" },
] as const;

type Key = (typeof FIELDS)[number]["key"];

export function PaymentDetailsCard({ account }: { account: BankAccount }) {
  const update = useUpdateBankAccount(account.id);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<Key, string>>(() => read(account));

  const filled = FIELDS.filter((f) => (account[f.key] ?? "").trim().length > 0);

  async function save() {
    try {
      await update.mutateAsync(draft);
      toast.success("Payment details saved");
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save the payment details");
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Landmark className="h-4 w-4 text-foreground-muted" />
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
            Payment details
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { setDraft(read(account)); setOpen(true); }}
        >
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          {filled.length > 0 ? "Edit" : "Add"}
        </Button>
      </div>

      {filled.length === 0 ? (
        // Said plainly, because the consequence is invisible otherwise: the
        // invoice simply leaves the block out and nobody knows why.
        <p className="mt-2 text-sm text-foreground-muted">
          Nothing here yet, so invoices naming this account print no payment block.
        </p>
      ) : (
        <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          <Row label="Account name" value={account.accountName} />
          {account.accountNumber ? <Row label="Account number" value={account.accountNumber} mono /> : null}
          {filled.map((f) => (
            <Row key={f.key} label={f.label} value={account[f.key] as string} mono={f.key !== "bankName" && f.key !== "branch"} />
          ))}
        </dl>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Payment details</DialogTitle>
            <DialogDescription>
              These print on invoices that name this account. Fill in the ones that apply to
              where it is held and leave the rest blank.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={f.key}>{f.label}</Label>
                <Input
                  id={f.key}
                  value={draft[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button loading={update.isPending} onClick={save}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function read(account: BankAccount): Record<Key, string> {
  return {
    bankName: account.bankName ?? "",
    branch: account.branch ?? "",
    ifsc: account.ifsc ?? "",
    swift: account.swift ?? "",
    iban: account.iban ?? "",
  };
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-foreground-muted">{label}</dt>
      <dd className={`text-sm font-medium ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
