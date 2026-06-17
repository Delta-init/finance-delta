import type { QuoteStatus } from "@delta/shared";
import type { BadgeProps } from "@/components/ui/badge";

export const QUOTE_STATUS_TONE: Record<QuoteStatus, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral",
  sent: "primary",
  accepted: "success",
  declined: "danger",
  expired: "warning",
};
