import { LayoutDashboard } from "lucide-react";
import { auth } from "@/auth";
import { PageHeader } from "@/components/page-header";
import { SectionCards } from "@/components/dashboard/section-cards";
import { CashflowChart } from "@/components/dashboard/cashflow-chart";
import { RecentInvoices } from "@/components/dashboard/recent-invoices";

export default async function DashboardPage() {
  const session = await auth();
  const name = session?.user.name ?? "there";

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <PageHeader
        icon={LayoutDashboard}
        title={`Welcome back, ${name}`}
        description="Here's what's happening across your workspace today."
      />

      <SectionCards />

      <div className="grid gap-6 lg:grid-cols-7">
        <div className="lg:col-span-4">
          <CashflowChart />
        </div>
        <div className="lg:col-span-3">
          <RecentInvoices />
        </div>
      </div>
    </div>
  );
}
