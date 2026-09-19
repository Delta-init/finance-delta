import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * The queue of approved enrolments waiting to reach the LMS.
 *
 * Queued rather than called during the approval, for the same reason the CRM
 * queues its handover to finance: approving an invoice is the approver's act
 * and must not fail because another system is down or slow. The approval is
 * recorded the moment they click; the student is provisioned when the LMS can
 * be reached.
 *
 * One row per invoice, which is what makes a retry safe on this side — and the
 * LMS is idempotent on the same id on the other, so neither end depends on the
 * other being careful.
 */
const lmsProvisionSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true, unique: true },
    invoiceNumber: { type: String, default: "" },

    /** What is sent, snapshotted at approval: the sale as it was agreed. */
    payload: { type: Schema.Types.Mixed, required: true },

    status: {
      type: String,
      enum: ["pending", "sent", "failed", "unmapped"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
    nextAttemptAt: { type: Date, default: Date.now, index: true },

    /** What the LMS made of it, once it took it. */
    lmsUserId: { type: String },
    lmsCourseSlug: { type: String },
    studentCreated: { type: Boolean },
    sentAt: { type: Date },
  },
  { timestamps: true },
);

export type LmsProvisionDoc = InferSchemaType<typeof lmsProvisionSchema> & {
  _id: Types.ObjectId;
};
export const LmsProvision = model("LmsProvision", lmsProvisionSchema);
