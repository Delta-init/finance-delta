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
  type LucideIcon,
} from "lucide-react";
import { hasPermission, type Permission } from "@delta/shared";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  enabled?: boolean;
  permission?: Permission;
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
      { href: "/inventory", label: "Inventory", icon: Package, enabled: true },
      { href: "/reports", label: "Reports", icon: BarChart3, enabled: true },
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
];

export function AppSidebar({
  user,
}: {
  user: { name: string; roleName: string; permissions: string[] };
}) {
  const pathname = usePathname();
  const { collapsed, setOpenMobile, isMobile } = useSidebar();

  const closeOnMobile = () => isMobile && setOpenMobile(false);

  return (
    <Sidebar>
      <SidebarHeader>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-primary font-display text-sm font-bold">
          Δ
        </span>
        {!collapsed && (
          <span className="font-display text-sm font-semibold tracking-tight">
            Delta Finance
          </span>
        )}
      </SidebarHeader>

      <SidebarContent>
        {NAV.map((group, gi) => {
          const items = group.items.filter(
            (i) => !i.permission || hasPermission(user.permissions, i.permission),
          );
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={group.label ?? gi}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarMenu>
                {items.map((item) => {
                  const active =
                    pathname === item.href ||
                    pathname.startsWith(item.href + "/");
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

      <SidebarFooter>
        <div
          className={cn(
            "flex items-center gap-2 rounded-md p-2",
            collapsed && "justify-center",
          )}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs font-semibold text-primary-foreground">
            {user.name.slice(0, 2).toUpperCase()}
          </span>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-primary-foreground">
                {user.name}
              </p>
              <p className="truncate text-xs text-primary-foreground/60">
                {user.roleName}
              </p>
            </div>
          )}
          {!collapsed && (
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              aria-label="Sign out"
              className="rounded-md p-1.5 text-primary-foreground/70 transition-colors hover:bg-white/10 hover:text-primary-foreground"
            >
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>
        {!collapsed && (
          <div className="mt-1 flex items-center gap-1 px-1 text-primary-foreground/60">
            <button className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:text-primary-foreground">
              <Settings className="h-3.5 w-3.5" /> Settings
            </button>
            <button className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:text-primary-foreground">
              <LifeBuoy className="h-3.5 w-3.5" /> Help
            </button>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
