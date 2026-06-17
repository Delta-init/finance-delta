import { Types } from "mongoose";
import type { TagRef } from "@delta/shared";
import { Tag } from "../modules/tag/tag.model";

interface PopulatedTag {
  _id: Types.ObjectId;
  name: string;
  color: string;
}

/** Map populated tag docs → lightweight TagRef[] for DTOs. */
export function toTagRefs(tags: unknown): TagRef[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t): t is PopulatedTag => !!t && typeof t === "object" && "name" in t)
    .map((t) => ({ id: t._id.toString(), name: t.name, color: t.color as TagRef["color"] }));
}

/** Validate that the given tag ids belong to the org; return clean ObjectId[]. */
export async function resolveTagIds(
  orgId: string,
  ids: string[] | undefined,
): Promise<Types.ObjectId[]> {
  if (!ids || ids.length === 0) return [];
  const valid = ids.filter((id) => Types.ObjectId.isValid(id));
  const found = await Tag.find({
    organizationId: orgId,
    _id: { $in: valid },
  }).select("_id");
  return found.map((t) => t._id);
}
