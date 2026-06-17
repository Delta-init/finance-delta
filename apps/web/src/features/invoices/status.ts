import type { InvoiceStatus } from "@delta/shared";
import type { BadgeProps } from "@/components/ui/badge";

export const INVOICE_STATUS_TONE: Record<InvoiceStatus, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral",
  sent: "primary",
  viewed: "primary",
  paid: "success",
  partial: "warning",
  overdue: "danger",
  void: "neutral",
};
