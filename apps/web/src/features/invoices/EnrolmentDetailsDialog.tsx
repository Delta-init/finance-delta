"use client";

import Link from "next/link";
import { ExternalLink, GraduationCap, Mail, Paperclip, Phone } from "lucide-react";
import { ENROLMENT_CRM_LABELS, formatMoney, formatOriginalPayment, paymentMethodLabel, type Invoice } from "@delta/shared";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { useCustomer } from "@/features/customers/api";

const MODE_LABELS: Record<string, string> = { online: "Online", offline: "Offline", hybrid: "Hybrid" };

/**
 * Everything about an enrolment in one place, for the person deciding on it.
 *
 * The panel behind this shows what fits in a row. An approver asking "who is
 * this for, what did they agree to, and what has been collected" was otherwise
 * reading it off three parts of the page and the customer record — which is a
 * good way to approve the wrong thing.
 *
 * The client is fetched only once this is opened. Most invoices are never
 * looked at this closely, and a request per row on the way past buys nothing.
 */
export function EnrolmentDetailsDialog({
  invoice,
  open,
  onClose,
}: {
  invoice: Invoice;
  open: boolean;
  onClose: () => void;
}) {
  const e = invoice.enrolment;
  const { data: customer, isLoading } = useCustomer(open ? invoice.customerId : undefined);

  const address = [
    customer?.billingAddress?.street,
    customer?.billingAddress?.city,
    customer?.billingAddress?.state,
    customer?.billingAddress?.zip,
    customer?.billingAddress?.country,
  ]
    .filter(Boolean)
    .join(", ");

  // The balance the CRM sent where it sent one — the fee less what was
  // collected, the bonus never in it — and the same sum worked out here otherwise.
  const outstanding = e?.declaredBalanceMinor ?? Math.max(0, invoice.totalMinor - (e?.declaredPaidMinor ?? 0));
  // More collected than the invoice asks for — a balance of zero would hide it.
  const overMinor = (e?.declaredPaidMinor ?? 0) - invoice.totalMinor;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-foreground-muted" />
            {e?.course ?? "Enrolment"}
          </DialogTitle>
          <DialogDescription>
            {invoice.invoiceNumber} · {invoice.customerName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <Section title="Client">
            {/* The name is on the invoice already; the rest is what tells an
                approver they are looking at the right person. */}
            <Row label="Name" value={customer?.name ?? invoice.customerName} />
            <Row label="Client code" value={customer?.customerCode} loading={isLoading} />
            <Row
              label="Email"
              value={customer?.email}
              loading={isLoading}
              icon={<Mail className="h-3 w-3" />}
              href={customer?.email ? `mailto:${customer.email}` : undefined}
            />
            <Row
              label="Phone"
              value={customer?.phone}
              loading={isLoading}
              icon={<Phone className="h-3 w-3" />}
              href={customer?.phone ? `tel:${customer.phone}` : undefined}
            />
            <Row label="Company" value={customer?.companyName} loading={isLoading} />
            <Row label="TRN / VAT number" value={customer?.vatNumber} loading={isLoading} />
            <Row label="Address" value={address} loading={isLoading} />
          </Section>

          {e && (
            <Section title="Enrolment">
              <Row label="Sold through" value={e.crm ? ENROLMENT_CRM_LABELS[e.crm] : undefined} />
              <Row label="Course" value={e.course} />
              <Row label="Mode of study" value={MODE_LABELS[e.modeOfStudy] ?? e.modeOfStudy} />
              <Row label="Language" value={e.language} />
              <Row label="Salesperson" value={e.meetingBy} />
              <Row label="Raised by" value={invoice.salespersonName} />
              <Row label="Enrolled on" value={invoice.issueDate} />
            </Section>
          )}

          <Section title="Money">
            {/* The course price includes the tax, so the total is what was
                agreed. Both halves are shown rather than only the total: an
                approver checking a receipt is looking at one of them. */}
            <Row label="Course, net of tax" value={formatMoney(invoice.subtotalMinor, invoice.currency)} />
            <Row label="Tax" value={formatMoney(invoice.taxTotalMinor, invoice.currency)} />
            <Row label="Total agreed" value={formatMoney(invoice.totalMinor, invoice.currency)} strong />
            {e?.declaredPaidMinor ? (
              <>
                <Row
                  label="Collected by counsellor"
                  value={`${formatMoney(e.declaredPaidMinor, invoice.currency)}${
                    !e.declaredPayments?.length && e.declaredPaymentMethod ? ` · ${paymentMethodLabel(e.declaredPaymentMethod)}` : ""
                  }`}
                />
                {/* Each payment, when the client paid in more than one way:
                    how, how much, and its own receipt to check it against. */}
                {e.declaredPayments?.map((p, i) => (
                  <Row
                    key={i}
                    label={`· ${paymentMethodLabel(p.method)}${p.paidOn ? `, ${p.paidOn.slice(0, 10)}` : ""}`}
                    value={`${formatMoney(p.amountMinor, invoice.currency)}${
                      // Paid in another currency: what was handed over, and the rate the CRM converted at.
                      p.original ? ` · paid ${formatOriginalPayment(p.original, invoice.currency)}` : ""
                    }${p.receipt ? " · receipt" : " · no receipt"}`}
                    href={p.receipt?.url}
                    icon={p.receipt ? <Paperclip className="h-3 w-3" /> : undefined}
                    newTab
                  />
                ))}
                {/* Declared, not recorded: this is what the counsellor says
                    they took, against what the invoice asks for. */}
                <Row label="Balance (still to collect)" value={formatMoney(outstanding, invoice.currency)} strong />
                {overMinor > 0 && (
                  <p className="py-1 text-right text-xs font-medium text-danger">
                    {formatMoney(overMinor, invoice.currency)} more than the total — check the course and the amounts
                  </p>
                )}
              </>
            ) : (
              <Row label="Collected by counsellor" value="Nothing declared" />
            )}
            <Row label="Recorded against the invoice" value={formatMoney(invoice.amountPaidMinor, invoice.currency)} />
            {/* What the approval did with the payments declared at the close. */}
            {e?.declaredPaymentsOnApproval && (
              <Row
                label="On approval"
                value={e.declaredPaymentsOnApproval.state === "recorded"
                  ? "The payments were recorded against the invoice"
                  : `Left for accounts — ${e.declaredPaymentsOnApproval.reason ?? "record them by hand"}`}
              />
            )}
            {/* Asked at the close. Beside the money rather than in it: the
                bonus is not billed, not taxed and not part of the balance. */}
            {e?.bonus ? (
              <Row
                label="Bonus (not in the fee or balance)"
                value={e.bonus.given ? `Yes · ${formatMoney(e.bonus.amountMinor, e.bonus.currency ?? invoice.currency)}` : "No"}
              />
            ) : null}
          </Section>

          <Link
            href={`/customers/${invoice.customerId}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-700 hover:underline"
          >
            Open the client record <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted">{title}</h3>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{children}</dl>
    </div>
  );
}

/**
 * One fact. Absent rather than blank when there is nothing to say — a row
 * reading "Email —" tells an approver the address is missing, which is worth
 * knowing, so empties are shown as a dash rather than hidden.
 */
function Row({
  label,
  value,
  loading,
  icon,
  href,
  strong,
  newTab,
}: {
  label: string;
  value?: string;
  loading?: boolean;
  icon?: React.ReactNode;
  href?: string;
  strong?: boolean;
  /** Open the link beside the app — a receipt, not somewhere to go. */
  newTab?: boolean;
}) {
  const text = loading ? "…" : value?.trim() ? value : "—";
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1 last:border-0">
      <dt className="text-xs text-foreground-muted">{label}</dt>
      <dd className={`text-right text-sm ${strong ? "font-semibold" : "font-medium"}`}>
        {href && !loading && value ? (
          <a
            href={href}
            {...(newTab ? { target: "_blank", rel: "noreferrer" } : {})}
            className="inline-flex items-center gap-1.5 text-primary-700 hover:underline"
          >
            {icon}
            {text}
          </a>
        ) : (
          text
        )}
      </dd>
    </div>
  );
}
