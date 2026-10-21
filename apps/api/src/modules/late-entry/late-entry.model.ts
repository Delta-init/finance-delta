import { Schema, model, type Types } from "mongoose";
import { LATE_ENTRY_KINDS, LATE_ENTRY_STATES } from "@delta/shared";

/**
 * Something typed in late, and what a manager made of it (the user, 2026-10-17 — see late-entry.service.ts). Kept
 * after the record it was about has gone (a rejected payment is removed): this is the history of who asked, why, and
 * who decided.
 */
const lateEntrySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    kind: { type: String, enum: LATE_ENTRY_KINDS, required: true },
    /** The expense, the bill, or the invoice — and the payment on it, for a payment. */
    refId: { type: Schema.Types.ObjectId, required: true },
    paymentId: { type: Schema.Types.ObjectId, default: null },
    /** A bank / cash line's account, for its link (2026-10-21). */
    accountId: { type: Schema.Types.ObjectId, default: null },
    number: { type: String, default: "" },
    title: { type: String, default: "" },
    amountMinor: { type: Number, default: 0 },
    currency: { type: String, default: "AED" },
    /** The date that made it late; the one it had before, when an edit moved it there (rejecting puts it back). */
    date: { type: Date, required: true },
    previousDate: { type: Date, default: null },
    reason: { type: String, required: true },
    state: { type: String, enum: LATE_ENTRY_STATES, default: "pending" },
    enteredById: { type: Schema.Types.ObjectId, ref: "User", required: true },
    enteredByName: { type: String, default: "" },
    decidedById: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedByName: { type: String, default: "" },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: "" },
  },
  { timestamps: true },
);

lateEntrySchema.index({ organizationId: 1, state: 1, createdAt: -1 });
lateEntrySchema.index({ organizationId: 1, refId: 1, paymentId: 1, state: 1 });

export const LateEntryModel = model("LateEntry", lateEntrySchema);

/** What a record keeps of its own late entry — on an expense, a bill, and a payment on a bill or an invoice. */
export const recordLateSchema = new Schema(
  {
    state: { type: String, enum: LATE_ENTRY_STATES, required: true },
    entryId: { type: Schema.Types.ObjectId, required: true },
    reason: { type: String, default: "" },
    enteredByName: { type: String, default: "" },
    decidedByName: { type: String, default: "" },
    decisionNote: { type: String, default: "" },
  },
  { _id: false },
);

export interface RecordLate {
  state: (typeof LATE_ENTRY_STATES)[number];
  entryId: Types.ObjectId;
  reason: string;
  enteredByName: string;
  decidedByName?: string;
  decisionNote?: string;
}

/** As a record's DTO shows it. */
export function lateView(v: unknown): { state: RecordLate["state"]; reason: string; enteredByName: string; decidedByName?: string; decisionNote?: string } | undefined {
  const l = v as RecordLate | null | undefined;
  if (!l?.state) return undefined;
  return {
    state: l.state, reason: l.reason ?? "", enteredByName: l.enteredByName ?? "",
    ...(l.decidedByName ? { decidedByName: l.decidedByName } : {}),
    ...(l.decisionNote ? { decisionNote: l.decisionNote } : {}),
  };
}

export const isLatePending = (v: unknown) => (v as RecordLate | null | undefined)?.state === "pending";
