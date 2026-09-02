"use client";

import { useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import type { BankAccount, BankTransaction } from "@delta/shared";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import {
  useAddTransactionAttachment,
  useRemoveTransactionAttachment,
} from "@/features/banking/api";

const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;

const prettySize = (b?: number) =>
  b === undefined ? "" : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`;

/**
 * The paper behind one cash book entry.
 *
 * A tin runs on vouchers and till slips, and an entry saying "Office supplies —
 * 55" is worth much less at a count than the same entry with the slip attached.
 */
export function EntryReceipts({
  account,
  tx,
  open,
  onClose,
}: {
  account: BankAccount;
  tx: BankTransaction;
  open: boolean;
  onClose: () => void;
}) {
  const { can } = useCan();
  const canWrite = can("banking:write");
  const add = useAddTransactionAttachment(account.id, tx.id);
  const remove = useRemoveTransactionAttachment(account.id, tx.id);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const files = tx.attachments ?? [];

  async function upload(picked: File[]) {
    const tooBig = picked.filter((f) => f.size > MAX_BYTES);
    if (tooBig.length > 0) {
      toast.error(`${tooBig.map((f) => f.name).join(", ")} — over ${prettySize(MAX_BYTES)}.`);
    }
    const queue = picked.filter((f) => f.size <= MAX_BYTES).slice(0, MAX_FILES - files.length);
    if (queue.length === 0) return;

    setBusy(true);
    try {
      // One at a time, so a rejected file names itself.
      for (const file of queue) {
        try {
          await add.mutateAsync(file);
        } catch (e) {
          toast.error(`${file.name}: ${e instanceof ApiError ? e.message : "could not be uploaded"}`);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Paperclip className="h-4 w-4 text-foreground-muted" /> Receipts
          </DialogTitle>
          <DialogDescription>
            {tx.description} — {tx.date.slice(0, 10)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {files.length === 0 ? (
            <p className="text-sm text-foreground-muted">
              Nothing attached. A voucher, a till slip or a photo of a signed chit belongs here.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {files.map((f) => (
                <li key={f.key ?? f.url} className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                  <Paperclip className="h-4 w-4 shrink-0 text-foreground-muted" />
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 flex-1 truncate text-sm hover:underline"
                    title={f.name}
                  >
                    {f.name}
                  </a>
                  <span className="shrink-0 text-xs text-foreground-muted">{prettySize(f.size)}</span>
                  {canWrite && f.key && (
                    <button
                      type="button"
                      disabled={remove.isPending}
                      onClick={async () => {
                        try {
                          await remove.mutateAsync(f.key!);
                          toast.success("Receipt removed");
                        } catch (e) {
                          toast.error(e instanceof ApiError ? e.message : "Could not remove it");
                        }
                      }}
                      className="shrink-0 text-foreground-subtle hover:text-danger disabled:opacity-50"
                      aria-label={`Remove ${f.name}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canWrite && files.length < MAX_FILES && (
            <>
              <Button size="sm" variant="outline" loading={busy} onClick={() => input.current?.click()}>
                <Paperclip className="mr-1.5 h-3.5 w-3.5" /> Attach
              </Button>
              <input
                ref={input}
                type="file"
                multiple
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }}
              />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
