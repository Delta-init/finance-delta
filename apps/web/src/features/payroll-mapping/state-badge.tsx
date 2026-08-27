"use client";

import { Badge } from "@/components/ui/badge";
import type { DeptState, EmpState } from "./types";

const TONE: Record<DeptState | EmpState, "success" | "warning" | "neutral" | "danger" | "primary"> = {
  linked: "success",
  proposed: "primary",
  unmatched: "warning",
  new: "primary",
  conflict: "danger",
  orphaned: "warning",
};

const LABEL: Record<DeptState | EmpState, string> = {
  linked: "Mapped",
  proposed: "Match found",
  unmatched: "No match",
  new: "New",
  conflict: "Needs a decision",
  orphaned: "Gone from HRMS",
};

export function StateBadge({ state }: { state: DeptState | EmpState }) {
  return <Badge tone={TONE[state]}>{LABEL[state]}</Badge>;
}
