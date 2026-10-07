"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type QueryParams } from "@/lib/api";

/** One email finance tried to send, as the log keeps it. */
export interface EmailLogRow {
  id: string;
  at: string | null;
  kind: string;
  to: string[];
  subject: string;
  state: "sent" | "failed" | "no_address" | "not_configured";
  error?: string;
  ref: { type: string; id: string; label: string } | null;
  actorName: string;
}

export const EMAIL_LOG_KEY = ["email-log"] as const;

/** What each kind of email is called on screen. */
export const EMAIL_KIND_LABEL: Record<string, string> = {
  invoice: "Invoice",
  invoice_resend: "Invoice resent",
  invoice_approved: "Invoice on approval",
  invoice_salesperson: "Salesperson's copy",
  reminder: "Payment reminder",
  approval_notice: "Approval notice",
  expense_notice: "Expense notice",
  bill_notice: "Bill notice",
  payroll_notice: "Payroll notice",
  fund_request_notice: "Fund request notice",
  tetra_deposit_notice: "Tetra deposit notice",
  procurement_notice: "Purchase request notice",
  password_reset: "Password reset",
  invite: "Invitation",
  notice: "Notice",
  other: "Other",
};

export const EMAIL_STATE_LABEL: Record<EmailLogRow["state"], string> = {
  sent: "Sent",
  failed: "Failed",
  no_address: "No email address",
  not_configured: "Email not set up",
};

/** The organization's email log — admins and accountants. */
export function useEmailLogs(params: QueryParams) {
  return useQuery({
    queryKey: [...EMAIL_LOG_KEY, "list", params],
    queryFn: () => api.getList<EmailLogRow>("email-logs", params),
    placeholderData: (prev) => prev,
    // An older API has no log yet: asking again will not change that.
    retry: (count, err) => !(err instanceof Error && "status" in err && (err as { status: number }).status === 404) && count < 2,
  });
}

/** Every email sent about one invoice. */
export function useInvoiceEmails(invoiceId: string) {
  return useQuery({
    queryKey: [...EMAIL_LOG_KEY, "invoice", invoiceId],
    queryFn: () => api.get<EmailLogRow[]>(`invoices/${invoiceId}/emails`),
    refetchInterval: 15_000,
    retry: (count, err) => !(err instanceof Error && "status" in err && (err as { status: number }).status === 404) && count < 2,
  });
}
