"use client";

import type { User } from "@delta/shared";
import { SearchPicker } from "@/components/ui/search-picker";
import { useUser } from "./api";

/**
 * A salesperson (any user, payroll-only accounts included), picked by searching all of them on the server by name or
 * email (the user, 2026-11-03: "the same server search for the salesperson picker"). The pickers loaded everybody, up
 * to 1,000, and narrowed that in the browser. See SearchPicker.
 *
 * The chosen one's name comes from `GET /users/:id`; where the record already carries it (an invoice's
 * salespersonName), `fallbackLabel` shows it meanwhile — and on an API from before that route.
 */
export function UserPicker({
  value, onChange, fallbackLabel, placeholder = "Select a salesperson…", clearLabel, onlyActive, disabled, invalid, className,
}: {
  value: string;
  onChange: (id: string, user?: User) => void;
  fallbackLabel?: string;
  placeholder?: string;
  /** A first option for none — "All salespeople", "Not for a salesperson". */
  clearLabel?: string;
  /** Leave out suspended accounts (they stay on the records that have them). */
  onlyActive?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  const { data: chosen } = useUser(value || undefined);
  const dept = (u: User) => u.department?.name ?? u.employeeDepartment?.name ?? "";
  return (
    <SearchPicker<User>
      value={value}
      onChange={(id, u) => onChange(id, u)}
      selectedLabel={chosen?.name ?? (value ? fallbackLabel : undefined)}
      path="users"
      params={onlyActive ? { status: "active" } : undefined}
      queryKey={["users", "picker"]}
      toRow={(u) => ({ id: u.id, label: u.name, detail: [dept(u), u.email].filter(Boolean).join(" · "), item: u })}
      placeholder={placeholder}
      searchPlaceholder="Search name or email…"
      noun="person"
      clearLabel={clearLabel}
      onClear={clearLabel ? () => onChange("") : undefined}
      disabled={disabled}
      invalid={invalid}
      className={className}
    />
  );
}
