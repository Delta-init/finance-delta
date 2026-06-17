import { Schema, model, Types, type InferSchemaType } from "mongoose";

const tagSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    color: { type: String, default: "blue" },
  },
  { timestamps: true },
);

tagSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export type TagDoc = InferSchemaType<typeof tagSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const Tag = model("Tag", tagSchema);
