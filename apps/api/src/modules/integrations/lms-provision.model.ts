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
 * other being careful. An invoice that opens more than one course carries the
 * others in `extraCourses`, each under its own key.
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

    /** The system that raised the enrolment — "crm" (Delta's) or "draw-crm". Absent on rows from before; those were all "crm". */
    source: { type: String },

    /**
     * The other courses the same approval opens, after the first (`payload`)
     * has gone: a bundle's second course, or a second course sold on the same
     * invoice. Each sent once the student exists, under its own key
     * (`<invoice>:<course>`), because the LMS keeps one enrolment per key and
     * the invoice alone is the first course's. `accessSent` is how much of the
     * fee it was last told was paid.
     */
    extraCourses: {
      type: [{
        _id: false,
        slug: { type: String, required: true },
        status: { type: String, enum: ["pending", "sent", "failed"], default: "pending" },
        attempts: { type: Number, default: 0 },
        nextAttemptAt: { type: Date, default: Date.now },
        lastError: { type: String },
        lmsCourseTitle: { type: String },
        sentAt: { type: Date },
        accessSent: { type: String, enum: ["unpaid", "partial", "paid"] },
      }],
      default: undefined,
    },

    /** What the LMS made of it, once it took it. */
    lmsUserId: { type: String },
    lmsCourseSlug: { type: String },
    lmsCourseTitle: { type: String },
    studentCreated: { type: Boolean },
    sentAt: { type: Date },

    /**
     * How much of the fee is paid, as the LMS last acknowledged it — and the
     * newer status waiting to be sent after accounts record more of the fee.
     * The LMS opens half the modules for partial and all for paid, and only
     * ever opens, so this only ever moves up.
     */
    access: {
      sent: { type: String, enum: ["unpaid", "partial", "paid"] },
      pending: { type: String, enum: ["unpaid", "partial", "paid"] },
      attempts: { type: Number, default: 0 },
      nextAttemptAt: { type: Date },
      lastError: { type: String },
    },

    /**
     * The student, sent on to Tetra Commission once the LMS has them.
     *
     * Only set when the LMS takes the enrolment while Tetra Commission is
     * configured, so enrolments from before — and from any time it was
     * switched off — are never sent: new students only. What came back is
     * kept, including when somebody with that email was already there and so
     * was left as they were (`alreadyThere`).
     */
    commission: {
      state: { type: String, enum: ["pending", "sent", "failed"] },
      attempts: { type: Number },
      nextAttemptAt: { type: Date },
      lastError: { type: String },
      studentId: { type: String },
      studentCode: { type: String },
      alreadyThere: { type: Boolean },
      team: { type: String },
      mentorName: { type: String },
      sentAt: { type: Date },
    },
  },
  { timestamps: true },
);
lmsProvisionSchema.index({ status: 1, "access.pending": 1, "access.nextAttemptAt": 1 });
lmsProvisionSchema.index({ "commission.state": 1, "commission.nextAttemptAt": 1 });
lmsProvisionSchema.index({ status: 1, "extraCourses.status": 1, "extraCourses.nextAttemptAt": 1 });

/** The key a further course of an invoice is sent under — the LMS keeps one enrolment per key. */
export const extraCourseKey = (invoiceId: unknown, slug: string) => `${String(invoiceId)}:${slug}`;

export type LmsProvisionDoc = InferSchemaType<typeof lmsProvisionSchema> & {
  _id: Types.ObjectId;
};
export const LmsProvision = model("LmsProvision", lmsProvisionSchema);
