import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Status = "paid" | "overdue" | "sent" | "draft";

const STATUS_TONE: Record<Status, "success" | "danger" | "primary" | "neutral"> = {
  paid: "success",
  overdue: "danger",
  sent: "primary",
  draft: "neutral",
};

const ROWS: {
  number: string;
  customer: string;
  status: Status;
  due: string;
  amount: string;
}[] = [
  { number: "INV-1042", customer: "Acme Trading LLC", status: "paid", due: "Jun 02", amount: "AED 24,500" },
  { number: "INV-1041", customer: "Pixel Cot FZ", status: "overdue", due: "May 28", amount: "AED 9,800" },
  { number: "INV-1040", customer: "Gulf Logistics", status: "sent", due: "Jun 18", amount: "AED 42,000" },
  { number: "INV-1039", customer: "Nova Interiors", status: "paid", due: "Jun 01", amount: "AED 12,300" },
  { number: "INV-1038", customer: "Orbit Media", status: "draft", due: "—", amount: "AED 7,650" },
];

export function RecentInvoices() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Invoices</CardTitle>
        <CardDescription>Latest activity across your workspace</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-subtle">
              <th className="px-5 py-3 font-medium">Invoice</th>
              <th className="px-5 py-3 font-medium">Customer</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Due</th>
              <th className="px-5 py-3 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.number} className="border-b border-border last:border-0">
                <td className="px-5 py-3 font-medium">{r.number}</td>
                <td className="px-5 py-3 text-foreground-muted">{r.customer}</td>
                <td className="px-5 py-3">
                  <Badge tone={STATUS_TONE[r.status]} className="capitalize">
                    {r.status}
                  </Badge>
                </td>
                <td className="px-5 py-3 text-foreground-muted">{r.due}</td>
                <td className="px-5 py-3 text-right font-numeric font-medium">
                  {r.amount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
