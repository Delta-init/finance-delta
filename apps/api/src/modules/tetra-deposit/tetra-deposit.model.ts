import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * A deposit request from Tetra Commission, waiting for — or given — an
 * accountant's decision. See @delta/shared tetra-deposit.schema for the flow.
 *
 * The decision is sent back to Tetra Commission; `delivery` is where that got
 * to, and the worker in jobs/tetra-deposit.worker.ts keeps trying until it
 * arrives. `events` is the record of who did what to it here.
 */
const tetraDepositSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  /** The funding request's id in Tetra Commission. */
  externalId: { type: String, required: true },
  status: { type: String, enum: ["pending", "approved", "rejected", "closed"], default: "pending", index: true },
  /** A deposit, or a bonus — a course payment, whose approval here is the first of two (@delta/shared). */
  type: { type: String, enum: ["DEPOSIT", "BONUS"], default: "DEPOSIT", index: true },
  /** The amount as typed in Tetra Commission, when another currency (AED). */
  amountOriginal: { type: Number },
  amountCurrency: { type: String, uppercase: true },
  /** A bonus's course payment, as Tetra Commission worked it out. */
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
    }, { _id: false }),
    default: undefined,
  },
  /** As requested; an approval may settle on another amount (decision.approvedAmountMinor). */
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true, uppercase: true, default: "USD" },
  student: {
    id: { type: String, default: "" },
    code: { type: String, default: "" },
    name: { type: String, required: true },
    email: { type: String, default: "" },
    level: { type: String, default: "" },
  },
  team: { type: String, default: "" },
  paymentMethod: { type: String, default: "" },
  mt5Login: { type: String, default: "" },
  mt5Accounts: [{ _id: false, login: { type: String, required: true }, platform: { type: String, default: "" } }],
  screenshotUrl: { type: String, default: "" },
  notes: { type: String, default: "" },
  requestedAt: { type: Date },
  requestedBy: { type: String, default: "" },
  initiatingMentor: { type: String, default: "" },
  primaryMentor: { type: String, default: "" },
  meetingMentor: { type: String, default: "" },
  decision: {
    approvedAmountMinor: { type: Number },
    transactionId: { type: String },
    paymentMethod: { type: String },
    mt5Login: { type: String },
    note: { type: String },
    reason: { type: String },
    decidedById: { type: Schema.Types.ObjectId, ref: "User" },
    decidedByName: { type: String },
    decidedByEmail: { type: String },
    decidedAt: { type: Date },
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
  events: [{
    _id: false,
    at: { type: Date, required: true },
    kind: { type: String, required: true },
    byName: { type: String, default: "" },
    text: { type: String, default: "" },
  }],
}, { timestamps: true });

// One row per Tetra Commission request, however many times it is handed over.
tetraDepositSchema.index({ organizationId: 1, externalId: 1 }, { unique: true });
tetraDepositSchema.index({ "delivery.state": 1, "delivery.nextAttemptAt": 1 });

export type TetraDepositDoc = InferSchemaType<typeof tetraDepositSchema> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
export const TetraDepositModel = model("TetraDeposit", tetraDepositSchema);
