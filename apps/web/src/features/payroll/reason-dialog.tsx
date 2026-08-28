"use client";

import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

/**
 * Asks for a reason before doing something that needs explaining later.
 *
 * Replaces window.prompt, which was doing this job in two places. A native
 * prompt cannot be styled, cannot be cancelled by clicking away, blocks the
 * page while it is open, and looks nothing like the rest of the application —
 * which matters most exactly here, on the two actions that move a payroll
 * backwards and will be read in an audit trail afterwards.
 */
export function ReasonDialog({
  open, onOpenChange, title, description, label, placeholder, confirmLabel,
  destructive = false, pending = false, onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  placeholder?: string;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");

  // Cleared on open rather than on close, so the box is never briefly showing
  // the previous answer as the dialog fades out.
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const trimmed = reason.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="reason-input">{label}</Label>
          <Input
            id="reason-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={placeholder}
            maxLength={300}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && trimmed && !pending) onConfirm(trimmed);
            }}
          />
          <p className="text-xs text-foreground-muted">
            This is recorded against the payroll and is what the other side will read.
          </p>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            loading={pending}
            disabled={!trimmed}
            onClick={() => onConfirm(trimmed)}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
