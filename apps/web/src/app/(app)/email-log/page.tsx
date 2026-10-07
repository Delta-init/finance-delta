"use client";

import { useState } from "react";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useTableQuery } from "@/lib/use-table-query";
import { EMAIL_KIND_LABEL, EMAIL_STATE_LABEL, useEmailLogs, type EmailLogRow } from "@/features/email-log/api";
import { EmailStateBadge } from "@/features/email-log/state-badge";

/**
 * Every email finance tried to send, and whether it went (the user,
 * 2026-10-07) — invoices, resends, reminders and every notice. Admins and
 * accountants. Kept forever.
 */
const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
    : "—";

export default function EmailLogPage() {
  const t = useTableQuery({ initialPageSize: 25 });
  const [kind, setKind] = useState("all");
  const [state, setState] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const params = {
    page: t.page,
    pageSize: t.pageSize,
    ...(t.q ? { search: t.q } : {}),
    ...(kind !== "all" ? { kind } : {}),
    ...(state !== "all" ? { state } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
  const logs = useEmailLogs(params);

  const columns: Column<EmailLogRow>[] = [
    { key: "at", header: "When", cell: (r) => <span className="whitespace-nowrap">{when(r.at)}</span> },
    { key: "to", header: "To", cell: (r) => (r.to.length ? r.to.join(", ") : <span className="text-foreground-muted">—</span>) },
    { key: "kind", header: "Type", cell: (r) => EMAIL_KIND_LABEL[r.kind] ?? r.kind },
    { key: "subject", header: "Subject", cell: (r) => <span className="line-clamp-1 max-w-80">{r.subject}</span> },
    {
      key: "ref",
      header: "About",
      cell: (r) =>
        r.ref?.type === "invoice" ? (
          <Link href={`/invoices/${r.ref.id}`} className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.ref.label || "Invoice"}
          </Link>
        ) : (
          r.ref?.label || <span className="text-foreground-muted">—</span>
        ),
    },
    {
      key: "state",
      header: "Result",
      cell: (r) => (
        <div>
          <EmailStateBadge row={r} />
          {r.error && r.state !== "sent" && <p className="mt-0.5 max-w-60 text-xs text-foreground-muted">{r.error}</p>}
        </div>
      ),
    },
    { key: "actor", header: "Sent by", cell: (r) => r.actorName },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        icon={MailCheck}
        title="Email Log"
        description="Every email finance has sent — invoices, resends, reminders and notices — and whether it went."
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search address, subject or invoice" className="w-full sm:w-72" />
        <Select value={kind} onValueChange={(v) => { setKind(v); t.setPage(1); }}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every type</SelectItem>
            {Object.entries(EMAIL_KIND_LABEL).map(([k, label]) => <SelectItem key={k} value={k}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={(v) => { setState(v); t.setPage(1); }}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every result</SelectItem>
            {Object.entries(EMAIL_STATE_LABEL).map(([k, label]) => <SelectItem key={k} value={k}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); t.setPage(1); }} className="w-40" aria-label="From" />
        <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); t.setPage(1); }} className="w-40" aria-label="To" />
      </div>
      <DataTable
        columns={columns}
        data={logs.data?.data ?? []}
        getRowId={(r) => r.id}
        total={logs.data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        isLoading={logs.isLoading}
        emptyMessage={logs.isError ? "The email log could not be loaded — the finance server may still be updating." : "No emails match."}
        detailTitle={(r) => r.subject || "Email"}
      />
    </div>
  );
}
