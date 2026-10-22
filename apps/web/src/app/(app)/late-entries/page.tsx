"use client";

import { useState } from "react";
import { useUrlParam } from "@/lib/url-state";
import Link from "next/link";
import { Clock, Check, X, Loader2, ShieldAlert, ExternalLink, Copy } from "lucide-react";
import { LATE_ENTRY_KIND_LABELS, type LateEntry } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { canViewLate, useDecideLateEntry, useLateEntries, useLateEntriesMe, useOldDateEntries, type OldDateRow } from "@/features/late-entries/api";
import { useSwitchOrganization } from "@/features/organization/switch";

/**
 * Late entries (the user, 2026-10-17): expenses, bills and payments typed in with a date more than the organization's
 * days back, each with the reason it was late — for somebody tagged Manager (or a super admin) to approve, or reject
 * with a reason. Nobody decides their own. Managers only again since 2026-10-22 (from 2026-10-20 whoever saw expenses
 * or bills read them too); everybody else sees the late entry on the record itself.
 */
export default function LateEntriesPage() {
  const { data: me, isLoading: meLoading } = useLateEntriesMe();
  // The tab in the address bar (2026-10-22).
  const [tab, setTab] = useUrlParam<"pending" | "decided" | "all" | "old">("tab", "pending", { allowed: ["pending", "decided", "all", "old"] });
  const canView = canViewLate(me);
  const { data, isLoading } = useLateEntries(tab === "old" ? "pending" : tab, canView && tab !== "old");
  const rows = data ?? [];

  if (meLoading) return <Card className="m-4 flex justify-center py-16 md:m-6"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>;
  if (!me || !canView) {
    return (
      <div className="p-4 md:p-6">
        <Card className="px-5 py-16 text-center text-sm text-foreground-muted">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 opacity-40" />
          Late entries are for managers — people tagged Manager, or a super admin.
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        icon={Clock}
        title="Late entries"
        description={`Expenses, bills, payments and bank / cash lines dated ${me.days === 1 ? "before the day they were typed in" : `${me.days} or more days back`}. Approve them, or reject them with a reason: a new one rejected is rejected, voided or removed; one whose date was moved back gets its date back. A rejected one is not asked again.`}
        action={me.pending > 0 ? <Badge tone="warning">{me.pending} waiting</Badge> : undefined}
      />
      <div className="flex gap-1 rounded-lg border border-border bg-surface p-1 text-sm w-fit">
        {(["pending", "decided", "all", "old"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 font-medium ${tab === t ? "bg-primary text-primary-foreground" : "text-foreground-muted hover:bg-surface-muted"}`}
          >
            {t === "pending" ? "Waiting" : t === "decided" ? "Decided" : t === "all" ? "All" : "Old dates"}
          </button>
        ))}
      </div>
      {tab === "old" ? (
        <OldDatesList days={me.days} />
      ) : isLoading ? (
        <Card className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>
      ) : !rows.length ? (
        <Card className="px-5 py-16 text-center text-sm text-foreground-muted">
          <Clock className="mx-auto mb-3 h-8 w-8 opacity-40" />
          {tab === "pending" ? "Nothing entered late is waiting." : tab === "decided" ? "Nothing decided yet." : "Nothing has been entered late."}
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((e) => <EntryCard key={e.id} entry={e} isManager={me.isManager} />)}
        </div>
      )}
    </div>
  );
}

const STATE_TONE = { pending: "warning", approved: "success", rejected: "danger", withdrawn: "neutral" } as const;
const STATE_LABEL = { pending: "Waiting", approved: "Approved", rejected: "Rejected", withdrawn: "No longer asked" } as const;

function EntryCard({ entry: e, isManager }: { entry: LateEntry; isManager: boolean }) {
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
      {!!e.possibleCopies?.length && (
        // Another record for the same money (2026-10-22, "duplicates showing in Waiting"): typed twice, or an expense
        // and the cash line typed for it.
        <div className="space-y-1 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-warning">
            <Copy className="h-3.5 w-3.5" /> Possible copy — the same amount and date as:
          </p>
          <ul className="space-y-0.5">
            {e.possibleCopies.map((c) => (
              <li key={c.id}>
                <Link href={c.href} className="font-medium hover:underline">{LATE_ENTRY_KIND_LABELS[c.kind]} {c.number}</Link>
                {c.title && <span className="text-foreground-muted"> · {c.title}</span>}
                <span className="text-foreground-muted"> — {STATE_LABEL[c.state].toLowerCase()}{c.decidedByName ? ` by ${c.decidedByName}` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!e.earlier?.length && (
        // One card per record (2026-10-22): what was asked about it before, open when a manager rejected it once.
        <details className="text-sm" open={e.earlier.some((x) => x.state === "rejected")}>
          <summary className="cursor-pointer text-foreground-muted">Asked before about this record ({e.earlier.length})</summary>
          <ul className="mt-1.5 space-y-1.5 border-l border-border pl-3">
            {e.earlier.map((x) => (
              <li key={x.id}>
                <Badge tone={STATE_TONE[x.state]}>{STATE_LABEL[x.state]}</Badge>{" "}
                dated {x.date}{x.previousDate ? ` (moved back from ${x.previousDate})` : ""} — {x.enteredByName || "—"}, {new Date(x.enteredAt).toLocaleDateString()}: {x.reason}
                {x.decidedByName && (
                  <span className="text-foreground-muted"> · {x.state === "rejected" ? "rejected" : "approved"} by {x.decidedByName}{x.decisionNote ? ` — ${x.decisionNote}` : ""}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
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
          <p className="text-right text-xs text-foreground-muted">
            {isManager ? "You entered this — another manager decides it." : "Waiting for a manager to decide it."}
          </p>
        )
      )}
    </Card>
  );
}

// ── Old dates: everything entered with a date before the day it was typed (2026-10-21) ─────────────────────────────

const ORIGIN_LABEL = { typed: "Typed in finance", approval: "Recorded by an approval", hrms: "From HRMS" } as const;
const KIND_LABEL: Record<OldDateRow["kind"], string> = {
  payment: "invoice payment", bill_payment: "bill payment", expense: "expense", bill: "bill", invoice: "invoice", bank_line: "bank / cash line",
};
const LATE_TONE = { pending: "warning", approved: "success", rejected: "danger", withdrawn: "neutral" } as const;
const LATE_WORD = { pending: "waiting", approved: "approved", rejected: "rejected", withdrawn: "no longer asked" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * The same list as Root's Pending → Finance "Entered with an old date", across every organization the reader reads
 * (2026-10-21), filterable by organization: the last 30 days' entries dated a day or more before they were typed in — typed in finance, recorded when an approval went through, or brought from HRMS — with
 * the days back and each one's late entry. Typed ones at the organization's days or more need a manager (Waiting).
 */
function OldDatesList({ days }: { days: number }) {
  const { data, isLoading, error } = useOldDateEntries();
  const [origin, setOrigin] = useUrlParam<"typed" | "approval" | "hrms" | "all">("origin", "typed", { allowed: ["typed", "approval", "hrms", "all"] });
  const [orgFilter, setOrgFilter] = useUrlParam("org", "all");
  const switchOrganization = useSwitchOrganization();
  const [opening, setOpening] = useState<string | null>(null);
  if (isLoading) return <Card className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>;
  if (error || !data) {
    return (
      <Card className="px-5 py-12 text-center text-sm text-foreground-muted">
        {error instanceof ApiError && error.status === 404 ? "This needs the latest finance API — ask for it to be updated." : error instanceof ApiError ? error.message : "Could not load them."}
      </Card>
    );
  }
  const orgs = data.organizations ?? [];
  const inOrg = orgFilter === "all" ? data.rows : data.rows.filter((r) => r.orgId === orgFilter);
  const rows = origin === "all" ? inOrg : inOrg.filter((r) => r.origin === origin);
  const countOf = (o: "typed" | "approval" | "hrms" | "all") => (o === "all" ? inOrg.length : inOrg.filter((r) => r.origin === o).length);
  // Another organization's entry opens there: the session moves to it first.
  const open = async (r: OldDateRow) => {
    setOpening(`${r.kind}:${r.id}`);
    try {
      await switchOrganization(r.orgId);
      window.location.href = r.href;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not switch organization");
      setOpening(null);
    }
  };
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-1 border-b border-border p-2 text-sm">
        {(["typed", "approval", "hrms", "all"] as const).map((o) => (
          <button
            key={o}
            onClick={() => setOrigin(o)}
            className={`rounded-md px-3 py-1.5 font-medium ${origin === o ? "bg-surface-muted text-foreground" : "text-foreground-muted hover:bg-surface-muted/60"}`}
          >
            {o === "all" ? "All" : ORIGIN_LABEL[o]} <span className="tabular-nums text-foreground-muted">{countOf(o)}</span>
          </button>
        ))}
        {orgs.length > 1 && (
          <select
            value={orgFilter}
            onChange={(e) => setOrgFilter(e.target.value)}
            className="ml-auto h-8 rounded-md border border-border bg-surface px-2 text-sm"
            aria-label="Organization"
          >
            <option value="all">All organizations ({data.rows.length})</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.count})</option>)}
          </select>
        )}
      </div>
      {!rows.length ? (
        <p className="px-5 py-12 text-center text-sm text-foreground-muted">Nothing entered with an old date here in the last {data.rules.withinDays} days.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted/60 text-left text-xs text-foreground-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Entry</th>
                <th className="px-4 py-2 font-medium">Its date</th>
                <th className="px-4 py-2 font-medium">Entered</th>
                <th className="px-4 py-2 text-right font-medium">Days back</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">How · who · late entry</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}:${r.id}`} className="border-t border-border align-top">
                  <td className="px-4 py-2.5">
                    {!data.currentOrgId || r.orgId === data.currentOrgId ? (
                      <Link href={r.href} className="font-medium hover:underline">{[r.number, r.title].filter(Boolean).join(" · ")}</Link>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void open(r)}
                        disabled={!!opening}
                        className="text-left font-medium hover:underline disabled:opacity-60"
                        title={`Opens in ${r.orgName} — switches organization`}
                      >
                        {opening === `${r.kind}:${r.id}` && <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />}
                        {[r.number, r.title].filter(Boolean).join(" · ")}
                      </button>
                    )}
                    <p className="text-xs text-foreground-muted">{KIND_LABEL[r.kind]}{orgs.length > 1 && r.orgName ? ` · ${r.orgName}` : ""}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">{r.date}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-foreground-muted">{when(r.enteredAt)}</td>
                  <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${r.daysBack >= 7 ? "text-danger" : r.daysBack >= Math.max(1, days) && days > 0 ? "text-warning" : ""}`}>{r.daysBack}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right"><MoneyDisplay minor={r.amountMinor} currency={r.currency} /></td>
                  <td className="px-4 py-2.5">
                    <span className={r.origin === "typed" ? "text-warning" : "text-foreground-muted"}>{ORIGIN_LABEL[r.origin]}</span>
                    {r.enteredBy && <span className="text-foreground-muted"> · {r.enteredBy}</span>}
                    {r.late && (
                      <div className="mt-1" title={r.late.reason}>
                        <Badge tone={LATE_TONE[r.late.state as keyof typeof LATE_TONE] ?? "neutral"}>
                          Late entry {LATE_WORD[r.late.state as keyof typeof LATE_WORD] ?? r.late.state}{r.late.decidedBy ? ` — ${r.late.decidedBy}` : ""}
                        </Badge>
                        {r.late.reason && <p className="mt-0.5 text-xs text-foreground-muted">Why: {r.late.reason}</p>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-border px-4 py-2.5 text-xs text-foreground-muted">
        Days back is from the entry&apos;s own date to the day it was typed in (Gulf days). Typed in finance with a date {days === 1 ? "before that day" : `${days} or more days back`} needs a reason and a manager; entries made before that rule (or by approvals and HRMS) are listed, not asked.
      </p>
    </Card>
  );
}

