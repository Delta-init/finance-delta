import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * A deposit request from CS Portal, waiting for — or given — an
 * accountant's decision. See @delta/shared tetra-deposit.schema for the flow.
 *
 * The decision is sent back to CS Portal; `delivery` is where that got
 * to, and the worker in jobs/tetra-deposit.worker.ts keeps trying until it
 * arrives. `events` is the record of who did what to it here.
 */
const tetraDepositSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  /** The funding request's id in CS Portal. */
  externalId: { type: String, required: true },
  status: { type: String, enum: ["pending", "approved", "rejected", "closed", "deleted"], default: "pending", index: true },
  /** A deposit, or a bonus — a course payment, whose approval here is the first of two (@delta/shared). */
  type: { type: String, enum: ["DEPOSIT", "BONUS", "COURSE_UPGRADE", "ENROLMENT_PAYMENT"], default: "DEPOSIT", index: true },
  /** The amount as typed in CS Portal, when another currency (AED). */
  amountOriginal: { type: Number },
  amountCurrency: { type: String, uppercase: true },
  /** A bonus's course payment, as CS Portal worked it out. */
  coursePayment: {
    type: new Schema({
      product: { type: String, default: "" },
      kind: { type: String, default: "" },
      withBonus: { type: Boolean, default: false },
      bonusUsd: { type: Number, default: null },
      holdAed: { type: Number, default: null },
      balanceAed: { type: Number, default: null },
      paidTodayAed: { type: Number, default: null },
      paidBeforeAed: { type: Number, default: null },
      price: { type: Number, default: null },
      priceCurrency: { type: String, default: "" },
      upgradeId: { type: String, default: "" },
      paidOn: { type: String, default: "" },
      /** A Bangalore bonus's: rupees per AED of the figures above (@delta/shared). */
      inrPerAed: { type: Number, default: null },
    }, { _id: false }),
    default: undefined,
  },
  /** As requested; an approval may settle on another amount (decision.approvedAmountMinor). */
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true, uppercase: true, default: "USD" },
  /** "bangalore" for a Bangalore team's bonus, in rupees in the Bangalore organization (2026-10-15). */
  academy: { type: String, default: "" },
  student: {
    id: { type: String, default: "" },
    code: { type: String, default: "" },
    name: { type: String, required: true },
    email: { type: String, default: "" },
    level: { type: String, default: "" },
    phone: { type: String, default: "" },
  },
  team: { type: String, default: "" },
  paymentMethod: { type: String, default: "" },
  mt5Login: { type: String, default: "" },
  mt5Accounts: [{ _id: false, login: { type: String, required: true }, platform: { type: String, default: "" } }],
  screenshotUrl: { type: String, default: "" },
  /** Paid more than one way: each payment with its receipt, as CS Portal took it (@delta/shared). */
  payments: [{
    _id: false,
    method: { type: String, required: true },
    amountMinor: { type: Number, required: true },
    currency: { type: String, uppercase: true, default: "USD" },
    receiptUrl: { type: String, default: "" },
    receiptName: { type: String, default: "" },
  }],
  notes: { type: String, default: "" },
  requestedAt: { type: Date },
  requestedBy: { type: String, default: "" },
  /** Their emails in CS Portal (2026-10-30) — whose the invoice a course payment makes is (course-invoice.ts). */
  requestedByEmail: { type: String, default: "" },
  initiatingMentor: { type: String, default: "" },
  initiatingMentorEmail: { type: String, default: "" },
  primaryMentor: { type: String, default: "" },
  meetingMentor: { type: String, default: "" },
  decision: {
    approvedAmountMinor: { type: Number },
    transactionId: { type: String },
    paymentMethod: { type: String },
    mt5Login: { type: String },
    note: { type: String },
    reason: { type: String },
    /** Rejected to be corrected and sent again (the user, 2026-10-13), not refused. */
    sentBack: { type: Boolean },
    decidedById: { type: Schema.Types.ObjectId, ref: "User" },
    decidedByName: { type: String },
    decidedByEmail: { type: String },
    decidedAt: { type: Date },
  },
  /** Sent again after its earlier request was sent back or rejected: that request's id in CS Portal, and the reason. */
  resubmit: {
    type: new Schema({ of: { type: String, default: "" }, reason: { type: String, default: "" }, previousId: { type: String, default: "" } }, { _id: false }),
    default: undefined,
  },
  delivery: {
    state: { type: String, enum: ["sending", "queued", "delivered", "failed"] },
    attempts: { type: Number },
    nextAttemptAt: { type: Date },
    /** When the current send started — one stuck in "sending" past a while is taken up again. */
    claimedAt: { type: Date },
    lastError: { type: String },
    deliveredAt: { type: Date },
  },
  closedReason: { type: String },
  /**
   * A balance payment a CS recorded (type ENROLMENT_PAYMENT): the invoice it
   * pays towards — which decides the organization this row is in — how and
   * when it was paid, the receipt, who recorded it, the invoice as it stood on
   * arrival, and once approved the payment it became on the invoice.
   */
  enrolmentPayment: {
    type: new Schema({
      invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true },
      invoiceNumber: { type: String, default: "" },
      method: { type: String, default: "" },
      paidOn: { type: String, required: true },
      receiptUrl: { type: String, default: "" },
      receiptName: { type: String, default: "" },
      cs: { name: { type: String, default: "" }, email: { type: String, default: "" } },
      invoice: {
        type: new Schema({
          course: String, customerName: String, currency: String,
          totalMinor: Number, paidMinor: Number, balanceMinor: Number, dueDate: String,
        }, { _id: false }),
        default: undefined,
      },
      recorded: {
        type: new Schema({ paymentId: String, at: Date, method: String }, { _id: false }),
        default: undefined,
      },
    }, { _id: false }),
    default: undefined,
  },
  /** A course payment once approved: the invoice it went on, the payment and its receipt (course-invoice.ts). */
  courseInvoice: {
    type: new Schema({
      invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice" },
      invoiceNumber: { type: String, default: "" },
      paymentId: { type: String, default: "" },
      receiptNumber: { type: String, default: "" },
      amountMinor: { type: Number, default: 0 },
      currency: { type: String, default: "AED" },
      created: { type: Boolean, default: false },
      at: { type: Date },
      emailedAt: { type: Date },
    }, { _id: false }),
    default: undefined,
  },
  /**
   * Deleted by hand (2026-10-28): off every list and count — those ask for their own statuses — but kept, with who,
   * when, why and the status it had, so Restore can put it back.
   */
  deleted: {
    type: new Schema({
      at: { type: Date, required: true },
      byId: { type: Schema.Types.ObjectId, ref: "User" },
      byName: { type: String, default: "" },
      reason: { type: String, default: "" },
      previousStatus: { type: String, required: true },
    }, { _id: false }),
    default: undefined,
  },
  /**
   * Rejected in CS Portal after it was approved here (2026-10-31): its payment taken off ("done"), or left because a
   * bank statement was reconciled against it ("kept" — for an accountant to take off by hand).
   */
  withdrawal: {
    type: new Schema({
      at: { type: Date, required: true },
      byName: { type: String, default: "" },
      reason: { type: String, default: "" },
      state: { type: String, enum: ["done", "kept"], required: true },
      message: { type: String, default: "" },
    }, { _id: false }),
    default: undefined,
  },
  events: [{
    _id: false,
    at: { type: Date, required: true },
    kind: { type: String, required: true },
    byName: { type: String, default: "" },
    text: { type: String, default: "" },
  }],
}, { timestamps: true });

// One row per CS Portal request, however many times it is handed over.
tetraDepositSchema.index({ organizationId: 1, externalId: 1 }, { unique: true });
tetraDepositSchema.index({ "delivery.state": 1, "delivery.nextAttemptAt": 1 });

export type TetraDepositDoc = InferSchemaType<typeof tetraDepositSchema> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
export const TetraDepositModel = model("TetraDeposit", tetraDepositSchema);
