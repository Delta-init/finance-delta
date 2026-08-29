"use client";

import { useRef, useState } from "react";
import { Paperclip, Upload, Trash2, FileText, ImageIcon } from "lucide-react";
import type { Expense } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAddExpenseAttachment, useRemoveExpenseAttachment } from "./api";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,application/pdf";

function readableSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ExpenseReceipts({
  expense,
  /**
   * Whether this claim can still take receipts. Once it is with an approver
   * the server refuses, so offering the control would be a button that only
   * ever produces an error.
   */
  editable,
}: {
  expense: Expense;
  editable: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const add = useAddExpenseAttachment(expense.id);
  const remove = useRemoveExpenseAttachment(expense.id);

  const attachments = expense.attachments ?? [];
  const full = attachments.length >= MAX_FILES;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Let the same file be chosen again after a failure.
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;

    // Checked here as well as on the server, so somebody who picked a 40 MB
    // photo is told before waiting for the whole thing to upload.
    if (file.size > MAX_BYTES) {
      toast.error(`${file.name} is ${readableSize(file.size)} — the limit is 10 MB`);
      return;
    }
    setBusy(true);
    try {
      await add.mutateAsync(file);
      toast.success("Receipt added");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not upload that file");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(key: string | undefined, name: string) {
    if (!key) {
      // Rows that predate storage keys cannot be removed, because there is
      // nothing recorded to delete from the bucket.
      toast.error("This attachment was added before receipts could be removed");
      return;
    }
    try {
      await remove.mutateAsync(key);
      toast.success(`Removed ${name}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove that receipt");
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <Paperclip className="h-4 w-4 text-foreground-muted" />
        <h2 className="text-sm font-semibold">Receipts</h2>
        {attachments.length > 0 && (
          <span className="text-xs text-foreground-muted">
            {attachments.length} of {MAX_FILES}
          </span>
        )}
        {editable && (
          <div className="ml-auto">
            <Tooltip label={full ? `A claim can hold at most ${MAX_FILES} receipts` : "JPG, PNG, WebP, GIF or PDF, up to 10 MB"}>
              <span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || full}
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" /> {busy ? "Uploading…" : "Add receipt"}
                </Button>
              </span>
            </Tooltip>
            <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={onPick} />
          </div>
        )}
      </div>

      {attachments.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          {editable
            ? "No receipts yet. Attach the proof of purchase — JPG, PNG, WebP, GIF or PDF, up to 10 MB."
            : "No receipts were attached to this claim."}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {attachments.map((att, i) => {
            const isPdf = att.mimeType === "application/pdf" || att.name.toLowerCase().endsWith(".pdf");
            return (
              <li key={att.key ?? i} className="flex items-center gap-3 py-2.5 text-sm">
                {isPdf ? (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
                ) : (
                  <ImageIcon className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
                )}
                <span className="flex-1 truncate font-medium">{att.name}</span>
                {att.size ? (
                  <span className="shrink-0 text-xs text-foreground-muted">{readableSize(att.size)}</span>
                ) : null}
                <a
                  href={att.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs text-primary hover:underline"
                >
                  Open →
                </a>
                {editable && (
                  <Tooltip label="Remove this receipt">
                    <button
                      type="button"
                      onClick={() => onRemove(att.key, att.name)}
                      disabled={remove.isPending}
                      aria-label={`Remove ${att.name}`}
                      className="shrink-0 rounded p-1 text-foreground-muted hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
