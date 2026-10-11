import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * One client reminder of a partial enrolment's next instalment — claimed
 * before it is sent, so nobody is reminded twice (the user, 2026-10-11).
 *
 * Unique on (invoice, due date, days before): a second pass, a second process
 * or a restart finds the claim and moves on. A new due date — another payment
 * restarts the 29 days — is a new key, so its own 3, 2 and 1 come round.
 *
 * claimed    being sent now
 * sent       it went (the email log has it, kind instalment_reminder)
 * failed     the transport would not take it — not tried again
 * skipped    nothing to remind of by the time it was sent (paid, void …)
 */
const instalmentReminderSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true },
    invoiceNumber: { type: String, default: "" },
    /** The due date reminded of, "YYYY-MM-DD". */
    dueOn: { type: String, required: true },
    daysBefore: { type: Number, required: true },
    state: { type: String, enum: ["claimed", "sent", "failed", "skipped"], default: "claimed" },
    to: { type: String, default: "" },
    balanceMinor: { type: Number },
    currency: { type: String },
    reason: { type: String },
    claimedAt: { type: Date, required: true },
    sentAt: { type: Date },
  },
  { timestamps: true },
);
instalmentReminderSchema.index({ invoiceId: 1, dueOn: 1, daysBefore: 1 }, { unique: true });

export type InstalmentReminderDoc = InferSchemaType<typeof instalmentReminderSchema> & { _id: Types.ObjectId };
export const InstalmentReminder = model("InstalmentReminder", instalmentReminderSchema);
