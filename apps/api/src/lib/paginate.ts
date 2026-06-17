import type { PageMeta } from "@delta/shared";

export const skipFor = (page: number, pageSize: number) => (page - 1) * pageSize;

export function pageMeta(total: number, page: number, pageSize: number): PageMeta {
  return { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Build a `{ field: 1 | -1 }` Mongo sort from a whitelisted sort key + direction. */
export function buildSort(
  allowed: Record<string, string>,
  sort: string | undefined,
  dir: "asc" | "desc",
  fallback: Record<string, 1 | -1> = { createdAt: -1 },
): Record<string, 1 | -1> {
  if (sort && allowed[sort]) {
    return { [allowed[sort]]: dir === "asc" ? 1 : -1 };
  }
  return fallback;
}

/** Case-insensitive regex match helper for `$or` search across fields. */
export function searchOr(q: string | undefined, fields: string[]) {
  if (!q) return undefined;
  const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  return fields.map((f) => ({ [f]: rx }));
}
