"use client";

import { useState } from "react";
import { Plus, Minus, Users } from "lucide-react";
import { toMinor, formatMoney } from "@delta/shared";
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
 * Adding the same item to one person or to many.
 *
 * One dialog for both, because they are the same decision: a label, an amount,
 * and who it applies to. A separate bulk dialog would be the same four fields
 * with a different heading, and the two would drift.
 *
 * The amount is typed in whole currency and converted once, on submit —
 * through `toMinor`, which builds the figure from the digits rather than
 * multiplying by a hundred. Applied across sixty people, a fil lost per head
 * is a payroll that does not reconcile.
 */
export function AdjustDialog({
  lines, currency, open, onOpenChange, onSubmit, pending,
}: {
  /** Who this applies to. One entry is the ordinary case; many is a bulk apply. */
  lines: RunLine[];
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (items: NewAdjustment[]) => void;
  pending: boolean;
}) {
  const [kind, setKind] = useState<"addition" | "deduction">("addition");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");

  const bulk = lines.length > 1;
  const minorEach = toMinor(amount);
  const valid = label.trim().length > 0 && minorEach > 0 && lines.length > 0;

  function reset() {
    setKind("addition"); setLabel(""); setAmount(""); setNotes("");
  }

  const verb = kind === "addition" ? "Add to" : "Deduct from";
  const title = bulk ? `${verb} ${lines.length} people` : `${verb} ${lines[0]?.name ?? ""}`;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            This is written straight through to the payslip in HRMS, so what the employee sees matches
            what is paid.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Who it lands on, spelled out. The amount is per person, and the
              difference between that and a total split between them is the
              kind of thing worth being unambiguous about before it is written
              to sixty payslips. */}
          {bulk && (
            <div className="rounded-lg border border-border bg-surface-muted/40 p-2.5 text-xs">
              <p className="flex items-center gap-1.5 font-medium">
                <Users className="h-3.5 w-3.5" /> {lines.length} people selected
              </p>
              <p className="mt-1 text-foreground-muted">
                {lines.slice(0, 3).map((l) => l.name).join(", ")}
                {lines.length > 3 ? ` and ${lines.length - 3} more` : ""}
              </p>
            </div>
          )}

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
            <Label htmlFor="adj-amount">
              Amount ({currency}) {bulk && <span className="text-foreground-muted">— each</span>}
            </Label>
            <Input
              id="adj-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
            {bulk && minorEach > 0 && (
              <p className="text-xs text-foreground-muted">
                {formatMoney(minorEach, currency)} each · {formatMoney(minorEach * lines.length, currency)}{" "}
                {kind === "addition" ? "added" : "deducted"} in total
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="adj-notes">Notes (optional)</Label>
            <Input id="adj-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
          </div>

          {kind === "deduction" && (
            <p className="rounded-lg border border-warning/20 bg-warning/5 p-2.5 text-xs">
              A deduction larger than {bulk ? "somebody's" : "this month's"} take-home is collected over
              several months rather than driving the payslip negative. You will be told exactly how much
              was recovered.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            loading={pending}
            disabled={!valid}
            onClick={() => {
              if (!valid) return;
              // One item per person, which is what the endpoint takes. The
              // amount is converted once and reused, so everybody gets the
              // same figure rather than the same string parsed repeatedly.
              onSubmit(
                lines.map((l) => ({
                  lineId: l.id,
                  kind,
                  label: label.trim(),
                  amountMinor: minorEach,
                  notes: notes.trim() || undefined,
                })),
              );
              reset();
            }}
          >
            {kind === "addition" ? <Plus className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
            {kind === "addition" ? "Add" : "Deduct"}
            {bulk ? ` for ${lines.length}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
