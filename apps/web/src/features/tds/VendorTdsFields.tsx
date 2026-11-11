"use client";

import type { UseFormRegister } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTdsConfig } from "./api";

/**
 * A vendor's PAN and the TDS section their bills are usually deducted under (Bangalore, 2026-11-11) — shown only where
 * the organization offers TDS (INR books). A new bill for the vendor takes the section unless another is chosen.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function VendorTdsFields({ register }: { register: UseFormRegister<any> }) {
  const { data: cfg } = useTdsConfig();
  if (!cfg?.available) return null;
  return (
    <>
      <div className="space-y-1.5">
        <Label>PAN</Label>
        <Input {...register("pan")} placeholder="ABCDE1234F" className="uppercase" maxLength={20} />
      </div>
      <div className="space-y-1.5">
        <Label>TDS section</Label>
        <select {...register("tdsSection")} className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm">
          <option value="">No TDS</option>
          {cfg.sections.filter((s) => s.active).map((s) => (
            <option key={s.code} value={s.code}>{s.label} — {s.ratePct}%</option>
          ))}
        </select>
      </div>
    </>
  );
}
