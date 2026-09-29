import type { TetraDeposit } from "@delta/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";

/** Where a Tetra Commission deposit stands, in the words the accounts team uses. */

export const STATUS_LABELS: Record<TetraDeposit["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  closed: "Closed",
};

const STATUS_TONE: Record<TetraDeposit["status"], NonNullable<BadgeProps["tone"]>> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  closed: "neutral",
};

export function TetraDepositStatusBadge({ status }: { status: TetraDeposit["status"] }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{STATUS_LABELS[status] ?? status}</Badge>;
}

/**
 * Whether Tetra Commission has the decision — empty while there is none to
 * send. Closed ones say why instead: there was nothing left to decide there.
 */
export function deliveryText(d: TetraDeposit): string {
  if (d.status === "closed") return d.closedReason ? `Closed — ${d.closedReason}` : "Closed";
  if (d.status === "pending" || !d.delivery) return "";
  switch (d.delivery.state) {
    case "delivered":
      return "In Tetra Commission";
    case "failed":
      return `Tetra Commission did not accept it${d.delivery.lastError ? `: ${d.delivery.lastError}` : ""}`;
    default:
      return `On its way to Tetra Commission${d.delivery.lastError ? ` — not reached yet (${d.delivery.lastError})` : ""}`;
  }
}

export const formatWhen = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
