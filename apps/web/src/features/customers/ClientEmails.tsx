"use client";

import { useState } from "react";
import { BellOff, BellRing } from "lucide-react";
import type { Customer } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { useUpdateCustomer } from "./api";

/*
 * Whether finance emails a client (the user, 2026-11-16): on unless somebody turns it off. Off, none of the client's
 * emails go — invoices, tax invoices, receipts, reminders — and the email log says so; staff emails are not affected.
 * The server holds the rule (lib/email.ts); this is where it is seen and changed.
 */

const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

/** "No emails" beside a client's name, in lists. */
export function NoEmailsTag({ customer }: { customer: Pick<Customer, "receivesEmails"> }) {
  if (customer.receivesEmails !== false) return null;
  return <Badge tone="neutral" title="Emails turned off for this client"><BellOff className="h-3 w-3" /> No emails</Badge>;
}

/** The client page's line: on or off, who turned it off, and the switch for whoever may edit clients. */
export function ClientEmailsSwitch({ customer }: { customer: Customer }) {
  const { can } = useCan();
  const mayChange = can("customer:emails");
  const update = useUpdateCustomer();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const on = customer.receivesEmails !== false;

  const set = async (receivesEmails: boolean) => {
    try {
      await update.mutateAsync({ id: customer.id, input: { receivesEmails, ...(receivesEmails ? {} : { emailsOffReason: reason.trim() }) } });
      toast.success(receivesEmails ? "Emails turned back on — new ones will reach the client" : "Emails turned off — the client gets none until they are turned on");
      setAsking(false);
      setReason("");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not change it");
    }
  };

  return (
    <div className="flex items-start gap-2 text-sm">
      {on ? <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-foreground-muted" /> : <BellOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span>Emails to client</span>
          <Badge tone={on ? "success" : "warning"}>{on ? "On" : "Off"}</Badge>
          {mayChange && (
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={update.isPending}
              onClick={() => (on ? setAsking(true) : void set(true))}>
              {on ? "Turn off" : "Turn on"}
            </Button>
          )}
        </div>
        {!on && customer.emailsOff && (
          <p className="mt-0.5 text-xs text-foreground-muted">
            Turned off{customer.emailsOff.byName ? ` by ${customer.emailsOff.byName}` : ""}{customer.emailsOff.at ? ` · ${day(customer.emailsOff.at)}` : ""}
            {customer.emailsOff.reason ? ` — “${customer.emailsOff.reason}”` : ""}
          </p>
        )}
      </div>

      <Dialog open={asking} onOpenChange={(o) => { if (!update.isPending) setAsking(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop all emails to {customer.name}?</DialogTitle>
            <DialogDescription>
              Invoices, tax invoices, receipts and reminders will not be sent to {customer.email}. Staff still get theirs. Turn it back on any time — what was not sent meanwhile stays unsent (Resend sends an invoice again).
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (optional) — e.g. asked not to be emailed" />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAsking(false)} disabled={update.isPending}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={() => void set(false)} disabled={update.isPending}>
              {update.isPending ? "Turning off…" : "Turn off"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The tick box in the New / Edit client form — ticked unless emails are off. */
export function ReceivesEmailsField({ value, onChange }: { value: boolean | undefined; onChange: (v: boolean) => void }) {
  const { can } = useCan();
  const on = value !== false;
  // Only a Manager, Accountant or Administrator changes it (2026-11-16); others see nothing here.
  if (!can("customer:emails")) return null;
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <Checkbox checked={on} onChange={() => onChange(!on)} aria-label="Send emails to this client" />
      <span>Send emails to this client <span className="text-foreground-muted">(invoices, receipts, reminders)</span></span>
    </label>
  );
}
