"use client";

import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
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
  permission?: Permission;
  superAdminOnly?: boolean;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, enabled: true },
    ],
  },
  {
    label: "Sales",
    items: [
      { href: "/quotations", label: "Quotations", icon: FileText, enabled: true, permission: "quotation:read" },
      { href: "/sales-orders", label: "Sales Orders", icon: ClipboardList, enabled: true, permission: "salesorder:read" },
      { href: "/invoices", label: "Invoices", icon: ReceiptText, enabled: true, permission: "invoice:read" },
      { href: "/credit-notes", label: "Credit Notes", icon: FileX2, enabled: true, permission: "invoice:read" },
      { href: "/payments", label: "Payments", icon: CreditCard, enabled: true, permission: "invoice:read" },
      { href: "/customers", label: "Customers", icon: Users2, enabled: true, permission: "customer:read" },
    ],
  },
  {
    label: "Purchases",
    items: [
      { href: "/purchase-orders", label: "Purchase Orders", icon: ClipboardList, enabled: true, permission: "po:read" },
      { href: "/bills", label: "Bills", icon: ShoppingCart, enabled: true, permission: "bill:read" },
      { href: "/vendor-credits", label: "Vendor Credits", icon: FileX2, enabled: true, permission: "bill:read" },
      { href: "/vendors", label: "Vendors", icon: Truck, enabled: true, permission: "vendor:read" },
    ],
  },
  {
    label: "Finance",
    items: [
      { href: "/expenses", label: "Expenses", icon: ReceiptText, enabled: true, permission: "expense:read" },
      { href: "/banking", label: "Banking", icon: Landmark, enabled: true },
      { href: "/inventory", label: "Inventory", icon: Package, enabled: true, permission: "inventory:read" },
      { href: "/reports", label: "Reports", icon: BarChart3, enabled: true },
      { href: "/commissions", label: "Commissions", icon: TrendingUp, enabled: true, permission: "commission:read" },
      { href: "/loans", label: "Loans & Credit", icon: Landmark, enabled: true, permission: "loan:read" },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/admin/users", label: "Users", icon: Users2, enabled: true, permission: "user:read" },
      { href: "/admin/roles", label: "Roles", icon: ShieldCheck, enabled: true, permission: "role:read" },
      { href: "/admin/tags", label: "Tags", icon: Tags, enabled: true, permission: "tag:read" },
      { href: "/settings", label: "Settings", icon: Settings, enabled: true },
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
            if (item.permission && !user.isSuperAdmin && !hasPermission(user.permissions, item.permission)) return false;
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
            <a href="/settings" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:text-primary-foreground">
              <Settings className="h-3.5 w-3.5" /> Settings
            </a>
            <button className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:text-primary-foreground">
              <LifeBuoy className="h-3.5 w-3.5" /> Help
            </button>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
