"use client";

import { useState } from "react";
import { Calculator, Link2, Link2Off, Paperclip, Pencil, Plus, Trash2, Wallet, X } from "lucide-react";
import { formatMoney, type BankAccount, type BankTransaction } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExportButton } from "@/components/ui/export-button";
import type { ExportColumn } from "@/lib/export";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { LinkRowDialog } from "@/features/banking/LinkRowDialog";
import { CashCountDialog } from "@/features/banking/CashCountDialog";
import { CashEntryDialog } from "@/features/banking/CashEntryDialog";
import { EntryReceipts } from "@/features/banking/EntryReceipts";
import {
  useBankTransactions,
  useDeleteBankTransaction, useUnlinkTransaction} from "@/features/banking/api";

/**
 * The petty cash book.
 *
 * The same transactions the generic account screen shows, laid out the way a
 * cash book is actually kept: oldest first, money in and money out in their own
 * columns, and the balance carried down the page from a stated opening figure.
 *
 * One signed Amount column is right for a bank statement and wrong here — the
 * person keeping a tin thinks in "paid out 55" and "took in 2303", not in
 * "−55" and "+2303", and a column that makes them read a minus sign to tell the
 * two apart is a column that gets misread.
 *
 * The running balance is not computed in this component. It is stored on each
 * transaction and recomputed on the server whenever one is added or corrected,
 * so a row entered with last week's date lands in its place and every balance
 * after it moves — which is the thing a spreadsheet gets wrong.
 */

/**
 * What a cash book exports.
 *
 * In and Out as separate numeric columns, the way the book reads — one signed
 * column would need a minus sign to tell them apart in a spreadsheet too.
 * Numbers stay numbers so Excel can total them.
 */
const EXPORT_COLUMNS = (account: BankAccount): ExportColumn<BankTransaction>[] => [
  { header: "Date", value: (t) => t.date.slice(0, 10) },
  { header: "Description", value: (t) => t.description },
  { header: "Reference", value: (t) => t.reference ?? "" },
  { header: `In (${account.currency})`, value: (t) => (t.amountMinor >= 0 ? t.amountMinor / 100 : "") },
  { header: `Out (${account.currency})`, value: (t) => (t.amountMinor < 0 ? -t.amountMinor / 100 : "") },
  { header: `Balance (${account.currency})`, value: (t) => t.runningBalanceMinor / 100 },
  { header: "Linked to", value: (t) => t.matches.map((m) => m.referenceNumber).join(" ") },
  { header: "Receipts", value: (t) => t.attachments.length },
  { header: "Counted", value: (t) => (t.isReconciled ? "yes" : "") },
  { header: "Notes", value: (t) => t.notes ?? "" },
];

/** The server caps a page at 100. */
const PAGE_SIZE = 100;

export function CashBook({ account }: { account: BankAccount }) {
  const { can } = useCan();
  const canWrite = can("banking:write");
  const remove = useDeleteBankTransaction(account.id);
  const unlink = useUnlinkTransaction(account.id);

  /*
   * Oldest first, and a page as large as the server allows — a cash book is
   * read down the page, and paging it every ten rows would make the balance
   * column meaningless.
   *
   * A tin busier than this keeps its older entries on the transaction list
   * below, which is searchable. Said in the footer rather than left to be
   * discovered by a balance that does not tie.
   */
  const [page, setPage] = useState(1);
  // A tin is read a month at a time, and exported the same way.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [receipts, setReceipts] = useState<BankTransaction | null>(null);
  const filters = {
    sort: "date",
    dir: "asc" as const,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const { data, isLoading } = useBankTransactions(account.id, {
    page,
    pageSize: PAGE_SIZE,
    ...filters,
  });

  const [linking, setLinking] = useState<BankTransaction | null>(null);
  const [counting, setCounting] = useState(false);
  // Null while adding, a row while correcting one. The dialog is the same.
  const [entry, setEntry] = useState<BankTransaction | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);

  const rows = data?.data ?? [];
  const filtered = Boolean(dateFrom || dateTo);

  const total = data?.meta.total ?? 0;

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Wallet className="h-4 w-4 text-foreground-muted" />
        <h2 className="text-sm font-semibold">Cash book</h2>
        <span className="text-xs text-foreground-muted">
          Opening balance {formatMoney(account.openingBalanceMinor, account.currency)} on{" "}
          {account.openingDate}
        </span>
        <span className="ml-auto text-xs text-foreground-muted">
          {total} {total === 1 ? "entry" : "entries"}
          {filtered ? " in range" : ""}
        </span>
        {canWrite && (
          <Button size="sm" onClick={() => { setEntry(null); setEntryOpen(true); }}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New entry
          </Button>
        )}
        {can("banking:reconcile") && (
          <Button size="sm" variant="outline" onClick={() => setCounting(true)}>
            <Calculator className="mr-1.5 h-3.5 w-3.5" /> Count cash
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-border px-5 py-2.5">
        <div className="space-y-1">
          <label className="block text-[11px] uppercase tracking-wide text-foreground-muted">From</label>
          <Input
            type="date"
            value={dateFrom}
            className="h-8 w-[150px]"
            onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
          />
        </div>
        <div className="space-y-1">
          <label className="block text-[11px] uppercase tracking-wide text-foreground-muted">To</label>
          <Input
            type="date"
            value={dateTo}
            className="h-8 w-[150px]"
            onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
          />
        </div>
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}
          >
            <X className="mr-1 h-3.5 w-3.5" /> Clear
          </Button>
        )}
        <div className="ml-auto">
          {/* The app's own export control: Excel or PDF, the full filtered set
              rather than the page on screen, and the same button everywhere
              else in the product. */}
          <ExportButton<BankTransaction>
            resource={`bank-accounts/${account.id}/transactions`}
            params={filters}
            columns={EXPORT_COLUMNS(account)}
            filename={`cash-book-${account.accountName.replace(/[^a-zA-Z0-9._-]/g, "-")}`}
            title={`Cash book — ${account.accountName}`}
            disabled={total === 0}
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-foreground-subtle">
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="px-4 py-2 text-left font-medium">Description</th>
              <th className="px-4 py-2 text-right font-medium">In</th>
              <th className="px-4 py-2 text-right font-medium">Out</th>
              <th className="px-4 py-2 text-right font-medium">Balance</th>
              <th className="w-28 px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {/* Stated as a row of its own, the way the sheet states it, so the
                first balance in the column has something to follow from. */}
            {page === 1 && !filtered && (
            <tr className="border-b border-border bg-surface-muted/40">
              <td className="px-4 py-2 text-foreground-muted">{account.openingDate}</td>
              <td className="px-4 py-2 font-medium">Opening balance</td>
              <td className="px-4 py-2" />
              <td className="px-4 py-2" />
              <td className="px-4 py-2 text-right font-numeric font-medium">
                {formatMoney(account.openingBalanceMinor, account.currency)}
              </td>
              <td />
            </tr>
            )}

            {isLoading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-foreground-muted">
                  Loading…
                </td>
              </tr>
            )}

            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-foreground-muted">
                  Nothing recorded yet.
                </td>
              </tr>
            )}

            {rows.map((tx: BankTransaction) => {
              const isIn = tx.amountMinor >= 0;
              return (
                <tr key={tx.id} className="border-b border-border last:border-0 hover:bg-surface-muted/40">
                  <td className="whitespace-nowrap px-4 py-2 text-foreground-muted">
                    {tx.date.slice(0, 10)}
                  </td>
                  <td className="px-4 py-2">
                    {tx.description}
                    {tx.matches.length > 0 && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[11px] text-foreground-muted">
                        <Link2 className="h-3 w-3" />
                        {tx.matches.map((m) => m.referenceNumber).join(", ")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-numeric text-success">
                    {isIn ? formatMoney(tx.amountMinor, account.currency) : ""}
                  </td>
                  <td className="px-4 py-2 text-right font-numeric text-danger">
                    {isIn ? "" : formatMoney(Math.abs(tx.amountMinor), account.currency)}
                  </td>
                  <td className="px-4 py-2 text-right font-numeric font-medium">
                    {formatMoney(tx.runningBalanceMinor, account.currency)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    {/* Marked, not locked. A counted entry stays correctable —
                        the count above it is what has to be taken again, and
                        whoever keeps the tin can do that themselves. */}
                    {tx.isReconciled && (
                      <span
                        className="mr-2 text-[11px] text-foreground-subtle"
                        title="Covered by a cash count. Changing it means the count below no longer matches — take it again."
                      >
                        counted
                      </span>
                    )}
                    {canWrite && (
                      <button
                        type="button"
                        onClick={() => { setEntry(tx); setEntryOpen(true); }}
                        className="mr-2 text-foreground-subtle hover:text-primary"
                        aria-label={`Edit ${tx.description}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setReceipts(tx)}
                      className={`mr-2 ${
                        tx.attachments.length > 0 ? "text-primary" : "text-foreground-subtle"
                      } hover:text-primary`}
                      aria-label={`Receipts for ${tx.description}`}
                      title={
                        tx.attachments.length > 0
                          ? `${tx.attachments.length} receipt${tx.attachments.length === 1 ? "" : "s"}`
                          : "Attach a receipt"
                      }
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                    </button>
                    {/* Linking was one-way: once an entry pointed at a
                        document the button went, and an entry linked to the
                        wrong expense could only be deleted and typed again.
                        The server has always been able to undo it. */}
                    {canWrite && (
                      tx.matches.length === 0 ? (
                        <button
                          type="button"
                          onClick={() => setLinking(tx)}
                          className="mr-2 text-foreground-subtle hover:text-primary"
                          aria-label={`Link ${tx.description} to a document`}
                          title="Link to a document"
                        >
                          <Link2 className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={unlink.isPending}
                          onClick={async () => {
                            try {
                              await unlink.mutateAsync(tx.id);
                              toast.success("Unlinked");
                            } catch (e) {
                              toast.error(e instanceof ApiError ? e.message : "Could not unlink it");
                            }
                          }}
                          className="mr-2 text-foreground-subtle hover:text-danger disabled:opacity-50"
                          aria-label={`Unlink ${tx.description} from ${tx.matches.map((m) => m.referenceNumber).join(", ")}`}
                          title={`Unlink from ${tx.matches.map((m) => m.referenceNumber).join(", ")}`}
                        >
                          <Link2Off className="h-3.5 w-3.5" />
                        </button>
                      )
                    )}
                    {canWrite && (
                      <button
                        type="button"
                        disabled={remove.isPending}
                        onClick={async () => {
                          try {
                            await remove.mutateAsync(tx.id);
                            toast.success("Entry removed");
                          } catch (e) {
                            toast.error(e instanceof ApiError ? e.message : "Could not remove it");
                          }
                        }}
                        className="text-foreground-subtle hover:text-danger disabled:opacity-50"
                        aria-label={`Remove ${tx.description}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>

        </table>
      </div>

      <CashEntryDialog
        account={account}
        entry={entry}
        open={entryOpen}
        onClose={() => setEntryOpen(false)}
      />

      <CashCountDialog account={account} open={counting} onClose={() => setCounting(false)} />

      {receipts && (
        <EntryReceipts
          account={account}
          tx={rows.find((r) => r.id === receipts.id) ?? receipts}
          open
          onClose={() => setReceipts(null)}
        />
      )}

      {linking && (
        <LinkRowDialog
          accountId={account.id}
          tx={linking}
          currency={account.currency}
          open
          onClose={() => setLinking(null)}
        />
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center gap-3 border-t border-border px-5 py-2 text-xs text-foreground-muted">
          <span>
            Entries {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + rows.length} of {total}
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Earlier
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={page * PAGE_SIZE >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              Later
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
