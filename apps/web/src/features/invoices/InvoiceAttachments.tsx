"use client";

import { useRef, useState } from "react";
import { Paperclip, FileText, ImageIcon, X, Download } from "lucide-react";
import { approvalBlocksEditing, type Invoice } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { useAddInvoiceAttachment, useRemoveInvoiceAttachment } from "@/features/invoices/api";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const prettySize = (bytes?: number) =>
  bytes === undefined
    ? ""
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * The documents behind an enrolment — an ID, a signed form, a payment slip.
 *
 * Shown on every invoice that has any, and addable while it is still somebody's
 * to change. The server is the one that decides that: it refuses once the
 * invoice is with an approver, because the evidence it is being approved
 * against should not move underneath them.
 */
export function InvoiceAttachments({ invoice }: { invoice: Invoice }) {
  const { can } = useCan();
  const add = useAddInvoiceAttachment(invoice.id);
  const remove = useRemoveInvoiceAttachment(invoice.id);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const files = invoice.attachments ?? [];
  const canEdit = can("invoice:write") || can("invoice:write:own");
  // Matches the server's rule, so the control is absent rather than offering
  // something that would only produce a refusal. Approved counts as locked too:
  // the documents an invoice was approved against should not move afterwards.
  const state = invoice.approval?.state;
  const locked = !can("invoice:write") && approvalBlocksEditing(state);
  const canAdd = canEdit && !locked && files.length < MAX_FILES;

  if (files.length === 0 && !canAdd) return null;

  async function upload(picked: File[]) {
    const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES);
    if (tooBig.length > 0) {
      toast.error(`${tooBig.map((f) => f.name).join(", ")} — over ${prettySize(MAX_FILE_BYTES)}.`);
    }
    const room = MAX_FILES - files.length;
    const queue = picked.filter((f) => f.size <= MAX_FILE_BYTES).slice(0, room);
    if (queue.length === 0) return;

    setBusy(true);
    try {
      // One at a time so a rejected file can name itself.
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
    <div className="space-y-3 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Paperclip className="h-4 w-4 text-foreground-muted" />
        <h2 className="text-sm font-semibold">Documents</h2>
        {files.length > 0 && (
          <span className="text-xs text-foreground-muted">
            {files.length} of {MAX_FILES}
          </span>
        )}
        {canAdd && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            loading={busy}
            onClick={() => input.current?.click()}
          >
            <Paperclip className="mr-1.5 h-3.5 w-3.5" /> Add
          </Button>
        )}
        <input
          ref={input}
          type="file"
          multiple
          accept="image/*,application/pdf,.doc,.docx"
          className="hidden"
          onChange={(e) => {
            void upload(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>

      {locked && files.length > 0 && (
        <p className="text-xs text-foreground-muted">
          {state === "approved"
            ? "Approved, so these can no longer be changed. Ask accounts for a correction."
            : "With an approver, so these cannot be changed until it comes back."}
        </p>
      )}

      {files.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          Nothing attached. An ID, a signed form or a payment slip belongs here.
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {files.map((f) => {
            const isImage = (f.mimeType ?? "").startsWith("image/");
            return (
              <li
                key={f.key ?? f.url}
                className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                {isImage ? (
                  <ImageIcon className="h-4 w-4 shrink-0 text-foreground-muted" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-foreground-muted" />
                )}
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-sm hover:underline"
                  title={f.name}
                >
                  {f.name}
                </a>
                {f.size !== undefined && (
                  <span className="shrink-0 text-xs text-foreground-muted">{prettySize(f.size)}</span>
                )}
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-foreground-subtle hover:text-foreground"
                  aria-label={`Open ${f.name}`}
                >
                  <Download className="h-4 w-4" />
                </a>
                {canEdit && !locked && f.key && (
                  <button
                    type="button"
                    disabled={remove.isPending}
                    onClick={async () => {
                      try {
                        await remove.mutateAsync(f.key!);
                        toast.success("Document removed");
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
            );
          })}
        </ul>
      )}
    </div>
  );
}
