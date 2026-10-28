import type { TetraDeposit } from "@delta/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";

/** Where a CS Portal deposit stands, in the words the accounts team uses. */

export const STATUS_LABELS: Record<TetraDeposit["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  closed: "Closed",
  deleted: "Deleted",
};

const STATUS_TONE: Record<TetraDeposit["status"], NonNullable<BadgeProps["tone"]>> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  closed: "neutral",
  deleted: "neutral",
};

/** A bonus sent back to its CS to correct (2026-10-13) reads so, not as refused. */
export function TetraDepositStatusBadge({ status, sentBack }: { status: TetraDeposit["status"]; sentBack?: boolean }) {
  if (status === "rejected" && sentBack) return <Badge tone="warning">Sent back</Badge>;
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{STATUS_LABELS[status] ?? status}</Badge>;
}

/**
 * Whether CS Portal has the decision — empty while there is none to
 * send. Closed ones say why instead: there was nothing left to decide there.
 */
export function deliveryText(d: TetraDeposit): string {
  if (d.status === "closed") return d.closedReason ? `Closed — ${d.closedReason}` : "Closed";
  if (d.status === "deleted") return `Deleted${d.deleted?.byName ? ` by ${d.deleted.byName}` : ""}${d.deleted?.reason ? ` — ${d.deleted.reason}` : ""}`;
  if (d.status === "pending" || !d.delivery) return "";
  switch (d.delivery.state) {
    case "delivered":
      return "In CS Portal";
    case "failed":
      return `CS Portal did not accept it${d.delivery.lastError ? `: ${d.delivery.lastError}` : ""}`;
    default:
      return `On its way to CS Portal${d.delivery.lastError ? ` — not reached yet (${d.delivery.lastError})` : ""}`;
  }
}

export const formatWhen = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
