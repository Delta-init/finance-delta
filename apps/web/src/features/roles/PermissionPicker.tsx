"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { permissionSections } from "@delta/shared";
import { Input } from "@/components/ui/input";

/**
 * Choosing what a role can do.
 *
 * The previous version listed every permission string in one monospace grid,
 * which is how the code sees them and not how anybody decides what a colleague
 * should be able to reach. Here they are grouped by the thing they act on, the
 * actions are named in plain words, and each resource has one control to take
 * or drop the lot — because "give sales full access to quotations" is a single
 * decision, not four.
 *
 * The search filters resources rather than permission strings, so looking for
 * "invoice" narrows to the invoice block instead of scattering matches.
 */
export function PermissionPicker({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const sections = useMemo(() => permissionSections(), []);
  const held = useMemo(() => new Set(value), [value]);

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? sections
        .map((s) => ({
          ...s,
          groups: s.groups.filter(
            (g) =>
              g.label.toLowerCase().includes(needle) ||
              g.resource.includes(needle) ||
              g.items.some((i) => i.label.toLowerCase().includes(needle)),
          ),
        }))
        .filter((s) => s.groups.length > 0)
    : sections;

  function toggle(permission: string) {
    onChange(held.has(permission) ? value.filter((p) => p !== permission) : [...value, permission]);
  }

  function setGroup(items: string[], on: boolean) {
    const rest = value.filter((p) => !items.includes(p));
    onChange(on ? [...rest, ...items] : rest);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a section…"
            className="h-8 pl-8"
          />
        </div>
        <span className="text-xs text-foreground-muted">
          {value.length === 0 ? "Nothing selected" : `${value.length} selected`}
        </span>
        {value.length > 0 && !disabled && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-foreground-muted underline-offset-2 hover:text-danger hover:underline"
          >
            Clear all
          </button>
        )}
      </div>

      <div className="max-h-[42vh] space-y-4 overflow-y-auto rounded-lg border border-border p-3">
        {filtered.length === 0 && (
          <p className="py-6 text-center text-sm text-foreground-muted">Nothing matches “{q}”.</p>
        )}

        {filtered.map((section) => (
          <div key={section.label} className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
              {section.label}
            </p>

            {section.groups.map((group) => {
              const values = group.items.map((i) => i.value);
              const on = values.filter((v) => held.has(v)).length;
              const all = on === values.length;

              return (
                <div key={group.resource} className="rounded-md border border-border">
                  <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-muted px-3 py-1.5">
                    <span className="text-sm font-medium">{group.label}</span>
                    <div className="flex items-center gap-2">
                      {on > 0 && (
                        <span className="text-xs text-foreground-muted">
                          {all ? "Full access" : `${on} of ${values.length}`}
                        </span>
                      )}
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => setGroup(values, !all)}
                        className="text-xs text-primary underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        {all ? "None" : "All"}
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-x-4 gap-y-1 p-2 sm:grid-cols-2 lg:grid-cols-3">
                    {group.items.map((item) => (
                      <label
                        key={item.value}
                        title={item.note ?? item.value}
                        className="flex items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface-muted"
                      >
                        <input
                          type="checkbox"
                          disabled={disabled}
                          checked={held.has(item.value)}
                          onChange={() => toggle(item.value)}
                          className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
                        />
                        <span>
                          <span className="block leading-tight">{item.label}</span>
                          {item.note && (
                            <span className="block text-[11px] leading-tight text-foreground-muted">
                              {item.note}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
