"use client";

import { useState } from "react";
import Link from "next/link";
import { Clock, Check, X, Loader2, ShieldAlert, ExternalLink } from "lucide-react";
import { LATE_ENTRY_KIND_LABELS, type LateEntry } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useDecideLateEntry, useLateEntries, useLateEntriesMe } from "@/features/late-entries/api";

/**
 * Late entries (the user, 2026-10-17): expenses, bills and payments typed in with a date more than the organization's
 * days back, each with the reason it was late — for somebody tagged Manager (or a super admin) to approve, or reject
 * with a reason. Nobody decides their own.
 */
export default function LateEntriesPage() {
  const { data: me, isLoading: meLoading } = useLateEntriesMe();
  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const { data, isLoading } = useLateEntries(tab, !!me?.isManager);
  const rows = data ?? [];

  if (meLoading) return <Card className="m-4 flex justify-center py-16 md:m-6"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>;
  if (!me?.isManager) {
    return (
      <div className="p-4 md:p-6">
        <Card className="px-5 py-16 text-center text-sm text-foreground-muted">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 opacity-40" />
          Only people tagged Manager decide late entries.
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        icon={Clock}
        title="Late entries"
        description={`Expenses, bills and payments dated more than ${me.days} day${me.days === 1 ? "" : "s"} back. Approve them, or reject them with a reason: a new one rejected is rejected, voided or removed; one whose date was moved back gets its date back.`}
        action={me.pending > 0 ? <Badge tone="warning">{me.pending} waiting</Badge> : undefined}
      />
      <div className="flex gap-1 rounded-lg border border-border bg-surface p-1 text-sm w-fit">
        {(["pending", "decided"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 font-medium ${tab === t ? "bg-primary text-primary-foreground" : "text-foreground-muted hover:bg-surface-muted"}`}
          >
            {t === "pending" ? "Waiting" : "Decided"}
          </button>
        ))}
      </div>
      {isLoading ? (
        <Card className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>
      ) : !rows.length ? (
        <Card className="px-5 py-16 text-center text-sm text-foreground-muted">
          <Clock className="mx-auto mb-3 h-8 w-8 opacity-40" />
          {tab === "pending" ? "Nothing entered late is waiting." : "Nothing decided yet."}
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((e) => <EntryCard key={e.id} entry={e} />)}
        </div>
      )}
    </div>
  );
}

const STATE_TONE = { pending: "warning", approved: "success", rejected: "danger", withdrawn: "neutral" } as const;
const STATE_LABEL = { pending: "Waiting", approved: "Approved", rejected: "Rejected", withdrawn: "No longer asked" } as const;

function EntryCard({ entry: e }: { entry: LateEntry }) {
  const decide = useDecideLateEntry();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  async function act(decision: "approve" | "reject") {
    if (decision === "reject" && !note.trim()) {
      toast.error("Say why it is rejected");
      return;
    }
    try {
      await decide.mutateAsync({ id: e.id, decision, note: note.trim() });
      toast.success(decision === "approve" ? `${e.number} approved` : `${e.number} rejected`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save the decision");
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="primary">{LATE_ENTRY_KIND_LABELS[e.kind]}</Badge>
            <Link href={e.href} className="inline-flex items-center gap-1 font-semibold hover:underline">
              {e.number} <ExternalLink className="h-3 w-3 text-foreground-subtle" />
            </Link>
            {e.state !== "pending" && <Badge tone={STATE_TONE[e.state]}>{STATE_LABEL[e.state]}</Badge>}
          </div>
          {e.title && <p className="mt-0.5 truncate text-sm text-foreground-muted">{e.title}</p>}
        </div>
        <MoneyDisplay minor={e.amountMinor} currency={e.currency} className="text-base font-semibold" />
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="inline text-foreground-muted">Dated </dt><dd className="inline font-medium">{e.date}</dd>
          {e.previousDate && <span className="text-foreground-muted"> (moved back from {e.previousDate})</span>}</div>
        <div><dt className="inline text-foreground-muted">Entered by </dt><dd className="inline">{e.enteredByName || "—"}, {new Date(e.enteredAt).toLocaleDateString()}</dd></div>
        <div className="sm:col-span-2"><dt className="inline text-foreground-muted">Why late: </dt><dd className="inline">{e.reason}</dd></div>
        {e.decidedByName && (
          <div className="sm:col-span-2">
            <dt className="inline text-foreground-muted">{e.state === "rejected" ? "Rejected" : "Approved"} by </dt>
            <dd className="inline">{e.decidedByName}{e.decidedAt ? `, ${new Date(e.decidedAt).toLocaleDateString()}` : ""}{e.decisionNote ? ` — ${e.decisionNote}` : ""}</dd>
          </div>
        )}
      </dl>
      {e.state === "pending" && (
        e.canDecide ? (
          <div className="space-y-2">
            {rejecting && (
              <textarea
                value={note}
                onChange={(ev) => setNote(ev.target.value)}
                maxLength={500}
                rows={2}
                autoFocus
                placeholder="Why it is rejected — the person who entered it is told"
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              />
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {rejecting ? (
                <>
                  <Button variant="secondary" size="sm" onClick={() => { setRejecting(false); setNote(""); }}>Cancel</Button>
                  <Button variant="destructive" size="sm" loading={decide.isPending} onClick={() => act("reject")}><X className="h-4 w-4" /> Reject</Button>
                </>
              ) : (
                <>
                  <Button variant="secondary" size="sm" onClick={() => setRejecting(true)}><X className="h-4 w-4" /> Reject…</Button>
                  <Button size="sm" loading={decide.isPending} onClick={() => act("approve")}><Check className="h-4 w-4" /> Approve</Button>
                </>
              )}
            </div>
          </div>
        ) : (
          <p className="text-right text-xs text-foreground-muted">You entered this — another manager decides it.</p>
        )
      )}
    </Card>
  );
}
