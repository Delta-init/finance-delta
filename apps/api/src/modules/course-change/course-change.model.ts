import { Schema, model, type InferSchemaType, type Types } from "mongoose";

/**
 * A finance-approved enrolment moved to another course, asked for in the sales
 * CRM that closed it (the user, 2026-11-23), with the new fee and why, waiting
 * for accounts. Approved, the invoice line becomes the new course at the new
 * fee, the enrolment says it and the LMS opens what it adds; the CRM reads its
 * state back with the enrolment's status. Unique on the CRM's own id, so a
 * retry is the same request; one waiting per invoice at a time.
 */
const courseChangeSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    /** The CRM's intake source (crm, draw-crm, banglore-crm) and its id for this request. */
    source: { type: String, required: true },
    externalId: { type: String, required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true },
    invoiceNumber: { type: String, default: "" },
    customerName: { type: String, default: "" },
    /** What it was when asked for: the enrolment's course and the invoice total. */
    fromCourse: { type: String, default: "" },
    fromPriceMinor: { type: Number, default: 0 },
    /** The new course, as the CRM's close sends one. */
    course: {
      name: { type: String, required: true },
      itemId: { type: String },
      hsnSac: { type: String },
      lmsCourseSlug: { type: String },
      lmsCourseSlugs: { type: [String], default: undefined },
    },
    priceMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true },
    reason: { type: String, default: "" },
    requestedBy: { name: { type: String, default: "" }, email: { type: String, default: "" } },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
    decision: {
      type: new Schema({
        decidedById: { type: Schema.Types.ObjectId, ref: "User" },
        decidedByName: { type: String, default: "" },
        decidedAt: { type: Date },
        reason: { type: String },
        note: { type: String },
      }, { _id: false }),
      default: undefined,
    },
    /** When the invoice, the enrolment and the LMS were changed. */
    appliedAt: { type: Date },
  },
  { timestamps: true },
);

courseChangeSchema.index({ organizationId: 1, source: 1, externalId: 1 }, { unique: true });
// Each enrolment's, oldest first, for the CRM reading its status.
courseChangeSchema.index({ invoiceId: 1, createdAt: 1 });
// One waiting per invoice: a second, even sent at the same moment, is refused rather than queued behind it.
courseChangeSchema.index({ invoiceId: 1 }, { unique: true, partialFilterExpression: { status: "pending" }, name: "one_pending_per_invoice" });

export type CourseChangeDoc = InferSchemaType<typeof courseChangeSchema> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
export const CourseChangeModel = model("CourseChange", courseChangeSchema);
