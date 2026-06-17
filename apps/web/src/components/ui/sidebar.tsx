"use client";

import {
  createContext,
  useContext,
  type ReactNode,
  type ComponentProps,
} from "react";
import Link from "next/link";
import { PanelLeft } from "lucide-react";
import { motion } from "framer-motion";
import { useUiStore } from "@/store/ui";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";

interface SidebarContextValue {
  collapsed: boolean;
  isMobile: boolean;
  openMobile: boolean;
  setOpenMobile: (v: boolean) => void;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within <SidebarProvider>");
  return ctx;
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const setCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const openMobile = useUiStore((s) => s.mobileSidebarOpen);
  const setOpenMobile = useUiStore((s) => s.setMobileSidebarOpen);
  const isMobile = useIsMobile();

  const toggle = () => {
    if (isMobile) setOpenMobile(!openMobile);
    else setCollapsed(!collapsed);
  };

  return (
    <SidebarContext.Provider
      value={{ collapsed, isMobile, openMobile, setOpenMobile, toggle }}
    >
      {/* inset variant: primary canvas; content floats as a card on top */}
      <div  className="flex min-h-screen w-full bg-primary  ">
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

const WIDTH = "w-64";
const WIDTH_COLLAPSED = "w-[4.5rem]";

export function Sidebar({ children }: { children: ReactNode }) {
  const { collapsed, isMobile, openMobile, setOpenMobile } = useSidebar();

  if (isMobile) {
    return (
      <>
        <div
          className={cn(
            "fixed inset-0 z-40 bg-neutral-900/40 backdrop-blur-sm transition-opacity lg:hidden",
            openMobile ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={() => setOpenMobile(false)}
        />
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-primary text-primary-foreground transition-transform lg:hidden",
            openMobile ? "translate-x-0" : "-translate-x-full",
          )}
        >
          {children}
        </aside>
      </>
    );
  }

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        "hidden h-screen shrink-0 flex-col text-primary-foreground transition-[width] duration-200 ease-out lg:flex",
        collapsed ? WIDTH_COLLAPSED : WIDTH,
      )}
    >
      {children}
    </aside>
  );
}

export function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-14 items-center gap-2 border-b border-white/10 px-4",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex-1 overflow-y-auto overflow-x-hidden py-3", className)}
      {...props}
    />
  );
}

export function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("border-t border-white/10 p-2", className)}
      {...props}
    />
  );
}

export function SidebarGroup({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-2 py-2", className)} {...props} />;
}

export function SidebarGroupLabel({
  className,
  ...props
}: ComponentProps<"div">) {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return (
    <div
      className={cn(
        "px-3 pb-1.5 pt-1 text-xs font-medium uppercase tracking-wider text-primary-foreground/20",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return <ul className={cn("flex flex-col gap-0.5", className)} {...props} />;
}

export function SidebarMenuItem(props: ComponentProps<"li">) {
  return <li {...props} />;
}

interface MenuButtonProps {
  href: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onNavigate?: () => void;
}

export function SidebarMenuButton({
  href,
  icon,
  label,
  active,
  disabled,
  onNavigate,
}: MenuButtonProps) {
  const { collapsed } = useSidebar();
  const base = cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
    collapsed && "justify-center px-0",
  );
  const inner = (
    <>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && disabled && (
        <span className="ml-auto rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground/60">
          Soon
        </span>
      )}
    </>
  );

  if (disabled) {
    return (
      <div
        title={collapsed ? `${label} (coming soon)` : undefined}
        className={cn(base, "cursor-default text-primary-foreground/40")}
        aria-disabled
      >
        {inner}
      </div>
    );
  }

  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      onClick={onNavigate}
      className={cn(
        base,
        "relative",
        active
          ? "text-primary-foreground"
          : "text-primary-foreground/75 hover:bg-white/10 hover:text-primary-foreground",
      )}
    >
      {active && (
        <motion.div
          layoutId="nav-active-pill"
          className="absolute inset-0 rounded-md bg-white/15 shadow-sm"
          transition={{ type: "spring", stiffness: 500, damping: 40, mass: 0.8 }}
        />
      )}
      <span className="relative z-10 flex items-center gap-3 w-full">
        {inner}
      </span>
    </Link>
  );
}

export function SidebarTrigger({ className }: { className?: string }) {
  const { toggle } = useSidebar();
  return (
    <button
      onClick={toggle}
      aria-label="Toggle sidebar"
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground",
        className,
      )}
    >
      <PanelLeft className="h-[18px] w-[18px]" />
    </button>
  );
}

/** Inset content card — floats on the primary canvas with rounded corners. */
export function SidebarInset({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-lg",
        "m-2 h-[calc(100vh-1rem)] lg:ml-0",
        className,
      )}
      {...props}
    />
  );
}
