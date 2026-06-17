import { Types } from "mongoose";
import type {
  CreateTagInput,
  Paginated,
  Tag as TagDTO,
  TagColor,
  TagQuery,
  UpdateTagInput,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { Tag, type TagDoc } from "./tag.model";

function toDTO(doc: TagDoc): TagDTO {
  return {
    id: doc._id.toString(),
    name: doc.name,
    color: (doc.color ?? "blue") as TagColor,
    createdAt: doc.createdAt.toISOString(),
  };
}

const SORT = { name: "name", createdAt: "createdAt" } as const;

export async function listTags(orgId: string, query: TagQuery): Promise<Paginated<TagDTO>> {
  const filter: Record<string, unknown> = { organizationId: orgId };
  const or = searchOr(query.q, ["name"]);
  if (or) filter.$or = or;

  const sort = buildSort(SORT, query.sort, query.dir, { name: 1 });
  const [rows, total] = await Promise.all([
    Tag.find(filter).sort(sort).skip(skipFor(query.page, query.pageSize)).limit(query.pageSize),
    Tag.countDocuments(filter),
  ]);
  return { data: rows.map(toDTO), meta: pageMeta(total, query.page, query.pageSize) };
}

/** All tags (unpaginated) — for pickers and filters. */
export async function listAllTags(orgId: string): Promise<TagDTO[]> {
  const rows = await Tag.find({ organizationId: orgId }).sort({ name: 1 });
  return rows.map(toDTO);
}

export async function createTag(orgId: string, input: CreateTagInput): Promise<TagDTO> {
  const exists = await Tag.exists({ organizationId: orgId, name: input.name });
  if (exists) throw new AppError("CONFLICT", "A tag with this name already exists");
  const doc = await Tag.create({
    organizationId: new Types.ObjectId(orgId),
    name: input.name,
    color: input.color ?? "blue",
  });
  return toDTO(doc);
}

export async function updateTag(
  orgId: string,
  id: string,
  input: UpdateTagInput,
): Promise<TagDTO> {
  const doc = await Tag.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Tag not found");
  if (input.name !== undefined) doc.name = input.name;
  if (input.color !== undefined) doc.color = input.color;
  await doc.save();
  return toDTO(doc);
}

export async function deleteTag(orgId: string, id: string): Promise<void> {
  const doc = await Tag.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Tag not found");
  await doc.deleteOne();
}
