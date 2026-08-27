"use client";

import { useState } from "react";
import { Plus, Minus } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { NewAdjustment } from "./api";
import type { RunLine } from "./types";

/**
 * Adding one item to one person.
 *
 * The amount is typed in whole currency and converted on submit, because
 * nobody types fils — but it is converted here, once, rather than being carried
 * as a float any further into the system.
 */
export function AdjustDialog({
  line, currency, open, onOpenChange, onSubmit, pending,
}: {
  line: RunLine | null;
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (item: NewAdjustment) => void;
  pending: boolean;
}) {
  const [kind, setKind] = useState<"addition" | "deduction">("addition");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");

  const parsed = Number(amount);
  const valid = label.trim().length > 0 && Number.isFinite(parsed) && parsed > 0;

  function reset() {
    setKind("addition"); setLabel(""); setAmount(""); setNotes("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{kind === "addition" ? "Add to" : "Deduct from"} {line?.name}</DialogTitle>
          <DialogDescription>
            This is written straight through to the payslip in HRMS, so what the employee sees matches
            what is paid.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as "addition" | "deduction")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="addition">Addition — pay extra</SelectItem>
                <SelectItem value="deduction">Deduction — take off</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="adj-label">What is it for?</Label>
            <Input
              id="adj-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={kind === "addition" ? "Performance bonus" : "Advance recovery"}
              maxLength={80}
            />
            <p className="text-xs text-foreground-muted">This wording appears on the payslip.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="adj-amount">Amount ({currency})</Label>
            <Input
              id="adj-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="adj-notes">Notes (optional)</Label>
            <Input id="adj-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
          </div>

          {kind === "deduction" && (
            <p className="rounded-lg border border-warning/20 bg-warning/5 p-2.5 text-xs">
              A deduction larger than this month&rsquo;s take-home is collected over several months rather
              than driving the payslip negative. You will be told exactly how much was recovered.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            loading={pending}
            disabled={!valid || !line}
            onClick={() => {
              if (!line) return;
              onSubmit({
                lineId: line.id,
                kind,
                label: label.trim(),
                // Converted here, once. Nothing downstream sees a decimal.
                amountMinor: Math.round(parsed * 100),
                notes: notes.trim() || undefined,
              });
              reset();
            }}
          >
            {kind === "addition" ? <Plus className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
            {kind === "addition" ? "Add" : "Deduct"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
