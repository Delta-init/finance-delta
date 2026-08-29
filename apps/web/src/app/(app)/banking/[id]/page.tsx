"use client";

import { use, useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Plus, Upload, BarChart3, Search, X, TrendingUp, TrendingDown,
  CheckCircle2, CircleDot, Ban, Copy, Pencil, Trash2, AlertTriangle, RotateCcw,
} from "lucide-react";
import {
  type BankTransaction,
  type BankTransactionStatus,
  BANK_ACCOUNT_TYPE_LABELS,
  type BankAccountType,
} from "@delta/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { Tooltip } from "@/components/ui/tooltip";
import { useTableQuery } from "@/lib/use-table-query";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import {
  useBankAccount,
  useBankTransactions,
  useExcludeTransaction,
  useMarkDuplicate,
  useRestoreTransaction,
  useUnmatchTransaction,
  useDeactivateBankAccount,
  useUpdateBankTransaction,
  useDeleteBankTransaction,
} from "@/features/banking/api";
import { EditTransactionDialog } from "@/features/banking/edit-transaction-dialog";

const STATUS_TONE: Record<BankTransactionStatus, NonNullable<BadgeProps["tone"]>> = {
  unmatched: "warning",
  matched: "success",
  excluded: "neutral",
  duplicate: "danger",
};

const STATUS_LABELS: Record<BankTransactionStatus, string> = {
  unmatched: "Unmatched",
  matched: "Matched",
  excluded: "Excluded",
  duplicate: "Duplicate",
};

export default function BankAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: account, isLoading: accountLoading } = useBankAccount(id);
  const t = useTableQuery({ initialSort: { key: "date", dir: "desc" } });
  const [status, setStatus] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [source, setSource] = useState("all");
  const [editing, setEditing] = useState<BankTransaction | null>(null);
  const [deleting, setDeleting] = useState<BankTransaction | null>(null);
  const updateTx = useUpdateBankTransaction(id);
  const deleteTx = useDeleteBankTransaction(id);
  useEffect(() => t.resetPage(), [status, dateFrom, dateTo, source]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: txData, isLoading: txLoading } = useBankTransactions(id, {
    ...t.baseParams,
    status: status === "all" ? undefined : status,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    source: source === "all" ? undefined : source,
  });

  const hasFilters = status !== "all" || !!dateFrom || !!dateTo || source !== "all" || !!t.q;

  async function handleTxAction(
    action: () => Promise<unknown>,
    msg: string,
  ) {
    try {
      await action();
      toast.success(msg);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Action failed");
    }
  }

  const columns: Column<BankTransaction>[] = [
    {
      key: "date",
      header: "Date",
      sortable: true,
      cell: (tx) => <span className="text-foreground-muted">{tx.date}</span>,
    },
    {
      key: "description",
      header: "Description",
      sortable: true,
      cell: (tx) => (
        <div>
          <p className="font-medium text-foreground max-w-xs truncate">{tx.description}</p>
          {tx.reference && (
            <p className="text-xs text-foreground-muted">{tx.reference}</p>
          )}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      cell: (tx) => (
        <Badge tone={STATUS_TONE[tx.status]}>{STATUS_LABELS[tx.status]}</Badge>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      sortable: true,
      cell: (tx) => (
        <div className="flex items-center justify-end gap-1">
          {tx.type === "credit" ? (
            <TrendingUp className="h-3.5 w-3.5 text-success" />
          ) : (
            <TrendingDown className="h-3.5 w-3.5 text-danger" />
          )}
          <MoneyDisplay
            minor={Math.abs(tx.amountMinor)}
            currency={tx.currency}
            className={`font-medium ${tx.type === "credit" ? "text-success" : "text-danger"}`}
          />
        </div>
      ),
    },
    {
      key: "balance",
      header: "Balance",
      align: "right",
      sortable: true,
      cell: (tx) => (
        <MoneyDisplay
          minor={tx.runningBalanceMinor}
          currency={tx.currency}
          className={tx.runningBalanceMinor < 0 ? "text-danger" : "text-foreground"}
        />
      ),
    },
    {
      key: "actions",
      header: "",
      hideInDetail: true,
      cell: (tx) => (
        <TxActions
          tx={tx}
          accountId={id}
          onAction={handleTxAction}
          onEdit={setEditing}
          onDelete={setDeleting}
        />
      ),
    },
  ];

  if (accountLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-foreground-muted text-sm">Loading…</div>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-foreground-muted text-sm">Account not found.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link
          href="/banking"
          className="mt-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{account.accountName}</h1>
            <Badge tone={account.isActive ? "success" : "neutral"}>
              {account.isActive ? "Active" : "Inactive"}
            </Badge>
            <Badge tone="neutral">
              {BANK_ACCOUNT_TYPE_LABELS[account.accountType as BankAccountType]}
            </Badge>
          </div>
          {account.bankName && (
            <p className="text-sm text-foreground-muted mt-0.5">{account.bankName}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => router.push(`/banking/${id}/import`)}>
            <Upload className="h-4 w-4" /> Import
          </Button>
          <Button variant="outline" onClick={() => router.push(`/banking/${id}/reconcile`)}>
            <BarChart3 className="h-4 w-4" /> Reconcile
          </Button>
        </div>
      </div>

      {/* Balance cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide">Current Balance</p>
          <MoneyDisplay
            minor={account.currentBalanceMinor}
            currency={account.currency}
            className={`mt-1 text-2xl font-bold ${account.currentBalanceMinor < 0 ? "text-danger" : "text-foreground"}`}
          />
          <p className="text-xs text-foreground-subtle mt-1">{account.currency}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide">Opening Balance</p>
          <MoneyDisplay
            minor={account.openingBalanceMinor}
            currency={account.currency}
            className="mt-1 text-xl font-semibold text-foreground"
          />
          <p className="text-xs text-foreground-subtle mt-1">as of {account.openingDate}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide">Last Reconciled</p>
          <p className="mt-1 text-xl font-semibold text-foreground">
            {account.lastReconciledAt ? account.lastReconciledAt.slice(0, 10) : "—"}
          </p>
          {account.lastReconciledStatementBalanceMinor !== undefined && (
            <MoneyDisplay
              minor={account.lastReconciledStatementBalanceMinor}
              currency={account.currency}
              className="text-xs text-foreground-subtle mt-1"
            />
          )}
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide">Account #</p>
          <p className="mt-1 text-xl font-semibold text-foreground font-mono">
            {account.accountNumber || "—"}
          </p>
          <p className="text-xs text-foreground-subtle mt-1">Opened {account.openingDate}</p>
        </div>
      </div>

      {/* Transactions */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input
            value={t.q}
            onChange={(e) => t.setQ(e.target.value)}
            placeholder="Search transactions…"
            className="pl-8"
          />
        </div>

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {(Object.keys(STATUS_LABELS) as BankTransactionStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
            <SelectItem value="import">Imported</SelectItem>
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="w-[140px]"
        />
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="w-[140px]"
        />

        <Button
          variant="outline"
          size="sm"
          onClick={() => router.push(`/banking/${id}/transaction/new`)}
        >
          <Plus className="h-4 w-4" /> Add
        </Button>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus("all");
              setDateFrom("");
              setDateTo("");
              setSource("all");
              t.setQ("");
            }}
          >
            <X className="h-4 w-4" /> Clear
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        data={txData?.data}
        getRowId={(tx) => tx.id}
        total={txData?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        isLoading={txLoading}
        emptyMessage="No transactions found."
      />

      <EditTransactionDialog
        tx={editing}
        open={Boolean(editing)}
        onOpenChange={(o) => { if (!o) { setEditing(null); updateTx.reset(); } }}
        pending={updateTx.isPending}
        error={updateTx.error ? (updateTx.error as Error).message : null}
        onSubmit={(input) =>
          editing &&
          updateTx.mutate(
            { txId: editing.id, input },
            { onSuccess: () => { setEditing(null); toast.success("Transaction updated"); } },
          )
        }
      />

      {deleting && (
        <Dialog open onOpenChange={(o) => { if (!o) { setDeleting(null); deleteTx.reset(); } }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Delete this transaction?</DialogTitle>
              <DialogDescription>
                {deleting.description} · {deleting.date}
              </DialogDescription>
            </DialogHeader>
            <p className="flex items-start gap-2 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <span>
                {/* Said plainly, because the figure people are looking at while
                    they decide is the one that is about to move. */}
                The running balance is recalculated in date order, so every figure after this entry
                will change, and so will the account balance. This cannot be undone.
              </span>
            </p>
            {deleteTx.error && (
              <p className="text-sm text-danger">{(deleteTx.error as Error).message}</p>
            )}
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
              <Button
                variant="destructive"
                loading={deleteTx.isPending}
                onClick={() =>
                  deleteTx.mutate(deleting.id, {
                    onSuccess: () => { setDeleting(null); toast.success("Transaction deleted"); },
                  })
                }
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function TxActions({
  tx,
  accountId,
  onAction,
  onEdit,
  onDelete,
}: {
  tx: BankTransaction;
  accountId: string;
  onAction: (action: () => Promise<unknown>, msg: string) => Promise<void>;
  onEdit: (tx: BankTransaction) => void;
  onDelete: (tx: BankTransaction) => void;
}) {
  const exclude = useExcludeTransaction(accountId, tx.id);
  const markDup = useMarkDuplicate(accountId, tx.id);
  const restore = useRestoreTransaction(accountId, tx.id);
  const unmatch = useUnmatchTransaction(accountId, tx.id);

  // Reconciled rows are evidence and matched rows belong to the document they
  // were matched to, so neither offers editing at all rather than offering it
  // and being refused.
  const frozen = tx.isReconciled || (tx.matches?.length ?? 0) > 0;

  return (
    // Always visible. These were revealed on row hover, against a `group` class
    // the row never had — so they were invisible on every row, all the time,
    // and unreachable entirely without a mouse.
    <div className="flex items-center gap-1 justify-end">
      {!frozen && (
        <>
          <Tooltip label="Edit this entry">
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(tx); }}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-foreground-muted hover:bg-surface-muted hover:text-foreground"
              aria-label="Edit this entry"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="Delete this entry">
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(tx); }}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-foreground-muted hover:bg-surface-muted hover:text-danger"
              aria-label="Delete this entry"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </>
      )}
      {/* The way back from excluded or duplicate. Both were one-way, so a row
          flagged by mistake stayed flagged with nothing offering an undo. */}
      {(tx.status === "excluded" || tx.status === "duplicate") && (
        <Tooltip label={tx.status === "excluded" ? "Include again" : "Not a duplicate"}>

          <button

            onClick={(e) => { e.stopPropagation(); onAction(() => restore.mutateAsync(undefined), "Restored"); }}

            className="inline-flex h-7 w-7 items-center justify-center rounded text-foreground-muted hover:bg-surface-muted hover:text-foreground"

            aria-label={tx.status === "excluded" ? "Include again" : "Not a duplicate"}

          >

            <RotateCcw className="h-3.5 w-3.5" />

          </button>

        </Tooltip>
      )}
      {tx.status === "matched" && (
        <Tooltip label="Unmatch">

          <button

            onClick={(e) => { e.stopPropagation(); onAction(() => unmatch.mutateAsync(undefined), "Unmatched"); }}

            className="inline-flex h-7 w-7 items-center justify-center rounded text-foreground-muted hover:bg-surface-muted hover:text-foreground"

            aria-label="Unmatch"

          >

            <CircleDot className="h-3.5 w-3.5" />

          </button>

        </Tooltip>
      )}
      {(tx.status === "unmatched" || tx.status === "matched") && (
        <Tooltip label="Exclude">

          <button

            onClick={(e) => { e.stopPropagation(); onAction(() => exclude.mutateAsync(undefined), "Excluded"); }}

            className="inline-flex h-7 w-7 items-center justify-center rounded text-foreground-muted hover:bg-surface-muted hover:text-foreground"

            aria-label="Exclude"

          >

            <Ban className="h-3.5 w-3.5" />

          </button>

        </Tooltip>
      )}
      {tx.status === "unmatched" && (
        <Tooltip label="Mark duplicate">

          <button

            onClick={(e) => { e.stopPropagation(); onAction(() => markDup.mutateAsync(undefined), "Marked as duplicate"); }}

            className="inline-flex h-7 w-7 items-center justify-center rounded text-foreground-muted hover:bg-surface-muted hover:text-foreground"

            aria-label="Mark duplicate"

          >

            <Copy className="h-3.5 w-3.5" />

          </button>

        </Tooltip>
      )}
    </div>
  );
}
