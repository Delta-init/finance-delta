"use client";

import type { Item } from "@delta/shared";
import { formatMoney } from "@delta/shared";
import { SearchPicker } from "@/components/ui/search-picker";

/**
 * An active product, picked by searching all of them on the server — name, SKU, description, item number (the user,
 * 2026-11-03). The price list pages asked for 500 at once; the API takes 100 at most and refused, so they had none
 * ("No items available"). The row already holds the chosen one's name, so it is passed in rather than fetched.
 */
export function ItemPicker({
  value, label, onChange, currency, defaultOpen, className,
}: {
  value: string;
  /** The chosen one's name as the row has it. */
  label?: string;
  onChange: (item: Item) => void;
  currency: string;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <SearchPicker<Item>
      value={value}
      onChange={(_, item) => onChange(item)}
      selectedLabel={label || undefined}
      path="inventory/items"
      params={{ isActive: "true", type: "product" }}
      queryKey={["inventory", "items", "picker"]}
      toRow={(i) => ({
        id: i.id,
        label: i.name,
        detail: [i.sku, formatMoney(i.unitPriceMinor, currency)].filter(Boolean).join(" · "),
        item: i,
      })}
      placeholder="Pick a product…"
      searchPlaceholder="Search name or SKU…"
      noun="product"
      defaultOpen={defaultOpen}
      className={className}
    />
  );
}
