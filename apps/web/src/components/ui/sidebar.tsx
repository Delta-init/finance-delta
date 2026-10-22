"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import Link from "next/link";
import { ChevronRight, PanelLeft } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useUiStore } from "@/store/ui";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";

interface SidebarContextValue {
  collapsed: boolean;
  /** The remembered state has been read: only then does the width animate, so a reload doesn't play a collapse. */
  settled: boolean;
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
  const [settled, setSettled] = useState(false);

  // Minimised or not, and the open categories, as this browser left them (2026-10-22).
  useEffect(() => {
    void Promise.resolve(useUiStore.persist.rehydrate()).then(() => requestAnimationFrame(() => setSettled(true)));
  }, []);

  const toggle = () => {
    if (isMobile) setOpenMobile(!openMobile);
    else setCollapsed(!collapsed);
  };

  return (
    <SidebarContext.Provider
      // The phone's drawer is always the full menu, whatever the desktop was left as.
      value={{ collapsed: collapsed && !isMobile, settled, isMobile, openMobile, setOpenMobile, toggle }}
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
  const { collapsed, settled, isMobile, openMobile, setOpenMobile } = useSidebar();

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
        "hidden h-screen shrink-0 flex-col text-primary-foreground lg:flex",
        settled && "transition-[width] duration-200 ease-out",
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
  /** Something waiting here (approvals). Nothing is drawn for zero. */
  badge?: number;
}

export function SidebarMenuButton({
  href,
  icon,
  label,
  active,
  disabled,
  onNavigate,
  badge,
}: MenuButtonProps) {
  const { collapsed } = useSidebar();
  const base = cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
    collapsed && "justify-center px-0",
  );
  const count = badge && badge > 0 ? (badge > 99 ? "99+" : String(badge)) : "";
  const inner = (
    <>
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        {icon}
        {/* Collapsed, the count has nowhere else to go, so it sits on the icon. */}
        {collapsed && count && (
          <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-bold text-slate-900">
            {count}
          </span>
        )}
      </span>
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && count && (
        <span className="ml-auto rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold leading-none text-slate-900" aria-label={`${count} waiting`}>
          {count}
        </span>
      )}
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
      {/* Minimised, the icon sits in the middle like the categories' (it hugged the left edge). */}
      <span className={cn("relative z-10 flex w-full items-center gap-3", collapsed && "justify-center")}>
        {inner}
      </span>
    </Link>
  );
}

const countOf = (n?: number) => (n && n > 0 ? (n > 99 ? "99+" : String(n)) : "");

/**
 * A category's own row, opened and closed by a click (the user, 2026-10-22: "collapse like sidebar items, with a
 * parent like categories"). Closed, it carries what waits in it; the page you are on is marked on it.
 */
export function SidebarGroupToggle({
  label,
  icon,
  open,
  onToggle,
  badge,
  current,
  controls,
}: {
  label: string;
  icon: ReactNode;
  open: boolean;
  onToggle: () => void;
  badge?: number;
  /** The page you are on is in it. */
  current?: boolean;
  controls: string;
}) {
  const count = countOf(badge);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-white/10",
        current && !open ? "bg-white/10 text-primary-foreground" : "text-primary-foreground/80 hover:text-primary-foreground",
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
      <span className="ml-auto flex items-center gap-1.5">
        {!open && count && (
          <span className="rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold leading-none text-slate-900" aria-label={`${count} waiting`}>
            {count}
          </span>
        )}
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 opacity-60 transition-transform duration-150", open && "rotate-90")} />
      </span>
    </button>
  );
}

/** A category's items, sliding open and shut under its row. */
export function SidebarGroupItems({ open, id, children }: { open: boolean; id: string; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          id={id}
          key="items"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          className="overflow-hidden"
        >
          <div className="ml-[1.3rem] mt-0.5 border-l border-white/15 pl-1.5">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export interface FlyoutItem {
  href: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  badge?: number;
}

/**
 * Minimised, a category is one icon of its own; pointing at it (or clicking, on a touch screen) opens its pages beside
 * it, named, with what waits in each (2026-10-22: the minimised menu was some thirty unnamed icons, several alike).
 */
export function SidebarFlyout({
  label,
  icon,
  items,
  current,
  onNavigate,
}: {
  label: string;
  icon: ReactNode;
  items: FlyoutItem[];
  /** The page you are on is in it. */
  current?: boolean;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hold = () => { if (closing.current) clearTimeout(closing.current); closing.current = null; };
  const show = () => { hold(); setOpen(true); };
  const hide = () => { hold(); closing.current = setTimeout(() => setOpen(false), 160); };
  useEffect(() => hold, []);
  const total = items.reduce((n, i) => n + (i.badge && i.badge > 0 ? i.badge : 0), 0);
  const count = countOf(total);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onMouseEnter={show}
          onMouseLeave={hide}
          className={cn(
            "relative flex w-full items-center justify-center rounded-md py-2 transition-colors",
            current || open ? "bg-white/15 text-primary-foreground" : "text-primary-foreground/75 hover:bg-white/10 hover:text-primary-foreground",
          )}
        >
          <span className="relative flex h-[18px] w-[18px] items-center justify-center">
            {icon}
            {count && (
              <span className="absolute -right-2.5 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-bold text-slate-900">
                {count}
              </span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={12}
        className="w-60 p-1.5"
        onMouseEnter={hold}
        onMouseLeave={hide}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <p className="px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle">{label}</p>
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => {
            const n = countOf(item.badge);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => { setOpen(false); onNavigate?.(); }}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                    item.active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-surface-muted",
                  )}
                >
                  <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center", !item.active && "text-foreground-muted")}>{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                  {n && <span className="ml-auto rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold leading-none text-slate-900">{n}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
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
