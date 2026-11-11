import { ReceiptText, ShoppingCart } from "lucide-react";
import {
  BILL_IMPORT_FIELDS,
  EXPENSE_IMPORT_FIELDS,
  formatMoney,
  type BillImportFieldKey,
  type ExpenseImportFieldKey,
  type ImportPreviewRow,
} from "@delta/shared";
import { Badge } from "@/components/ui/badge";
import { fmtDay, type ImportKind } from "./ImportWizard";

const METHOD_LABEL: Record<string, string> = {
  bank_transfer: "Bank transfer", cash: "Cash", cheque: "Cheque", card: "Card", online: "Online",
};

const category = (r: ImportPreviewRow) => (r.categoryName
  ? <span>{r.categoryName}{r.subcategoryName ? <span className="text-foreground-muted"> › {r.subcategoryName}</span> : null}</span>
  : "—");

const money = (r: ImportPreviewRow, taxNote: string) => (r.totalMinor === undefined ? "—" : (
  <div className="whitespace-nowrap">
    <span className="font-mono font-medium">{formatMoney(r.totalMinor, r.currency ?? "AED")}</span>
    {r.taxMinor ? <p className="text-[11px] text-foreground-muted">{taxNote} {formatMoney(r.taxMinor, r.currency ?? "AED")} ({r.taxPct}%)</p> : null}
  </div>
));

/** Expenses (the user, 2026-11-11: "Import option required in Expenses"). */
export const EXPENSE_IMPORT: ImportKind<ExpenseImportFieldKey> = {
  resource: "expenses",
  title: "Import expenses",
  icon: ReceiptText,
  backHref: "/expenses",
  backLabel: "Go to expenses",
  noun: ["expense", "expenses"],
  fields: EXPENSE_IMPORT_FIELDS,
  dateFields: ["date"],
  templateName: "expenses-import-template",
  permission: "expense:create",
  recordHref: (id) => `/expenses/${id}`,
  columns: [
    { header: "Date", cell: (r) => <span className="whitespace-nowrap">{fmtDay(r.date)}</span> },
    {
      header: "Description",
      cell: (r) => (
        <div className="max-w-[260px]">
          <p className="truncate">{r.description ?? "—"}</p>
          {r.reference && <p className="truncate text-[11px] text-foreground-muted">Ref {r.reference}</p>}
        </div>
      ),
    },
    { header: "Category", cell: category },
    {
      header: "Paid",
      cell: (r) => (r.status === "error" ? "—" : r.accountName
        ? <span className="whitespace-nowrap">{r.accountName}{r.paymentMethod ? <span className="text-foreground-muted"> · {METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}</span> : null}</span>
        : <span className="text-foreground-muted">Unpaid</span>),
    },
    { header: "Amount", align: "right", cell: (r) => money(r, "incl. tax") },
  ],
  notes: (
    <ul className="list-disc space-y-0.5 pl-4">
      <li>Category and subcategory are matched by name (or slug), in any case, against your expense categories.</li>
      <li>Imported expenses are approved. With a Paid from account they are paid on their date from it and show in that account; without one they stay unpaid.</li>
      <li>Old dates are fine — imported rows are history and are not sent for late-entry approval.</li>
      <li>A row already in the books (same date, total and currency, and the same reference — or description) is skipped.</li>
    </ul>
  ),
};

/** Bills (the user, 2026-11-11: "Import option required in Bills"). */
export const BILL_IMPORT: ImportKind<BillImportFieldKey> = {
  resource: "bills",
  title: "Import bills",
  icon: ShoppingCart,
  backHref: "/bills",
  backLabel: "Go to bills",
  noun: ["bill", "bills"],
  fields: BILL_IMPORT_FIELDS,
  dateFields: ["billDate", "dueDate", "paidOn"],
  templateName: "bills-import-template",
  permission: "bill:create",
  recordHref: (id) => `/bills/${id}`,
  columns: [
    {
      header: "Vendor",
      cell: (r) => (
        <div className="max-w-[200px]">
          <p className="truncate">{r.vendorName ?? "—"}</p>
          {r.newVendor && <Badge tone="primary" className="mt-0.5 text-[10px]">New vendor — will be created</Badge>}
        </div>
      ),
    },
    { header: "Bill no.", cell: (r) => <span className="font-mono text-xs">{r.billNumber ?? "—"}</span> },
    {
      header: "Dates",
      cell: (r) => (
        <div className="whitespace-nowrap">
          <p>{fmtDay(r.date)}</p>
          {r.dueDate && <p className="text-[11px] text-foreground-muted">Due {fmtDay(r.dueDate)}</p>}
        </div>
      ),
    },
    {
      header: "For",
      cell: (r) => (
        <div className="max-w-[240px]">
          <p className="truncate">{r.description ?? "—"}</p>
          <p className="truncate text-[11px] text-foreground-muted">{category(r)}</p>
        </div>
      ),
    },
    { header: "Amount", align: "right", cell: (r) => money(r, "incl. tax") },
    {
      header: "Paid",
      cell: (r) => (r.status === "error" ? "—" : r.paidOn
        ? <span className="whitespace-nowrap">{fmtDay(r.paidOn)} · {r.accountName}</span>
        : <span className="text-foreground-muted">Unpaid</span>),
    },
  ],
  notes: (
    <ul className="list-disc space-y-0.5 pl-4">
      <li>One line per bill: Amount is before tax; Tax % is added on top.</li>
      <li>Vendors are matched by name in any case. One not on file yet is created (if you may add vendors) — fill in its email and phone afterwards.</li>
      <li>Bills come in approved and unpaid. With both Paid on and Paid from they are also paid in full from that account.</li>
      <li>Old dates are fine — imported bills are history and are not sent for late-entry approval.</li>
      <li>A bill already in the books (same vendor and bill number — or same vendor, date and total) is skipped.</li>
    </ul>
  ),
};
