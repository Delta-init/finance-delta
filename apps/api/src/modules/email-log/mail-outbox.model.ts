import { Schema, model } from "mongoose";

/**
 * An email that could not go for a reason that passes — the mail server's "try again later" (2026-11-18: Gmail's
 * "454 4.7.0 Too many login attempts") — waiting to be sent again by lib/email.ts retryQueuedEmails. Unlike the email
 * log it holds the message itself, and only until it goes or is given up on: the row is deleted then, and anything
 * left is gone after two days.
 */
const mailOutboxSchema = new Schema(
  {
    /** Its email log entry — "Trying again" until this row is done with. */
    logId: { type: Schema.Types.ObjectId, required: true },
    to: { type: [String], default: [] },
    subject: { type: String, default: "" },
    html: { type: String, default: "" },
    attachments: { type: [{ filename: String, content: Buffer, contentType: String, _id: false }], default: [] },
    /** Tries so far, the first included. */
    attempts: { type: Number, default: 1 },
    nextAt: { type: Date, required: true },
    lastError: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

mailOutboxSchema.index({ nextAt: 1 });
mailOutboxSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 24 * 3600 });

export const MailOutbox = model("MailOutbox", mailOutboxSchema);
