import { Schema, model, type InferSchemaType } from "mongoose";

const sequenceSchema = new Schema({
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: "Organization",
    required: true,
  },
  key: { type: String, required: true }, // e.g. "quotation", "salesorder", "customer"
  prefix: { type: String, default: "" },
  next: { type: Number, default: 1 },
});

sequenceSchema.index({ organizationId: 1, key: 1 }, { unique: true });

export type SequenceDoc = InferSchemaType<typeof sequenceSchema>;
export const Sequence = model("Sequence", sequenceSchema);
