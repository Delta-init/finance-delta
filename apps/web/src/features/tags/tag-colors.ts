import type { TagColor } from "@delta/shared";

/** Base OKLCH color per tag token. */
export const TAG_HEX: Record<TagColor, string> = {
  slate: "oklch(0.55 0.02 250)",
  blue: "oklch(0.62 0.182 254.6)",
  green: "oklch(0.6 0.15 152)",
  amber: "oklch(0.74 0.15 80)",
  red: "oklch(0.6 0.2 25)",
  violet: "oklch(0.58 0.18 292)",
  pink: "oklch(0.65 0.2 350)",
  teal: "oklch(0.64 0.12 195)",
};

/** Inline style for a soft tag chip (low-alpha bg, darker text). */
export function tagChipStyle(color: TagColor): React.CSSProperties {
  const c = TAG_HEX[color] ?? TAG_HEX.blue;
  return {
    backgroundColor: `color-mix(in oklch, ${c} 15%, white)`,
    color: `color-mix(in oklch, ${c} 72%, black)`,
  };
}
