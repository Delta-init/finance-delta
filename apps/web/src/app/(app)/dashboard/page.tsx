import { auth } from "@/auth";
import { SectionCards } from "@/components/dashboard/section-cards";
import { CashflowChart } from "@/components/dashboard/cashflow-chart";
import { RecentInvoices } from "@/components/dashboard/recent-invoices";
import { TopCustomers } from "@/components/dashboard/top-customers";
import { ExpenseChart } from "@/components/dashboard/expense-chart";
import { AgingSummary } from "@/components/dashboard/aging-summary";

export default async function DashboardPage() {
  const session = await auth();
  const name = session?.user.name ?? "there";

  const now = new Date();
  const currentMonth = now.toLocaleString("en-US", { month: "long" });
  const currentYear = now.getFullYear();

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Welcome back, {name} 👋</h1>
          <p className="text-sm text-foreground-muted mt-0.5">
            Here&apos;s what&apos;s happening in your workspace today.
          </p>
        </div>
        <div className="text-xs text-foreground-muted bg-surface border border-border rounded-lg px-3 py-2">
          {currentMonth} {currentYear}
        </div>
      </div>

      <SectionCards />

      <div className="grid gap-6 lg:grid-cols-7">
        <div className="lg:col-span-4">
          <CashflowChart />
        </div>
        <div className="lg:col-span-3">
          <AgingSummary />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-7">
        <div className="lg:col-span-4">
          <RecentInvoices />
        </div>
        <div className="lg:col-span-3 space-y-6">
          <TopCustomers />
          <ExpenseChart />
        </div>
      </div>
    </div>
  );
}
