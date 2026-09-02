"use client";

import { useState } from "react";
import { Calculator, Link2, Plus, Trash2, Wallet } from "lucide-react";
import { formatMoney, toMinor, type BankAccount, type BankTransaction } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { LinkRowDialog } from "@/features/banking/LinkRowDialog";
import { CashCountDialog } from "@/features/banking/CashCountDialog";
import {
  useBankTransactions,
  useCreateBankTransaction,
  useDeleteBankTransaction,
} from "@/features/banking/api";

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
 * transaction and recomputed on the server whenever one is added, so a row
 * entered with last week's date lands in its place and every balance after it
 * moves — which is the thing a spreadsheet gets wrong.
 */
/** The server caps a page at 100. */
const PAGE_SIZE = 100;

const today = () => new Date().toISOString().slice(0, 10);

export function CashBook({ account }: { account: BankAccount }) {
  const { can } = useCan();
  const canWrite = can("banking:write");
  const create = useCreateBankTransaction(account.id);
  const remove = useDeleteBankTransaction(account.id);

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
  const { data, isLoading } = useBankTransactions(account.id, {
    page,
    pageSize: PAGE_SIZE,
    sort: "date",
    dir: "asc",
  });

  const [date, setDate] = useState(today);
  const [description, setDescription] = useState("");
  const [inAmount, setInAmount] = useState("");
  const [outAmount, setOutAmount] = useState("");
  const [linking, setLinking] = useState<BankTransaction | null>(null);
  const [counting, setCounting] = useState(false);

  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const inMinor = toMinor(inAmount || "0");
  const outMinor = toMinor(outAmount || "0");
  // Exactly one side, or there is nothing to record and no way to know which.
  const bothSides = inMinor > 0 && outMinor > 0;
  const canSubmit = description.trim().length > 0 && (inMinor > 0 || outMinor > 0) && !bothSides;

  async function addRow() {
    if (!canSubmit) return;
    try {
      await create.mutateAsync({
        date,
        description: description.trim(),
        // In is positive, out is negative. The server takes the sign from here
        // and derives the credit/debit type from it.
        amountMinor: inMinor > 0 ? inMinor : -outMinor,
        reference: "",
        notes: "",
      });
      setDescription("");
      setInAmount("");
      setOutAmount("");
      // The date stays, because a run of entries is usually the same day.
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not add the entry");
    }
  }

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
        </span>
        {can("banking:reconcile") && (
          <Button size="sm" variant="outline" onClick={() => setCounting(true)}>
            <Calculator className="mr-1.5 h-3.5 w-3.5" /> Count cash
          </Button>
        )}
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
              <th className="w-20 px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {/* Stated as a row of its own, the way the sheet states it, so the
                first balance in the column has something to follow from. */}
            {page === 1 && (
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
                    {canWrite && tx.matches.length === 0 && (
                      <button
                        type="button"
                        onClick={() => setLinking(tx)}
                        className="mr-2 text-foreground-subtle hover:text-primary"
                        aria-label={`Link ${tx.description} to a document`}
                      >
                        <Link2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {canWrite && !tx.isReconciled && (
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

          {canWrite && (
            <tfoot>
              <tr className="border-t-2 border-border bg-surface-muted/30">
                <td className="px-3 py-2">
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="h-8"
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    value={description}
                    placeholder="What was it for?"
                    maxLength={200}
                    onChange={(e) => setDescription(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void addRow())}
                    className="h-8"
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={inAmount}
                    placeholder="In"
                    onChange={(e) => setInAmount(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void addRow())}
                    className="h-8 text-right"
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={outAmount}
                    placeholder="Out"
                    onChange={(e) => setOutAmount(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void addRow())}
                    className="h-8 text-right"
                  />
                </td>
                <td className="px-3 py-2 text-right text-xs text-foreground-muted">
                  {bothSides ? (
                    <span className="text-danger">One side only</span>
                  ) : (
                    formatMoney(
                      account.currentBalanceMinor + (inMinor > 0 ? inMinor : -outMinor),
                      account.currency,
                    )
                  )}
                </td>
                <td className="px-2 py-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={create.isPending}
                    disabled={!canSubmit}
                    onClick={addRow}
                    aria-label="Add entry"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <CashCountDialog account={account} open={counting} onClose={() => setCounting(false)} />

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
