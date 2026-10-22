"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ClipboardCheck, RefreshCw, Search, X } from "lucide-react";
import { ACADEMIES, ACADEMY_LABELS, ENROLMENT_CRMS, ENROLMENT_CRM_LABELS, describeOverdue, type ApprovalListStatus, type ApprovalRow, type ApprovalType } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { AcademyTag, CrmTag } from "@/components/crm-tag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { MoneyDisplay } from "@/components/ui/money";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { useTableQuery } from "@/lib/use-table-query";
import { countFilters, useUrlParam } from "@/lib/url-state";
import { FilterToggle } from "@/components/ui/filter-toggle";
import { useApprovalList, useApprovalRaisers, useApprovalSummary } from "@/features/approvals/api";
import { LegacyApprovalQueues } from "@/features/approvals/legacy-queues";
import { useFundingRequests } from "@/features/budgets/api";
import { FundingReviewDialog } from "@/features/budgets/review-dialog";
import { useReopenTetraDeposit, useTetraDeposit } from "@/features/tetra-deposits/api";
import { TetraDepositReviewDialog } from "@/features/tetra-deposits/review-dialog";
import { useBalancePayment } from "@/features/balance-payments/api";
import { BalancePaymentReviewDialog } from "@/features/balance-payments/review-dialog";
import { formatWhen } from "@/features/tetra-deposits/status";

/**
 * Every approval, in one table: what is waiting on a decision, and what was
 * approved, rejected or sent back — every kind the reader may decide, newest
 * first, filtered by status, kind and date.
 *
 * Fund requests and Tetra Commission's deposits are still decided right here,
 * with the dialogs they always had. Every other kind opens its own page, where
 * what a decision needs — the receipt, the figures — is.
 *
 * An approved enrolment also says what became of the student afterwards:
 * whether the LMS made their account (or added the course to the one they
 * had), and whether Tetra Commission's portal did — Forex students only.
 */

const STATUSES: { key: ApprovalListStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

const TYPE_LABEL: Record<ApprovalType, string> = {
  invoice: "Enrolment",
  fund_request: "Fund request",
  tetra_deposit: "Tetra deposit",
  balance_payment: "Balance payment",
  expense: "Expense claim",
  bill: "Bill",
  payroll: "Payroll",
  procurement: "Purchase request",
  salary_advance: "Salary advance",
  hiring: "Hiring request",
};

type Tone = "neutral" | "primary" | "success" | "warning" | "danger";

const STATUS_BADGE: Record<ApprovalRow["status"], { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  returned: { label: "Sent back", tone: "danger" },
  closed: { label: "Closed", tone: "neutral" },
};

const LMS_BADGE: Record<NonNullable<ApprovalRow["lms"]>["state"], { label: string; tone: Tone }> = {
  created: { label: "Account created", tone: "success" },
  existing: { label: "Had an account", tone: "success" },
  waiting: { label: "Waiting", tone: "warning" },
  unmapped: { label: "Course not linked", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};

const COMMISSION_BADGE: Record<NonNullable<ApprovalRow["commission"]>["state"], { label: string; tone: Tone }> = {
  created: { label: "Account created", tone: "success" },
  existing: { label: "Had an account", tone: "success" },
  waiting: { label: "Waiting", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Not Forex", tone: "neutral" },
  not_sent: { label: "Not sent", tone: "neutral" },
};

const EMPTY: Record<ApprovalListStatus, string> = {
  pending: "Nothing is waiting on you right now.",
  approved: "Nothing approved in this range.",
  rejected: "Nothing rejected or sent back in this range.",
  all: "No approvals in this range.",
};

const ago = (iso?: string) =>
  iso
    ? describeOverdue(iso.slice(0, 10))
        .replace("days late", "days ago")
        .replace("1 day late", "yesterday")
        .replace("due today", "today")
    : "";

/** The picked days as instants in the viewer's own timezone: the start of the first, and of the day after the last. */
const startOf = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const dayAfter = (day: string) => {
  const next = new Date(`${day}T00:00:00`);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
};

/**
 * One line of the Student accounts column: the system, what it made of the
 * student, the portal's code for them — and, when it went wrong, why.
 */
function OutcomeLine({ system, label, tone, detail, code }: { system: string; label: string; tone: Tone; detail?: string; code?: string }) {
  const wrong = tone === "danger" || label === "Course not linked";
  return (
    <div className="min-w-0" title={[code, detail].filter(Boolean).join(" · ") || undefined}>
      <div className="flex items-center gap-1.5">
        <span className="w-11 shrink-0 text-[11px] font-medium uppercase tracking-wide text-foreground-muted">{system}</span>
        <Badge tone={tone} className="whitespace-nowrap">{label}</Badge>
        {code && <span className="truncate text-xs text-foreground-muted">{code}</span>}
      </div>
      {wrong && detail && <p className="ml-[50px] line-clamp-1 text-xs text-danger">{detail}</p>}
    </div>
  );
}

/** A decided Tetra deposit that Tetra Commission turned down: sent back to be decided again. */
function ReopenButton({ id }: { id: string }) {
  const reopen = useReopenTetraDeposit();
  return (
    <Button
      size="sm"
      variant="outline"
      loading={reopen.isPending}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await reopen.mutateAsync(id);
          toast.success("Reopened — it is back in the queue to decide again");
        } catch (err) {
          toast.error(err instanceof ApiError ? err.message : "Could not reopen it");
        }
      }}
    >
      <RefreshCw className="h-3.5 w-3.5" /> Reopen
    </Button>
  );
}

export default function ApprovalsPage() {
  const router = useRouter();
  const { can } = useCan();
  const invoices = can("invoice:write") && can("invoice:read");
  const funds = can("budget:approve");
  const deposits = can("tetra_deposit:approve");
  const approver = invoices || funds || deposits || can("expense:approve") || can("bill:approve") || can("payroll:approve");
  const { data: summary } = useApprovalSummary(approver);

  const t = useTableQuery({ initialPageSize: 25 });
  // Kept in the address bar, so a filtered view can be shared or bookmarked — read back on opening; since 2026-10-22
  // with the page and its size too (lib/url-state), and the search is the table's own.
  const [status, setStatus] = useUrlParam<ApprovalListStatus>("status", "pending", { allowed: STATUSES.map((st) => st.key) });
  const [type, setType] = useUrlParam<"all" | ApprovalType>("type", "all");
  const [dateFrom, setDateFrom] = useUrlParam("from", "");
  const [dateTo, setDateTo] = useUrlParam("to", "");
  // Search and filters (the user, 2026-10-13): across every approval, not just the page on show.
  const search = t.q, setSearch = t.setQ;
  const query = String(t.baseParams.q ?? ""); // what was typed, once typing pauses
  const [crm, setCrm] = useUrlParam("crm", "all");
  const [academy, setAcademy] = useUrlParam("academy", "all");
  const [raisedBy, setRaisedBy] = useUrlParam("raisedBy", "all");
  // Type, dates, CRM, academy and who raised it — folded away until Filters is pressed (2026-10-22).
  const [filtersOpen, setFiltersOpen] = useState(false);
  const raisers = useApprovalRaisers(approver);
  const filtered = !!query || crm !== "all" || academy !== "all" || raisedBy !== "all";

  const list = useApprovalList(
    {
      status,
      type: type === "all" ? undefined : type,
      from: dateFrom ? startOf(dateFrom) : undefined,
      to: dateTo ? dayAfter(dateTo) : undefined,
      ...(query ? { q: query } : {}),
      ...(crm !== "all" ? { crm } : {}),
      ...(academy !== "all" ? { academy } : {}),
      ...(raisedBy !== "all" ? { raisedBy } : {}),
      page: t.page,
      pageSize: t.pageSize,
    },
    approver,
  );
  // The web app goes live when it is pushed, the finance API when it is
  // deployed; until then there is no list to show, so the queues stand in.
  const apiTooOld = list.error instanceof ApiError && list.error.status === 404;

  // The kinds this person decides, as the summary has them.
  const kinds = useMemo(() => (summary?.groups ?? []).map((g) => ({ type: g.type, label: g.label })), [summary]);

  // Decided here: a fund request with the Budgets dialog, a deposit with its own.
  const fundRequests = useFundingRequests({}, funds);
  const [fundId, setFundId] = useState<string | null>(null);
  const fundTarget = useMemo(() => (fundRequests.data?.data ?? []).find((r) => r.id === fundId) ?? null, [fundRequests.data, fundId]);
  const [depositId, setDepositId] = useState<string | null>(null);
  const [depositStart, setDepositStart] = useState<"approved" | "sentBack">("approved");
  const [balanceId, setBalanceId] = useState<string | null>(null);
  const balanceTarget = useBalancePayment(balanceId);
  const depositTarget = useTetraDeposit(depositId);

  const decide = (row: ApprovalRow) => {
    if (row.type === "fund_request") setFundId(row.id);
    else if (row.type === "tetra_deposit") { setDepositStart("approved"); setDepositId(row.id); }
    else if (row.type === "balance_payment") setBalanceId(row.id);
  };
  // A bonus straight back to its CS, with what to correct (2026-10-13) — like an invoice's Send back.
  const sendBack = (row: ApprovalRow) => { setDepositStart("sentBack"); setDepositId(row.id); };
  const open = (row: ApprovalRow) => {
    if (row.status === "pending" && row.decideHere) {
      if (!row.own) decide(row);
      return;
    }
    router.push(row.href);
  };

  if (!approver) {
    return (
      <div className="p-6 text-sm text-foreground-muted">
        Approving is not something your role does.
      </div>
    );
  }

  const rows = list.data?.data ?? [];
  // Only an approved enrolment has accounts to show; the column is not worth its width elsewhere.
  const showOutcomes = rows.some((r) => r.lms || r.commission) || ((status === "approved" || status === "all") && (type === "all" || type === "invoice") && invoices);
  const hasFilters = status !== "pending" || type !== "all" || !!dateFrom || !!dateTo || !!search || filtered;
  // Searched or filtered, the Pending count is what matches; otherwise everything waiting.
  const pendingCount = filtered && status === "pending" ? list.data?.meta.total ?? 0 : summary?.total ?? 0;
  const procurementVisible = kinds.some((k) => k.type === "procurement");
  // Review a fund request or deposit here; reopen a deposit Tetra Commission turned down.
  const canDecide = (r: ApprovalRow) => r.status === "pending" && !!r.decideHere && !r.own;
  const canReopen = (r: ApprovalRow) => r.type === "tetra_deposit" && r.delivery?.state === "failed";
  const hasActions = rows.some((r) => canDecide(r) || canReopen(r));

  const columns: Column<ApprovalRow>[] = [
    {
      key: "item",
      header: "Item",
      // The kind rides on the item rather than taking a column of its own: one
      // narrow badge was costing the width the student's accounts need.
      cell: (r) => (
        <div className="min-w-[160px] max-w-[230px]">
          {/* An enrolment says which sales CRM sold it, beside what it is. */}
          <div className="mb-1 flex flex-wrap items-center gap-1">
            <Badge tone="primary" className="whitespace-nowrap text-[11px]">{TYPE_LABEL[r.type]}</Badge>
            <CrmTag crm={r.crm} />
            <AcademyTag academy={r.academy} />
          </div>
          <p className="truncate font-medium">{r.title}</p>
          {r.subtitle && <p className="truncate text-xs text-foreground-muted">{r.subtitle}</p>}
          {/* An enrolment flagged when its CRM handed it over — an email that
              belongs to another client, an unmapped course — said on the row
              while it waits; once decided, its page still says. */}
          {r.status === "pending" && r.flags?.map((f) => (
            <p key={f} className="mt-1 flex items-start gap-1 text-xs text-warning" title={f}>
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span className="line-clamp-2">{f}</span>
            </p>
          ))}
        </div>
      ),
    },
    { key: "raisedBy", header: <span className="whitespace-nowrap">Raised by</span>, cell: (r) => r.raisedBy || <span className="text-foreground-muted">—</span> },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      // An enrolment: what was collected at the close (or recorded since), its fee under it.
      cell: (r) =>
        r.amountMinor !== undefined ? (
          <div>
            <MoneyDisplay minor={r.amountMinor} currency={r.currency ?? "AED"} className="whitespace-nowrap" />
            {r.feeMinor !== undefined && (
              <p className="whitespace-nowrap text-xs text-foreground-muted">
                of <MoneyDisplay minor={r.feeMinor} currency={r.currency ?? "AED"} /> fee
              </p>
            )}
          </div>
        ) : (
          "—"
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => {
        const badge = STATUS_BADGE[r.status];
        const notWithTetra = r.delivery
          ? r.delivery.state === "failed"
            ? `Tetra Commission did not accept it: ${r.delivery.error ?? "no reason given"}`
            : "Not with Tetra Commission yet — sending on its own"
          : "";
        return (
          <div className="min-w-[120px] max-w-[220px]">
            <Badge tone={badge.tone} className="whitespace-nowrap">{badge.label}</Badge>
            {r.status !== "pending" && r.decidedBy && <p className="mt-0.5 truncate text-xs text-foreground-muted">by {r.decidedBy}</p>}
            {r.own && <p className="mt-0.5 text-xs text-foreground-muted">Your own — someone else reviews it</p>}
            {r.reason && <p className="mt-0.5 line-clamp-2 text-xs text-foreground-muted" title={r.reason}>{r.reason}</p>}
            {notWithTetra && <p className={cn("mt-0.5 line-clamp-2 text-xs", r.delivery?.state === "failed" ? "text-danger" : "text-warning")} title={notWithTetra}>{notWithTetra}</p>}
          </div>
        );
      },
    },
    {
      key: "when",
      header: "Date",
      cell: (r) => (
        <div className="whitespace-nowrap">
          <p className="text-sm">{formatWhen(r.at) || "—"}</p>
          <p className="text-xs text-foreground-muted">
            {r.status === "pending" ? `submitted ${ago(r.at)}` : r.decidedAt ? `decided ${ago(r.at)}` : ago(r.at)}
          </p>
        </div>
      ),
    },
    ...(showOutcomes
      ? [
          {
            key: "accounts",
            header: <span className="whitespace-nowrap">Student accounts</span>,
            cell: (r: ApprovalRow) =>
              r.lms || r.commission ? (
                <div className="min-w-[200px] space-y-1">
                  {r.lms && <OutcomeLine system="LMS" {...LMS_BADGE[r.lms.state]} detail={r.lms.detail} />}
                  {r.commission && (
                    <OutcomeLine system="Portal" {...COMMISSION_BADGE[r.commission.state]} detail={r.commission.detail} code={r.commission.code} />
                  )}
                </div>
              ) : (
                <span className="text-foreground-muted">—</span>
              ),
          },
        ]
      : []),
    ...(hasActions
      ? [
          {
            key: "action",
            header: "",
            align: "right" as const,
            cell: (r: ApprovalRow) =>
              canDecide(r) ? (
                <div className="flex justify-end gap-2">
                  {r.type === "tetra_deposit" && r.bonus && (
                    <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); sendBack(r); }}>Send back</Button>
                  )}
                  <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); decide(r); }}>Review</Button>
                </div>
              ) : canReopen(r) ? (
                <ReopenButton id={r.id} />
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        icon={ClipboardCheck}
        title="Approvals"
        description="Everything you decide, in one table — waiting, approved and rejected, newest first. An approved enrolment shows whether the student's LMS and commission portal accounts were made."
        action={apiTooOld ? undefined : (
          <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen((o) => !o)} count={countFilters(type, dateFrom, dateTo, crm, academy, raisedBy)} />
        )}
      />

      {apiTooOld ? (
        <>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-foreground-muted">
            <AlertTriangle className="h-4 w-4 text-warning" />
            The finance server is being updated. Until it is, this page shows what is waiting, kind by kind.
          </div>
          <LegacyApprovalQueues summary={summary} invoices={invoices} funds={funds} deposits={deposits} />
        </>
      ) : (
        <>
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, invoice no., STU code, course, who raised it…"
              className="pl-9"
              aria-label="Search approvals"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-border bg-surface p-0.5" role="tablist" aria-label="Status">
              {STATUSES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  role="tab"
                  aria-selected={status === s.key}
                  onClick={() => setStatus(s.key)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    status === s.key ? "bg-primary text-primary-foreground shadow-sm" : "text-foreground-muted hover:text-foreground",
                  )}
                >
                  {s.label}
                  {s.key === "pending" && pendingCount > 0 && (
                    <span className={cn("ml-1.5 rounded-full px-1.5 text-xs", status === s.key ? "bg-white/20" : "bg-warning/15 text-warning")}>
                      {pendingCount}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {filtersOpen && (<>
            <Select value={type} onValueChange={(v) => setType(v as "all" | ApprovalType)}>
              <SelectTrigger className="w-[190px]" aria-label="Type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {kinds.map((k) => (
                  <SelectItem key={k.type} value={k.type}>{k.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-[150px]" aria-label="From" />
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-[150px]" aria-label="To" />

            {invoices && (
              <Select value={crm} onValueChange={setCrm}>
                <SelectTrigger className="w-[160px]" aria-label="Sales CRM"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All CRMs</SelectItem>
                  {ENROLMENT_CRMS.map((c) => <SelectItem key={c} value={c}>{ENROLMENT_CRM_LABELS[c]}</SelectItem>)}
                  <SelectItem value="finance">Typed in finance</SelectItem>
                </SelectContent>
              </Select>
            )}
            {invoices && (
              <Select value={academy} onValueChange={setAcademy}>
                <SelectTrigger className="w-[150px]" aria-label="Academy"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All academies</SelectItem>
                  {ACADEMIES.map((a) => <SelectItem key={a} value={a}>{ACADEMY_LABELS[a]}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {(raisers.data?.length ?? 0) > 0 && (
              <Select value={raisedBy} onValueChange={setRaisedBy}>
                <SelectTrigger className="w-[180px]" aria-label="Raised by"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Raised by anyone</SelectItem>
                  {raisers.data!.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            </>)}

            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStatus("pending"); setType("all"); setDateFrom(""); setDateTo("");
                  setSearch(""); setCrm("all"); setAcademy("all"); setRaisedBy("all");
                }}
              >
                <X className="h-4 w-4" /> Clear
              </Button>
            )}
          </div>

          {(list.data?.meta.unavailable ?? []).map((note) => (
            <div key={note} className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-2.5 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
              <span>Could not be read just now — {note}. It will be tried again shortly.</span>
            </div>
          ))}
          {status === "rejected" && procurementVisible && (type === "all" || type === "procurement" || type === "salary_advance") && (
            <p className="text-xs text-foreground-muted">Rejected purchase requests and salary advances are kept in HRMS, so they are not listed here.</p>
          )}

          <DataTable
            columns={columns}
            data={rows}
            getRowId={(r) => `${r.type}:${r.id}`}
            total={list.data?.meta.total ?? 0}
            page={t.page}
            pageSize={t.pageSize}
            onPageChange={t.setPage}
            onPageSizeChange={t.setPageSize}
            onRowClick={open}
            isLoading={list.isLoading}
            emptyMessage={list.isError ? "The approvals could not be loaded just now." : EMPTY[status]}
            detailTitle={(r) => `${TYPE_LABEL[r.type]} · ${r.title}`}
          />
        </>
      )}

      <FundingReviewDialog request={fundTarget} onClose={() => setFundId(null)} />
      <TetraDepositReviewDialog deposit={depositTarget.data ?? null} start={depositStart} onClose={() => setDepositId(null)} />
      <BalancePaymentReviewDialog payment={balanceTarget.data ?? null} onClose={() => setBalanceId(null)} />
    </div>
  );
}
