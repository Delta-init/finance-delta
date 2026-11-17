"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardCheck, LayoutDashboard, Menu, Receipt, ReceiptText, type LucideIcon } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import { useMenuPages } from "@/components/split-view/side-page";
import { useApprovalSummary } from "@/features/approvals/api";
import { cn } from "@/lib/utils";

/*
 * The phone's dock (the user, 2026-11-17: "mobile responsive… dock bottom nav"): Home, Approvals, Invoices, Expenses —
 * each only for somebody whose menu has it (the menu publishes the pages a person may open, useMenuPages) — and More,
 * the whole menu. Phones only (below md); hidden inside the split screen's side page (data-app-chrome, globals.css).
 */
const DOCK: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/approvals", label: "Approvals", icon: ClipboardCheck },
  { href: "/invoices", label: "Invoices", icon: ReceiptText },
  { href: "/expenses", label: "Expenses", icon: Receipt },
];

export function MobileDock() {
  const pathname = usePathname();
  const pages = useMenuPages((s) => s.pages);
  const { openMobile, setOpenMobile } = useSidebar();
  const mine = new Set(pages.map((p) => p.href));
  // Until the menu has said what this person may open, Home alone — never a link to a refusal.
  const items = DOCK.filter((d) => d.href === "/dashboard" || mine.has(d.href));
  const approver = mine.has("/approvals");
  const { data: waiting } = useApprovalSummary(approver);
  const active = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    <nav
      aria-label="Quick menu"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
    >
      <div className="grid" style={{ gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))` }}>
        {items.map((d) => {
          const on = active(d.href) && !openMobile;
          const count = d.href === "/approvals" ? waiting?.total ?? 0 : 0;
          return (
            <Link
              key={d.href}
              href={d.href}
              onClick={() => setOpenMobile(false)}
              aria-current={on ? "page" : undefined}
              className={cn(
                "relative flex flex-col items-center gap-0.5 px-1 pb-1.5 pt-2 text-[11px] font-medium transition-colors",
                on ? "text-primary" : "text-foreground-muted active:text-foreground",
              )}
            >
              <d.icon className="h-5 w-5" />
              <span className="truncate">{d.label}</span>
              {count > 0 && (
                <span className="absolute left-1/2 top-1 ml-1.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white tabular-nums">
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setOpenMobile(!openMobile)}
          aria-expanded={openMobile}
          className={cn(
            "flex flex-col items-center gap-0.5 px-1 pb-1.5 pt-2 text-[11px] font-medium transition-colors",
            openMobile ? "text-primary" : "text-foreground-muted active:text-foreground",
          )}
        >
          <Menu className="h-5 w-5" />
          <span>More</span>
        </button>
      </div>
    </nav>
  );
}
