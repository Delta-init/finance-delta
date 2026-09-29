import { Schema, model, Types, type InferSchemaType } from "mongoose";

const itemSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, required: true, index: true },
    itemNumber: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    sku: { type: String, required: true, trim: true },
    type: { type: String, enum: ["product", "service"], default: "product" },
    unit: {
      type: String,
      enum: ["each", "kg", "g", "liter", "ml", "meter", "cm", "box", "set", "hour", "day", "pair", "dozen", "pack"],
      default: "each",
    },
    unitPriceMinor: { type: Number, default: 0 },
    // Per item: two courses on one GST invoice can sit under different codes.
    // The organization's default fills in for anything left blank.
    hsnSac: { type: String, default: "", trim: true },
    /**
     * Which course this is in the LMS.
     *
     * A slug, because a name cannot identify a course: this database holds
     * nine spellings of three of them — "Market Break out", "MARKET BREAK OUT",
     * "Market Breakout", "MBT" — and enrolling somebody on the wrong course is
     * worse than not enrolling them at all. Blank means not mapped, and an
     * approval for an unmapped item provisions nothing and says so.
     */
    lmsCourseSlug: { type: String, default: "", trim: true },
    /**
     * Every LMS course it opens, in order, where it opens more than one — a
     * bundle is one product to sell and two courses to study. `lmsCourseSlug`
     * is kept as the first, so whatever reads a single course still reads the
     * right one. Read both through `itemLmsCourses`.
     */
    lmsCourseSlugs: { type: [String], default: [] },
    costPriceMinor: { type: Number, default: 0 },
    trackStock: { type: Boolean, default: true },
    reorderPoint: { type: Number, default: 0 },
    reorderQty: { type: Number, default: 0 },
    photoUrl: { type: String },
    departmentId: { type: Types.ObjectId, ref: "Department" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

itemSchema.index({ organizationId: 1, sku: 1 }, { unique: true });
itemSchema.index({ organizationId: 1, itemNumber: 1 }, { unique: true });
itemSchema.index({ organizationId: 1, name: 1 });
itemSchema.index({ organizationId: 1, isActive: 1 });

export type ItemDoc = InferSchemaType<typeof itemSchema> & { _id: Types.ObjectId };
export const Item = model<ItemDoc>("Item", itemSchema);

/** The LMS courses an item opens, in order — none when it is not mapped. */
export function itemLmsCourses(item: { lmsCourseSlug?: string | null; lmsCourseSlugs?: string[] | null } | null | undefined): string[] {
  const many = (item?.lmsCourseSlugs ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (many.length) return [...new Set(many)];
  const one = item?.lmsCourseSlug?.trim();
  return one ? [one] : [];
}

/**
 * What to store for an item's LMS courses, from whichever of the two fields a
 * caller sent: the list decides when given, the single slug otherwise. Nothing
 * when neither was sent, so an update that says nothing about the LMS leaves
 * it alone.
 */
export function lmsCourseFields(input: { lmsCourseSlug?: string; lmsCourseSlugs?: string[] }): { lmsCourseSlug: string; lmsCourseSlugs: string[] } | null {
  if (input.lmsCourseSlugs !== undefined) {
    const list = [...new Set(input.lmsCourseSlugs.map((s) => s.trim()).filter(Boolean))];
    return { lmsCourseSlug: list[0] ?? "", lmsCourseSlugs: list };
  }
  if (input.lmsCourseSlug !== undefined) {
    const one = input.lmsCourseSlug.trim();
    return { lmsCourseSlug: one, lmsCourseSlugs: one ? [one] : [] };
  }
  return null;
}
