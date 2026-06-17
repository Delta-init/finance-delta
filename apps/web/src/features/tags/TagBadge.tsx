import type { TagRef } from "@delta/shared";
import { tagChipStyle } from "./tag-colors";

export function TagBadge({ tag }: { tag: TagRef }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={tagChipStyle(tag.color)}
    >
      {tag.name}
    </span>
  );
}

export function TagList({ tags }: { tags: TagRef[] }) {
  if (!tags?.length) return <span className="text-foreground-subtle">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <TagBadge key={t.id} tag={t} />
      ))}
    </div>
  );
}
