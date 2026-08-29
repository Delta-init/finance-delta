"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, User, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { usePersonDetail } from "@/features/payroll/api";

const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;
const today = () => new Date().toISOString().slice(0, 10);
const day = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * One person: what they brought in, and everything they cost.
 *
 * The cost figure is payroll paid plus expenses. Commission appears twice on
 * this page and is added only once — as a line inside the payroll breakdown,
 * because that is how it reaches somebody. The commission table below is there
 * to show which invoices earned it, not to be added to anything.
 */
export default function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const search = useSearchParams();
  const [from, setFrom] = useState(search.get("from") ?? monthStart());
  const [to, setTo] = useState(search.get("to") ?? today());

  const { data, isLoading } = usePersonDetail(id, { from, to });

  if (isLoading) return <p className="p-6 text-sm text-foreground-muted">Loading…</p>;
  if (!data) return <p className="p-6 text-sm text-danger">Person not found.</p>;

  const { person, summary, payslips, invoices, expenses, commissions } = data;
  const currency = payslips[0]?.currency ?? invoices[0]?.currency ?? "AED";

  return (
    <div className="space-y-6 p-6">
      <Link href="/reports/salesperson" className="inline-flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />All people
      </Link>

      <PageHeader
        icon={User}
        title={person.name}
        description={[person.employeeCode, person.designation, person.departmentName || "No department", person.email]
          .filter(Boolean)
          .join(" · ")}
        action={<Badge tone={person.status === "active" ? "success" : "neutral"}>{person.status}</Badge>}
      />

      <Card className="flex flex-wrap items-end gap-3 p-3">
        <div className="space-y-1.5">
          <Label htmlFor="p-from" className="text-xs">From</Label>
          <Input id="p-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-to" className="text-xs">To</Label>
          <Input id="p-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
        </div>
      </Card>

      {!person.hasLogin && (
        <Card className="flex items-start gap-2 border-warning/20 bg-warning/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            No finance login, so this person cannot be named on an invoice or hold a commission
            structure. HRMS has no email address for them.
          </span>
        </Card>
      )}

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Invoiced" value={<MoneyDisplay minor={summary.invoicedMinor} currency={currency} />} />
          <Stat label="Payroll paid" value={<MoneyDisplay minor={summary.payrollPaidMinor} currency={currency} />} />
          <Stat label="Expenses" value={<MoneyDisplay minor={summary.expensesMinor} currency={currency} />} />
          <Stat label="Total cost" value={<MoneyDisplay minor={summary.totalCostMinor} currency={currency} />} strong />
        </div>
      )}

      {summary && summary.commissionInPayrollMinor > 0 && (
        <p className="text-sm text-foreground-muted">
          {/* Said once, plainly, because the same money appears in two tables. */}
          Of the payroll figure, <MoneyDisplay minor={summary.commissionInPayrollMinor} currency={currency} /> was
          commission. It is counted once, inside payroll — the commission table below shows which invoices
          earned it.
        </p>
      )}

      <Section title="Payroll" description="What was actually transferred each month.">
        <Table
          head={["Month", "Run", "Gross", "Deductions", "of which commission", "Paid"]}
          rows={payslips.map((p) => [
            p.period,
            <Link key={p.runId} href={`/payroll/runs/${p.runId}`} className="underline">{p.runNumber}</Link>,
            <MoneyDisplay key="g" minor={p.grossMinor} currency={p.currency} />,
            <MoneyDisplay key="d" minor={p.deductionsMinor} currency={p.currency} />,
            p.commissionMinor ? <MoneyDisplay key="c" minor={p.commissionMinor} currency={p.currency} /> : "—",
            <MoneyDisplay key="p" minor={p.amountPaidMinor} currency={p.currency} className="font-medium" />,
          ])}
          empty="No payroll in this period."
        />
      </Section>

      <Section title="Expenses" description="Claims they submitted, counted the same way the profit and loss counts them.">
        <Table
          head={["Date", "Expense", "Category", "Status", "Amount"]}
          rows={expenses.map((e) => [
            day(e.expenseDate), e.expenseNumber || e.description, e.categoryName || "—",
            <Badge key="s" tone={e.status === "approved" ? "success" : "warning"}>{e.status}</Badge>,
            <MoneyDisplay key="a" minor={e.totalMinor} currency={e.currency} />,
          ])}
          empty="No expenses in this period."
        />
      </Section>

      <Section title="Invoices raised" description="What they brought in.">
        <Table
          head={["Date", "Invoice", "Customer", "Status", "Amount"]}
          rows={invoices.map((i) => [
            day(i.issueDate), i.invoiceNumber, i.customerName,
            <Badge key="s" tone="neutral">{i.status}</Badge>,
            <MoneyDisplay key="a" minor={i.totalMinor} currency={i.currency} />,
          ])}
          empty="No invoices in this period."
        />
      </Section>

      <Section
        title="Commission"
        description="Which invoices earned it. Paid commission is already inside the payroll figures above — this is the breakdown, not an addition."
      >
        <Table
          head={["Invoice", "Status", "Earned", "Paid", "Amount"]}
          rows={commissions.map((c) => [
            c.invoiceNumber,
            <Badge key="s" tone={c.status === "paid" ? "success" : c.status === "earned" ? "warning" : "neutral"}>{c.status}</Badge>,
            c.calculatedAt ? day(c.calculatedAt) : "—",
            c.paidAt ? day(c.paidAt) : "—",
            <MoneyDisplay key="a" minor={c.commissionMinor} currency={currency} />,
          ])}
          empty="No commission recorded."
        />
      </Section>
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <Card className="p-4">
      <div className={strong ? "text-lg font-semibold" : "text-lg"}>{value}</div>
      <div className="mt-0.5 text-xs text-foreground-muted">{label}</div>
    </Card>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children}
    </Card>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-muted">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={`px-5 py-3 font-medium ${i >= head.length - 1 ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, r) => (
            <tr key={r} className="border-b border-border last:border-0">
              {cells.map((c, i) => (
                <td key={i} className={`px-5 py-3 ${i >= cells.length - 1 ? "text-right" : ""}`}>{c}</td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={head.length} className="px-5 py-8 text-center text-foreground-muted">{empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
