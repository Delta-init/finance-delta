"use client";

import { LateBadge } from "@/features/late-entries/LateReason";
import { useState } from "react";
import { useUrlPage, useUrlParam } from "@/lib/url-state";
import { ArrowLeftRight, Calculator, Link2, Link2Off, Paperclip, Pencil, Plus, Trash2, Wallet, X } from "lucide-react";
import { formatMoney, type BankAccount, type BankTransaction } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { ExportButton } from "@/components/ui/export-button";
import type { ExportColumn } from "@/lib/export";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { MatchExpenseDialog } from "@/features/banking/MatchExpenseDialog";
import { CashCountDialog } from "@/features/banking/CashCountDialog";
import { CashEntryDialog } from "@/features/banking/CashEntryDialog";
import { TransferDialog } from "@/features/banking/TransferDialog";
import { EntryReceipts } from "@/features/banking/EntryReceipts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { subcategoriesOf } from "@/features/expense-categories/CategoryPicker";
import {
  useBankTransactions,
  useDeleteBankTransaction, useUnlinkTransaction, useBulkDeleteBankTransactions} from "@/features/banking/api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DateField } from "@/components/ui/date-field";
import { toDmy } from "@/lib/dates";

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
  { header: "Date", value: (t) => toDmy(t.date) },
  { header: "Description", value: (t) => t.description },
  { header: "Reference", value: (t) => t.reference ?? "" },
  { header: `In (${account.currency})`, value: (t) => (t.amountMinor >= 0 ? t.amountMinor / 100 : "") },
  { header: `Out (${account.currency})`, value: (t) => (t.amountMinor < 0 ? -t.amountMinor / 100 : "") },
  { header: `Balance (${account.currency})`, value: (t) => t.runningBalanceMinor / 100 },
  { header: "Category", value: (t) => t.category?.name ?? "" },
  { header: "Subcategory", value: (t) => t.category?.subcategoryName ?? "" },
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
  // Ticked lines, deleted together (the user, 2026-11-11: "Select and delete option (bulk) action required in Bank").
  const bulkDelete = useBulkDeleteBankTransactions(account.id);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkSkipped, setBulkSkipped] = useState<{ deleted: number; skipped: { id: string; date: string; description: string; amountMinor: number; reason: string }[] } | null>(null);
  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
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
  // Its page and dates in the address bar (2026-10-22), under names of their own — on a tin's account page the
  // transaction list below keeps the plain ones.
  const [page, setPage] = useUrlPage("book_page");
  // A tin is read a month at a time, and exported the same way.
  const [dateFrom, setDateFrom] = useUrlParam("book_from", "", { page: "book_page" });
  const [dateTo, setDateTo] = useUrlParam("book_to", "", { page: "book_page" });
  // What it was for (2026-10-22): a category, then one of its subcategories — or "none", money out with none yet.
  const { data: categories } = useExpenseCategories();
  const [category, setCategory] = useUrlParam("book_category", "", { page: "book_page" });
  const [subcategory, setSubcategory] = useUrlParam("book_sub", "", { page: "book_page" });
  const pickCategory = (v: string) => { setCategory(v === "all" ? "" : v); setSubcategory(""); };
  const subOptions = category && category !== "none" ? subcategoriesOf(categories, category) : [];
  const [receipts, setReceipts] = useState<BankTransaction | null>(null);
  const filters = {
    sort: "date",
    dir: "asc" as const,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    category: category || undefined,
    subcategory: category && category !== "none" && subcategory ? subcategory : undefined,
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
  // A transfer with another account (2026-10-22): made here, or a line of one corrected — both sides together.
  const [transferLine, setTransferLine] = useState<BankTransaction | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  const rows = data?.data ?? [];
  const filtered = Boolean(dateFrom || dateTo || category);

  const total = data?.meta.total ?? 0;

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Wallet className="h-4 w-4 text-foreground-muted" />
        <h2 className="text-sm font-semibold">Cash book</h2>
        <span className="text-xs text-foreground-muted">
          Opening balance {formatMoney(account.openingBalanceMinor, account.currency)} on{" "}
          {toDmy(account.openingDate)}
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
        {canWrite && (
          <Button size="sm" variant="outline" onClick={() => { setTransferLine(null); setTransferOpen(true); }}>
            <ArrowLeftRight className="mr-1.5 h-3.5 w-3.5" /> Transfer
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
          <DateField value={dateFrom} onChange={setDateFrom} className="w-[150px]" inputClassName="h-8" aria-label="From" clearable />
        </div>
        <div className="space-y-1">
          <label className="block text-[11px] uppercase tracking-wide text-foreground-muted">To</label>
          <DateField value={dateTo} onChange={setDateTo} className="w-[150px]" inputClassName="h-8" aria-label="To" clearable />
        </div>
        <div className="space-y-1">
          <label className="block text-[11px] uppercase tracking-wide text-foreground-muted">Category</label>
          <Select value={category || "all"} onValueChange={pickCategory}>
            <SelectTrigger className="h-8 w-[200px]" aria-label="Category"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              <SelectItem value="none">Uncategorised (money out)</SelectItem>
              {(categories ?? []).map((c) => <SelectItem key={c.slug} value={c.slug}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {subOptions.length > 0 && (
          <div className="space-y-1">
            <label className="block text-[11px] uppercase tracking-wide text-foreground-muted">Subcategory</label>
            <Select value={subcategory || "all"} onValueChange={(v) => setSubcategory(v === "all" ? "" : v)}>
              <SelectTrigger className="h-8 w-[200px]" aria-label="Subcategory"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All subcategories</SelectItem>
                {subOptions.map((x) => <SelectItem key={x.slug} value={x.slug}>{x.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setDateFrom(""); setDateTo(""); pickCategory("all"); }}
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

      {canWrite && picked.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-muted px-5 py-2.5">
          <span className="text-sm font-medium">{picked.length} selected</span>
          <span className="text-xs text-foreground-muted">Lines from an expense or payment, and transfers, are left as they are.</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPicked([])}>Clear</Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmBulk(true)}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete {picked.length}
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-foreground-subtle">
              {canWrite && (
                <th className="w-8 py-2 pl-4">
                  <input
                    type="checkbox"
                    aria-label="Select every line on this page"
                    className="h-4 w-4 accent-primary"
                    checked={rows.length > 0 && rows.every((r: BankTransaction) => picked.includes(r.id))}
                    onChange={(e) => setPicked(e.target.checked ? [...new Set([...picked, ...rows.map((r: BankTransaction) => r.id)])] : picked.filter((x) => !rows.some((r: BankTransaction) => r.id === x)))}
                  />
                </th>
              )}
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="px-4 py-2 text-left font-medium">Description</th>
              <th className="px-4 py-2 text-left font-medium">Category</th>
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
              {canWrite && <td />}
              <td className="px-4 py-2 text-foreground-muted">{toDmy(account.openingDate)}</td>
              <td className="px-4 py-2 font-medium">Opening balance</td>
              <td className="px-4 py-2" />
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
                <td colSpan={canWrite ? 8 : 7} className="px-4 py-8 text-center text-foreground-muted">
                  Loading…
                </td>
              </tr>
            )}

            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={canWrite ? 8 : 7} className="px-4 py-8 text-center text-foreground-muted">
                  Nothing recorded yet.
                </td>
              </tr>
            )}

            {rows.map((tx: BankTransaction) => {
              const isIn = tx.amountMinor >= 0;
              return (
                <tr key={tx.id} className="border-b border-border last:border-0 hover:bg-surface-muted/40">
                  {canWrite && (
                    <td className="w-8 py-2 pl-4">
                      <input type="checkbox" aria-label={`Select ${tx.description}`} className="h-4 w-4 accent-primary" checked={picked.includes(tx.id)} onChange={() => togglePick(tx.id)} />
                    </td>
                  )}
                  <td className="whitespace-nowrap px-4 py-2 text-foreground-muted">
                    {toDmy(tx.date)}
                  </td>
                  <td className="px-4 py-2">
                    {tx.description}
                    {tx.transfer && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[11px] text-foreground-muted" title="A transfer between your own accounts — not income or an expense">
                        <ArrowLeftRight className="h-3 w-3" /> transfer
                      </span>
                    )}
                    {tx.lateEntry && <span className="ml-2"><LateBadge late={tx.lateEntry} /></span>}
                    {tx.matches.length > 0 && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[11px] text-foreground-muted">
                        <Link2 className="h-3 w-3" />
                        {tx.matches.map((m) => m.referenceNumber).join(", ")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {tx.category ? (
                      <span title={tx.category.fromExpense ? "From the expense it was paid for" : undefined}>
                        <span className="text-foreground">{tx.category.name}</span>
                        {tx.category.subcategoryName && <span className="text-foreground-muted"> › {tx.category.subcategoryName}</span>}
                      </span>
                    ) : (
                      <span className="text-foreground-subtle">—</span>
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
                        onClick={() => (tx.transfer ? (setTransferLine(tx), setTransferOpen(true)) : (setEntry(tx), setEntryOpen(true)))}
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
                    {/* Money out matched to an expense — only an expense (2026-11-11); money in isn't matched here. */}
                    {canWrite && !tx.transfer && (tx.matches.length > 0 || tx.amountMinor < 0) && (
                      tx.matches.length === 0 ? (
                        <button
                          type="button"
                          onClick={() => setLinking(tx)}
                          className="mr-2 text-foreground-subtle hover:text-primary"
                          aria-label={`Match ${tx.description} to an expense`}
                          title="Match to an expense"
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
                    {canWrite && !tx.transfer && (
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

      <Dialog open={confirmBulk} onOpenChange={(o) => { if (!o && !bulkDelete.isPending) setConfirmBulk(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {picked.length} line{picked.length === 1 ? "" : "s"}?</DialogTitle>
            <DialogDescription>
              They come out of the cash book and the balance is worked out again. Lines from an expense or a payment, and
              transfer sides, stay — you&apos;ll see which. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmBulk(false)} disabled={bulkDelete.isPending}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={bulkDelete.isPending}
              onClick={() =>
                bulkDelete.mutate(picked, {
                  onSuccess: (r) => {
                    setConfirmBulk(false);
                    setPicked([]);
                    if (r.skipped.length) setBulkSkipped(r);
                    else toast.success(`${r.deleted} line${r.deleted === 1 ? "" : "s"} deleted`);
                  },
                  onError: (err) => toast.error((err as Error).message || "Could not delete them"),
                })
              }
            >
              {bulkDelete.isPending ? "Deleting…" : `Delete ${picked.length}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkSkipped !== null} onOpenChange={(o) => { if (!o) setBulkSkipped(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{bulkSkipped?.deleted ?? 0} deleted, {bulkSkipped?.skipped.length ?? 0} left as they were</DialogTitle>
            <DialogDescription>These couldn&apos;t be deleted:</DialogDescription>
          </DialogHeader>
          <ul className="max-h-72 space-y-2 overflow-y-auto text-sm">
            {bulkSkipped?.skipped.map((x) => (
              <li key={x.id} className="rounded-md border border-border px-3 py-2">
                <div className="flex justify-between gap-2">
                  <span className="font-medium">{toDmy(x.date)} · {x.description || "—"}</span>
                  <span className="font-numeric">{formatMoney(x.amountMinor, account.currency)}</span>
                </div>
                <p className="mt-0.5 text-xs text-foreground-muted">{x.reason}</p>
              </li>
            ))}
          </ul>
          <DialogFooter><Button onClick={() => setBulkSkipped(null)}>OK</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <CashEntryDialog
        account={account}
        entry={entry}
        open={entryOpen}
        onClose={() => setEntryOpen(false)}
      />
      <TransferDialog account={account} line={transferLine} open={transferOpen} onClose={() => setTransferOpen(false)} />

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
        <MatchExpenseDialog accountId={account.id} tx={linking} onClose={() => setLinking(null)} />
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center gap-3 border-t border-border px-5 py-2 text-xs text-foreground-muted">
          <span>
            Entries {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + rows.length} of {total}
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>
              Earlier
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={page * PAGE_SIZE >= total}
              onClick={() => setPage(page + 1)}
            >
              Later
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
