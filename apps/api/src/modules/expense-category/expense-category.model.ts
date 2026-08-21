import { Schema, model, Types, type InferSchemaType } from "mongoose";

const expenseCategorySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    isSystem: { type: Boolean, default: false },
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
