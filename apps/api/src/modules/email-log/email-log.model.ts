import { Schema, model, Types } from "mongoose";

/**
 * Every email this application tried to send, and what became of it (the
 * user, 2026-10-07: an email log, kept forever). Written by `deliver` in
 * lib/email.ts, so no kind of message can be left out of it.
 *
 * Holds the subject and recipients, never the body — a password-reset link
 * or an invoice's figures are not copied here.
 */
const emailLogSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, index: true },
    /** invoice, invoice_resend, invoice_approved, invoice_salesperson, reminder, notice … */
    kind: { type: String, required: true },
    to: { type: [String], default: [] },
    subject: { type: String, default: "" },
    state: { type: String, enum: ["sent", "failed", "no_address", "not_configured"], required: true },
    messageId: { type: String, default: "" },
    error: { type: String, default: "" },
    /** What it was about, where that is a record here. */
    ref: {
      type: { type: String },
      id: { type: Schema.Types.ObjectId },
      label: { type: String },
    },
    actorId: { type: Schema.Types.ObjectId },
    /** Who pressed the button; "Automatic" for reminders and notices. */
    actorName: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

emailLogSchema.index({ organizationId: 1, createdAt: -1 });
emailLogSchema.index({ "ref.id": 1, createdAt: -1 });

export const EmailLog = model("EmailLog", emailLogSchema);

/** What the sender knows about a message, for its log entry. */
export interface MailLog {
  organizationId?: string | Types.ObjectId | null;
  kind: string;
  ref?: { type: string; id: string | Types.ObjectId; label?: string };
  actorId?: string | null;
  actorName?: string;
}
