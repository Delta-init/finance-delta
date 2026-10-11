import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * The queue of fee updates waiting to reach Tetra Commission — one row per
 * invoice whose student went there (the user, 2026-10-11).
 *
 * One row, not one per change: each change replaces the payload with the
 * whole picture as it is now and puts the row back to pending, so only the
 * newest is ever sent and a burst of edits is one call. `queuedAt` is what a
 * send compares before marking the row delivered — a change made while a send
 * was on its way leaves it pending for the next pass.
 *
 * pending    waiting (nextAttemptAt says when)
 * sending    being sent right now (claimedAt says since when)
 * delivered  Tetra Commission has the latest
 * stopped    Tetra Commission has no student or course fee for this invoice
 *            (404 UNKNOWN_INVOICE) — not tried again until the next change
 * failed     refused as malformed — not tried again until the next change
 */
const commissionFeeUpdateSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true, unique: true },
    invoiceNumber: { type: String, default: "" },
    payload: { type: Schema.Types.Mixed, required: true },
    /** Why it was queued last: "payment", "approval", "void", … — for whoever reads the row. */
    reason: { type: String, default: "" },
    state: { type: String, enum: ["pending", "sending", "delivered", "stopped", "failed"], default: "pending", index: true },
    queuedAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    claimedAt: { type: Date },
    lastError: { type: String },
    deliveredAt: { type: Date },
  },
  { timestamps: true },
);
commissionFeeUpdateSchema.index({ state: 1, nextAttemptAt: 1 });

export type CommissionFeeUpdateDoc = InferSchemaType<typeof commissionFeeUpdateSchema> & { _id: Types.ObjectId };
export const CommissionFeeUpdateModel = model("CommissionFeeUpdate", commissionFeeUpdateSchema);
