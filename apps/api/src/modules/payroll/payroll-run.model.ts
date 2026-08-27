import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * One month's payroll, imported from HRMS and paid from here.
 *
 * Not a Bill. Payroll is not a vendor invoice, and forcing it through the bill
 * module would mean inventing a "Payroll" vendor that then pollutes every
 * vendor report, ageing and statement. It borrows the bill module's *shapes* —
 * embedded payments, amountPaid/balance, a partially_paid status — so that
 * banking and reconciliation behave the same way, without borrowing its
 * meaning.
 *
 * Every amount is in integer minor units, like the rest of this codebase.
 * HRMS speaks in two-decimal floats, so the conversion happens once, at import,
 * and is checked: the sum of the lines must equal the total to the fils, or the
 * import is refused rather than absorbing a rounding drift into somebody's pay.
 */

const lineItemSchema = new Schema(
  { label: { type: String, required: true }, amountMinor: { type: Number, required: true } },
  { _id: false },
);

const payrollLineSchema = new Schema(
  {
    // Provenance, so a line can always be traced back to the payslip it came
    // from even after HRMS has moved on.
    hrmsPayslipId: { type: String, required: true },
    hrmsEmployeeId: { type: String, required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "Employee", default: null },

    employeeCode: { type: String, required: true },
    name: { type: String, required: true },
    designation: { type: String, default: "" },
    departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    departmentName: { type: String, default: "" },

    earnings: { type: [lineItemSchema], default: [] },
    deductions: { type: [lineItemSchema], default: [] },
    grossMinor: { type: Number, required: true },
    deductionsMinor: { type: Number, required: true },
    /** Net as HRMS calculated it. Never edited here — it is their number. */
    netFromHrmsMinor: { type: Number, required: true },

    /** Signed total of this run's own additions and deductions. Phase 3 fills it. */
    adjustmentsMinor: { type: Number, default: 0 },
    /** netFromHrms + adjustments. What this person is actually owed. */
    payableMinor: { type: Number, required: true },

    amountPaidMinor: { type: Number, default: 0 },

    bank: {
      iban: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      bankName: { type: String, default: "" },
      nameInBank: { type: String, default: "" },
    },
    /** False when there is nowhere to send the money. Set at import from HRMS. */
    payable: { type: Boolean, default: true },

    status: {
      type: String,
      enum: ["pending", "on_hold", "partially_paid", "paid"],
      default: "pending",
    },
    holdReason: { type: String, default: "" },
  },
  { _id: true },
);

/**
 * An accounts-side addition or deduction on one person's pay.
 *
 * `externalId` is generated here and is what makes the write-back to HRMS
 * idempotent: a retry after a timeout updates the row it created last time
 * rather than paying somebody twice.
 *
 * `recoveredMinor` is not decoration. HRMS only recovers what a month can
 * afford, so a deduction of 2,000 against a take-home of 1,400 recovers 1,400
 * and carries 600 to next month. Storing what was asked for without storing
 * what happened would have accounts booking a recovery that did not occur.
 */
const payrollAdjustmentSchema = new Schema(
  {
    externalId: { type: String, required: true },
    hrmsEmployeeId: { type: String, required: true },
    lineId: { type: Schema.Types.ObjectId, required: true },

    kind: { type: String, enum: ["addition", "deduction"], required: true },
    source: { type: String, enum: ["commission", "manual"], required: true },
    label: { type: String, required: true },
    amountMinor: { type: Number, required: true },
    notes: { type: String, default: "" },

    /** The commission records this addition pays off, if it came from them. */
    commissionRecordIds: { type: [Schema.Types.ObjectId], default: [] },

    /** What HRMS actually took. Equal to amountMinor for an addition. */
    recoveredMinor: { type: Number, default: 0 },
    /** Still owed after this month; only ever non-zero for a deduction. */
    outstandingMinor: { type: Number, default: 0 },

    syncedAt: { type: Date, default: null },
    createdById: { type: Schema.Types.ObjectId, ref: "User" },
    createdByName: { type: String, default: "" },
  },
  { _id: true, timestamps: { createdAt: true, updatedAt: false } },
);

const payrollRunSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    // Which HRMS organization this month came from. Carried because several
    // may feed one book, and "March" alone would then be ambiguous.
    hrmsOrgId: { type: String, required: true },
    hrmsOrgName: { type: String, default: "" },

    runNumber: { type: String, required: true },
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    currency: { type: String, default: "AED" },

    status: {
      type: String,
      enum: ["imported", "additions", "approved", "partially_paid", "paid", "returned", "voided"],
      default: "imported",
    },

    lines: { type: [payrollLineSchema], default: [] },
    adjustments: { type: [payrollAdjustmentSchema], default: [] },

    // Totals as HRMS handed them over, kept apart from the running totals so a
    // later phase's additions never overwrite what was originally agreed.
    hrmsGrossMinor: { type: Number, default: 0 },
    hrmsDeductionsMinor: { type: Number, default: 0 },
    hrmsNetMinor: { type: Number, default: 0 },

    adjustmentsMinor: { type: Number, default: 0 },
    payableMinor: { type: Number, default: 0 },
    amountPaidMinor: { type: Number, default: 0 },
    balanceMinor: { type: Number, default: 0 },

    importedById: { type: Schema.Types.ObjectId, ref: "User" },
    importedByName: { type: String, default: "" },
    importedAt: { type: Date, default: Date.now },
    approvedById: { type: Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    paidAt: { type: Date },
    returnedReason: { type: String, default: "" },

    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

// One run per HRMS organization per period. Scoped by hrmsOrgId rather than by
// period alone, because two HRMS entities paying out of one book both have a
// March and neither should block the other.
payrollRunSchema.index({ organizationId: 1, hrmsOrgId: 1, period: 1 }, { unique: true });
payrollRunSchema.index({ organizationId: 1, runNumber: 1 }, { unique: true });
payrollRunSchema.index({ organizationId: 1, status: 1 });

export type PayrollRunDoc = InferSchemaType<typeof payrollRunSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const PayrollRun = model("PayrollRun", payrollRunSchema);
