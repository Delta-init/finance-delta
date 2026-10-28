import { paymentMethodLabel } from "@delta/shared";

type DeclaredSource = {
  enrolment?: {
    declaredPaidMinor?: number | null;
    declaredPaymentMethod?: string | null;
    declaredPayments?: ReadonlyArray<{ method?: string | null; amountMinor?: number | null; paidOn?: string | null; receipt?: { url?: string | null; name?: string | null } | null }> | null;
  } | null;
  attachments?: ReadonlyArray<{ name?: string | null; url?: string | null; key?: string | null }> | null;
};

/**
 * The close as the counsellor declared it (the owner, 2026-10-12): what they collected and how, each payment with its
 * own receipt, and the close's receipt — so CS Portal shows "Collected by counsellor" and the salesperson's
 * receipts, not only what accounts recorded. Shared by the fee update and the student's fee summary.
 */
export function declaredSide(invoice: DeclaredSource) {
  const e = invoice.enrolment ?? null;
  const receipt = (invoice.attachments ?? []).find((a) => String(a?.key ?? "").startsWith("enrolment-receipts/") && a?.url);
  return {
    declaredPaidMinor: e?.declaredPaidMinor ?? 0,
    declaredPaymentMethod: e?.declaredPaymentMethod ? paymentMethodLabel(e.declaredPaymentMethod) || String(e.declaredPaymentMethod) : "",
    declaredPayments: (e?.declaredPayments ?? []).map((p) => ({
      method: paymentMethodLabel(p?.method ?? "") || String(p?.method ?? ""),
      amountMinor: p?.amountMinor ?? 0,
      paidOn: p?.paidOn ?? "",
      receipt: p?.receipt?.url ? { url: String(p.receipt.url), name: String(p.receipt.name ?? "Receipt") } : null,
    })),
    receipt: receipt ? { url: String(receipt.url), name: String(receipt.name ?? "Receipt") } : null,
  };
}
