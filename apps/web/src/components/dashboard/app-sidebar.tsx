"use client";

import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  GraduationCap,
  LayoutDashboard,
  FileText,
  ClipboardList,
  ReceiptText,
  Users2,
  ShoppingCart,
  Truck,
  Landmark,
  BarChart3,
  Package,
  ShieldCheck,
  Tags,
  Settings,
  LifeBuoy,
  LogOut,
  FileX2,
  CreditCard,
  TrendingUp,
  Building2,
  Repeat,
  Link2,
  Wallet,
  WalletCards,
  ClipboardCheck,
  type LucideIcon,
} from "lucide-react";
import { hasPermission, type Permission } from "@delta/shared";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "@/components/ui/sidebar";
import { OrgSwitcher } from "@/components/org-switcher/OrgSwitcher";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  enabled?: boolean;
  /**
   * Shown when the person holds any one of these.
   *
   * A list rather than a single permission because several now come in a broad
   * and a narrow form — somebody with `expense:read:own` belongs on the
   * expenses screen as much as somebody with `expense:read`, and gating on the
   * broad one alone hid the screen from the people it was built for.
   */
  permission?: Permission | Permission[];
  superAdminOnly?: boolean;
  /**
   * Hidden from somebody whose access is limited to their own records, unless
   * they hold one of `unhideWith`.
   *
   * A counsellor needs `customer:read` to pick or add a client while taking an
   * enrolment, but has no business browsing the customer list as a page. The
   * permission is about what a form may do; this is about what belongs in a
   * navigation menu, and the two are not the same question.
   *
   * A salesperson is own-scoped on invoices too, but manages customers as part
   * of the job — so the escape hatch is holding a permission the counsellor
   * does not, rather than a second flag somebody has to remember to set.
   */
  hideWhenOwnScopedOnly?: boolean;
  unhideWith?: Permission;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    items: [
      // Ungated deliberately: everybody needs somewhere to land, and the page
      // itself decides whether to show the company overview or the reader's
      // own work. Every other entry names what it needs, or it is a link to a
      // refusal for anybody who does not have it.
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, enabled: true },
    ],
  },
  {
    label: "Sales",
    items: [
      { href: "/quotations", label: "Quotations", icon: FileText, enabled: true, permission: "quotation:read" },
      { href: "/sales-orders", label: "Sales Orders", icon: ClipboardList, enabled: true, permission: "salesorder:read" },
      { href: "/invoices", label: "Invoices", icon: ReceiptText, enabled: true, permission: ["invoice:read", "invoice:read:own"] },
      // Only for people who can actually decide. Somebody who sees just their
      // own invoices is on the far side of this queue, and a menu item leading
      // to "not something your role does" is worse than no menu item.
      { href: "/approvals", label: "Approvals", icon: ClipboardCheck, enabled: true, permission: "invoice:write" },
      // Taking an enrolment is the counsellor's whole job, so it is its own
      // entry rather than something reached through the invoice list.
      { href: "/enrolments/new", label: "New Enrolment", icon: GraduationCap, enabled: true, permission: ["invoice:write", "invoice:write:own"] },
      { href: "/credit-notes", label: "Credit Notes", icon: FileX2, enabled: true, permission: "invoice:read" },
      { href: "/payments", label: "Payments", icon: CreditCard, enabled: true, permission: "invoice:read" },
      { href: "/customers", label: "Customers", icon: Users2, enabled: true, permission: "customer:read", hideWhenOwnScopedOnly: true, unhideWith: "customer:update" },
    ],
  },
  {
    label: "Purchases",
    items: [
      { href: "/purchase-orders", label: "Purchase Orders", icon: ClipboardList, enabled: true, permission: "po:read" },
      { href: "/procurement", label: "Procurement", icon: ClipboardList, enabled: true, permission: "po:read" },
      { href: "/bills", label: "Bills", icon: ShoppingCart, enabled: true, permission: "bill:read" },
      { href: "/vendor-credits", label: "Vendor Credits", icon: FileX2, enabled: true, permission: "bill:read" },
      { href: "/vendors", label: "Vendors", icon: Truck, enabled: true, permission: "vendor:read" },
    ],
  },
  {
    label: "Finance",
    items: [
      { href: "/expenses", label: "Expenses", icon: ReceiptText, enabled: true, permission: ["expense:read", "expense:read:own"] },
      { href: "/budgets", label: "Budgets & Funds", icon: WalletCards, enabled: true, permission: ["budget:read", "budget:read:own", "budget:manage", "budget:request", "budget:approve"] },
      { href: "/expenses/recurring", label: "Recurring", icon: Repeat, enabled: true, permission: "expense:read" },
      { href: "/banking", label: "Banking", icon: Landmark, enabled: true, permission: "banking:read" },
      // A tin is a bank account underneath, and finding it meant knowing that.
      // The people who keep one do not think of it as a bank account.
      { href: "/petty-cash", label: "Petty Cash", icon: Wallet, enabled: true, permission: "banking:read" },
      { href: "/inventory", label: "Inventory", icon: Package, enabled: true, permission: "inventory:read" },
      { href: "/reports", label: "Reports", icon: BarChart3, enabled: true, permission: "report:read" },
      { href: "/reports/daily", label: "Daily Report", icon: BarChart3, enabled: true, permission: "report:read" },
      { href: "/reports/salesperson", label: "Salesperson", icon: TrendingUp, enabled: true, permission: "report:read" },
      { href: "/reports/department", label: "Dept. Report", icon: Building2, enabled: true, permission: "report:read" },
      { href: "/commissions", label: "Commissions", icon: TrendingUp, enabled: true, permission: "commission:read" },
      { href: "/loans", label: "Loans & Credit", icon: Landmark, enabled: true, permission: "loan:read" },
      { href: "/payroll/runs", label: "Payroll", icon: Wallet, enabled: true, permission: "payroll:read" },
      { href: "/payroll/mapping", label: "Payroll Mapping", icon: Link2, enabled: true, permission: "payroll:read" },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/admin/users", label: "Users", icon: Users2, enabled: true, permission: "user:read" },
      { href: "/admin/roles", label: "Roles", icon: ShieldCheck, enabled: true, permission: "role:read" },
      { href: "/admin/departments", label: "Departments", icon: Building2, enabled: true, permission: "department:update" },
      { href: "/admin/tags", label: "Tags", icon: Tags, enabled: true, permission: "tag:read" },
      { href: "/settings", label: "Settings", icon: Settings, enabled: true, permission: "organization:read" },
    ],
  },
  {
    label: "Platform",
    items: [
      { href: "/platform", label: "All Organizations", icon: Building2, enabled: true, superAdminOnly: true },
    ],
  },
];

export function AppSidebar({
  user,
}: {
  user: {
    name: string;
    orgName: string;
    roleName: string;
    permissions: string[];
    isSuperAdmin: boolean;
  };
}) {
  const pathname = usePathname();
  /**
   * True when this person sees only their own records — they hold the narrow
   * invoice permission and not the organization-wide one.
   */
  const ownScopedOnly =
    !user.isSuperAdmin &&
    hasPermission(user.permissions, "invoice:read:own") &&
    !hasPermission(user.permissions, "invoice:read");
  const { collapsed, setOpenMobile, isMobile } = useSidebar();
  const closeOnMobile = () => isMobile && setOpenMobile(false);

  return (
    <Sidebar>
      {/* ── Org switcher header ─────────────────────────────────── */}
      <div className={cn("border-b border-white/10", collapsed ? "px-2 py-3" : "px-3 py-3")}>
        {collapsed ? (
          /* Collapsed: show just the org avatar */
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-white/20 text-xs font-bold text-primary-foreground">
            {user.orgName.slice(0, 2).toUpperCase() || "Δ"}
          </span>
        ) : (
          <OrgSwitcher />
        )}
      </div>

      {/* ── Nav ─────────────────────────────────────────────────── */}
      <SidebarContent>
        {NAV.map((group, gi) => {
          const items = group.items.filter((item) => {
            if (item.superAdminOnly && !user.isSuperAdmin) return false;
            if (
              item.hideWhenOwnScopedOnly &&
              ownScopedOnly &&
              !(item.unhideWith && hasPermission(user.permissions, item.unhideWith))
            ) {
              return false;
            }
            if (item.permission && !user.isSuperAdmin) {
              const needed = Array.isArray(item.permission) ? item.permission : [item.permission];
              if (!needed.some((p) => hasPermission(user.permissions, p))) return false;
            }
            return true;
          });
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={group.label ?? gi}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarMenu>
                {items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(item.href + "/");
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        href={item.href}
                        label={item.label}
                        icon={<item.icon className="h-4 w-4" />}
                        active={active}
                        disabled={!item.enabled}
                        onNavigate={closeOnMobile}
                      />
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      {/* ── Footer: user info ───────────────────────────────────── */}
      <SidebarFooter>
        <div className={cn("flex items-center gap-2 rounded-md p-1.5", collapsed && "justify-center")}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs font-semibold text-primary-foreground">
            {user.name.slice(0, 2).toUpperCase()}
          </span>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-primary-foreground">{user.name}</p>
                <p className="truncate text-xs text-primary-foreground/60">
                  {user.isSuperAdmin ? "Super Admin" : user.roleName}
                </p>
              </div>
              <button
                onClick={() => signOut({ callbackUrl: "/login" })}
                aria-label="Sign out"
                className="rounded-md p-1.5 text-primary-foreground/60 transition-colors hover:bg-white/10 hover:text-primary-foreground"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
        {!collapsed && (
          <div className="mt-1 flex items-center gap-1 px-1 text-primary-foreground/50">
            {/* Gated like its entry in the menu above. This copy was not, so
                somebody without organization:read was offered a link that only
                ever refused them. */}
            {(user.isSuperAdmin || hasPermission(user.permissions, "organization:read")) && (
              <a href="/settings" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:text-primary-foreground">
                <Settings className="h-3.5 w-3.5" /> Settings
              </a>
            )}
            <button className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:text-primary-foreground">
              <LifeBuoy className="h-3.5 w-3.5" /> Help
            </button>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
