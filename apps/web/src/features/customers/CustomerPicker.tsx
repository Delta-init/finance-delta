"use client";

import type { Customer } from "@delta/shared";
import { SearchPicker } from "@/components/ui/search-picker";
import { useCustomer } from "./api";

/**
 * A customer, picked by searching all of them on the server — name, email, company, phone and customer code (the
 * user, 2026-11-03: the invoice and quotation forms only searched the first 100 A to Z). See SearchPicker.
 */
export function CustomerPicker({
  value, onChange, placeholder = "Select a customer…", invalid,
}: {
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  invalid?: boolean;
}) {
  const { data: chosen } = useCustomer(value || undefined);
  return (
    <SearchPicker<Customer>
      value={value}
      onChange={(id) => onChange(id)}
      selectedLabel={chosen?.name}
      path="customers"
      queryKey={["customers", "picker"]}
      toRow={(c) => ({ id: c.id, label: c.name, detail: [c.customerCode, c.phone, c.email].filter(Boolean).join(" · "), item: c })}
      placeholder={placeholder}
      searchPlaceholder="Search name, phone, email or code…"
      noun="customer"
      invalid={invalid}
    />
  );
}
