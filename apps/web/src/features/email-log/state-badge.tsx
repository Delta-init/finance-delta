import { Badge } from "@/components/ui/badge";
import { EMAIL_STATE_LABEL, type EmailLogRow } from "./api";

const TONE: Record<EmailLogRow["state"], "success" | "danger" | "warning"> = {
  sent: "success",
  failed: "danger",
  no_address: "warning",
  not_configured: "warning",
};

/** Sent / Failed / No email address / Email not set up. */
export function EmailStateBadge({ row }: { row: Pick<EmailLogRow, "state" | "error"> }) {
  return (
    <Badge tone={TONE[row.state]} title={row.error || undefined}>
      {EMAIL_STATE_LABEL[row.state]}
    </Badge>
  );
}
