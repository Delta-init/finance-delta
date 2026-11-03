"use client";

import type { Vendor } from "@delta/shared";
import { SearchPicker } from "@/components/ui/search-picker";
import { useVendor } from "./api";

/**
 * A vendor, picked by searching all of them on the server — name, email, company, phone and vendor code (the user,
 * 2026-11-03). The bill, purchase order and vendor credit forms asked for `limit: 200`, which the API does not read, so
 * they had the first 10 vendors only. See SearchPicker.
 */
export function VendorPicker({
  value, onChange, placeholder = "Select vendor", invalid,
}: {
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  invalid?: boolean;
}) {
  const { data: chosen } = useVendor(value || undefined);
  return (
    <SearchPicker<Vendor>
      value={value}
      onChange={(id) => onChange(id)}
      selectedLabel={chosen ? `${chosen.name}${chosen.companyName ? ` — ${chosen.companyName}` : ""}` : undefined}
      path="vendors"
      queryKey={["vendors", "picker"]}
      toRow={(v) => ({
        id: v.id,
        label: `${v.name}${v.companyName ? ` — ${v.companyName}` : ""}`,
        detail: [v.vendorCode, v.phone, v.email].filter(Boolean).join(" · "),
        item: v,
      })}
      placeholder={placeholder}
      searchPlaceholder="Search name, company, phone, email or code…"
      noun="vendor"
      invalid={invalid}
    />
  );
}
