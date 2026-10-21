import { Schema, model, Types, type InferSchemaType } from "mongoose";

/** A subcategory (2026-10-21): its slug stays when renamed; `inPnl` unset follows the category. */
const subcategorySchema = new Schema(
  {
    slug: { type: String, required: true },
    name: { type: String, required: true },
    inPnl: { type: Boolean },
  },
  { _id: false },
);

const expenseCategorySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    isSystem: { type: Boolean, default: false },
    /** Counts in the profit and loss — off for what isn't an expense (advances receivable, payroll clearing, VAT). */
    inPnl: { type: Boolean, default: true },
    subcategories: { type: [subcategorySchema], default: [] },
  },
  { timestamps: true },
);

// One slug per organization.
expenseCategorySchema.index({ organizationId: 1, slug: 1 }, { unique: true });

export type ExpenseCategoryDoc = InferSchemaType<typeof expenseCategorySchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const ExpenseCategory = model("ExpenseCategory", expenseCategorySchema);
