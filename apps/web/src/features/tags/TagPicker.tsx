"use client";

import { useMemo } from "react";
import { MultiSelect } from "@/components/ui/multi-select";
import { useAllTags } from "./api";
import { TAG_HEX } from "./tag-colors";

/** Reusable tag multi-select for entity forms and list filters. */
export function TagPicker({
  value,
  onChange,
  placeholder = "Add tags…",
  className,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  const { data: tags } = useAllTags();
  const options = useMemo(
    () =>
      (tags ?? []).map((t) => ({
        value: t.id,
        label: t.name,
        color: TAG_HEX[t.color],
      })),
    [tags],
  );

  return (
    <MultiSelect
      options={options}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      emptyText="No tags yet."
      className={className}
    />
  );
}
