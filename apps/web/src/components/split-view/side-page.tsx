"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type MouseEvent, type PointerEvent, type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { ArrowLeft, ArrowLeftRight, ChevronDown, Clock, ExternalLink, PanelRight, Search, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/*
 * Any finance page beside the one you are on (the user, 2026-11-17: "a split screen option on every page"). The right
 * side is the same site in a frame named PANE_NAME, which shows the page without the menu and the top bar (the
 * <html data-embed> set before the first paint, app/layout.tsx, and globals.css) — so every page works there as it
 * is: its own scroll, filters, searches and saves. The side's page is kept in the address (?side=/invoices/…), so a
 * refresh or a shared link keeps the split; it stays open while you move around on the left, and closes with Esc or ×.
 *
 * Opened from: the top bar's Split button or Cmd/Ctrl + \ (a page picker), the menu's "Open beside" icon, Shift-click
 * on any link, and a list row's "Open beside" icon (DataTable `rowHref`). On a phone a page simply opens full screen.
 * Switching between the sides refreshes what the side you come back to shows, so a save on one is seen on the other.
 */

export const PANE_NAME = "finance-pane";
export const SIDE_KEY = "side";
const WIDTH_KEY = "finance.side.width";
const RECENT_KEY = "finance.side.recent";
const MIN = 380;
const MSG = "finance-pane:at";

export function isEmbedded(): boolean {
  try { return typeof window !== "undefined" && window.name === PANE_NAME; } catch { return false; }
}

/** An address inside finance, made safe to put in the pane: its path and query, never the pane's own keys. */
export function cleanPath(raw: string | null | undefined): string | null {
  if (!raw || typeof window === "undefined") return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (url.pathname.startsWith("/api/") || url.pathname === "/login" || url.pathname === "/sso") return null;
    url.searchParams.delete(SIDE_KEY);
    url.searchParams.delete("pane");
    for (const k of [...url.searchParams.keys()]) if (k.startsWith("p.")) url.searchParams.delete(k);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/* ── The menu's pages, for the picker and the pane's title (the sidebar publishes what this person may open) ── */

export interface MenuPage { href: string; label: string }
export const useMenuPages = create<{ pages: MenuPage[]; set: (p: MenuPage[]) => void }>()((set) => ({
  pages: [],
  set: (pages) => set({ pages }),
}));

/** "Invoices", "Invoices › Detail", "Expenses › Recurring" — from the menu, else the address. */
export function pageLabel(path: string, pages: MenuPage[]): string {
  const p = path.split("?")[0] || "/";
  const hit = pages.filter((m) => p === m.href || p.startsWith(m.href + "/")).sort((a, b) => b.href.length - a.href.length)[0];
  const rest = (hit ? p.slice(hit.href.length) : p).split("/").filter(Boolean);
  const words = rest.map((s) => (/^[0-9a-f]{24}$/i.test(s) ? "Detail" : s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " ")));
  return [hit?.label, ...words].filter(Boolean).join(" › ") || "Page";
}

function readRecent(): MenuPage[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(v) ? v.slice(0, 8) : []; } catch { return []; }
}
function remember(page: MenuPage) {
  try {
    const list = [page, ...readRecent().filter((r) => r.href !== page.href)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* not remembered */ }
}

/* ── The state ───────────────────────────────────────────────────────────── */

interface SplitState {
  embedded: boolean;
  side: string | null;
  openBeside: (path: string) => void;
  closeSide: () => void;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
}
const SplitContext = createContext<SplitState>({
  embedded: false, side: null, openBeside: () => {}, closeSide: () => {}, pickerOpen: false, setPickerOpen: () => {},
});
export const useSplit = () => useContext(SplitContext);

const wideEnough = () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;

export function SplitProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => setEmbedded(isEmbedded()), []);
  const [side, setSide] = useState<string | null>(null);
  /** What the frame was told to load: changed only by opening a page, never by the frame moving on by itself. */
  const [src, setSrc] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const pages = useMenuPages((s) => s.pages);

  // From the address, once: a refresh or a shared link opens the side page.
  useEffect(() => {
    if (isEmbedded()) return;
    const s = cleanPath(new URL(window.location.href).searchParams.get(SIDE_KEY));
    if (s) { setSide(s); setSrc(s); }
  }, []);

  // …and back into it, whatever the left side does: moving to another page keeps the side page open.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onPop = () => setTick((n) => n + 1);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (embedded) return;
    const url = new URL(window.location.href);
    const now = url.searchParams.get(SIDE_KEY);
    if (side && now !== side) url.searchParams.set(SIDE_KEY, side);
    else if (!side && now) url.searchParams.delete(SIDE_KEY);
    else return;
    window.history.replaceState(window.history.state, "", url);
  }, [side, pathname, tick, embedded]);

  // The left side's pages, for the picker's "Recent".
  useEffect(() => {
    if (embedded || !pathname) return;
    const path = cleanPath(`${pathname}${window.location.search}`);
    if (path && pages.length) remember({ href: path, label: pageLabel(path, pages) });
  }, [pathname, pages, embedded]);

  const openBeside = useCallback((raw: string) => {
    const path = cleanPath(raw);
    if (!path) return;
    if (!wideEnough()) { router.push(path); return; }
    // One pane at a time: a record pane (?pane=) gives way.
    const url = new URL(window.location.href);
    if (url.searchParams.has("pane")) {
      url.searchParams.delete("pane");
      for (const k of [...url.searchParams.keys()]) if (k.startsWith("p.")) url.searchParams.delete(k);
      window.history.replaceState(window.history.state, "", url);
    }
    setSide(path);
    setSrc(path);
    setPickerOpen(false);
  }, [router]);
  const closeSide = useCallback(() => { setSide(null); setSrc(null); }, []);

  // Where the frame has got to, as it moves on by itself (its links, its own filters).
  useEffect(() => {
    if (embedded) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: string; path?: string } | null;
      if (d?.type !== MSG) return;
      const p = cleanPath(d.path);
      if (p) setSide(p);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [embedded]);

  // Coming back to a side refreshes what it shows (a save on the other side is seen) — at most every few seconds.
  useEffect(() => {
    if (!embedded && !side) return;
    let last = 0;
    const onFocus = () => {
      const now = Date.now();
      if (now - last < 3000) return;
      last = now;
      void qc.invalidateQueries({ refetchType: "active" });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [embedded, side, qc]);

  // Cmd/Ctrl + \ : the picker, or closes the side page when one is open.
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "\\" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      if (side) closeSide(); else setPickerOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded, side, closeSide]);

  // Inside the frame: tell the page around it where it is now — its page, and its filters as they change.
  useEffect(() => {
    if (!embedded) return;
    let last = "";
    const tell = () => {
      const at = `${window.location.pathname}${window.location.search}`;
      if (at === last) return;
      last = at;
      try { window.parent.postMessage({ type: MSG, path: at }, window.location.origin); } catch { /* fine */ }
    };
    tell();
    const t = window.setInterval(tell, 1000);
    return () => window.clearInterval(t);
  }, [embedded, pathname]);

  const value = useMemo(() => ({ embedded, side, openBeside, closeSide, pickerOpen, setPickerOpen }), [embedded, side, openBeside, closeSide, pickerOpen]);
  return (
    <SplitContext.Provider value={value}>
      <FrameRef.Provider value={{ frame, src }}>{children}</FrameRef.Provider>
      {!embedded && <PagePicker />}
    </SplitContext.Provider>
  );
}

const FrameRef = createContext<{ frame: React.RefObject<HTMLIFrameElement | null>; src: string | null }>({ frame: { current: null }, src: null });

/** Shift-click on a link opens it beside (the left side only). */
export function onShiftClickOpenBeside(e: MouseEvent<HTMLElement>, openBeside: (p: string) => void) {
  if (!e.shiftKey || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
  const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
  const path = cleanPath(a.href);
  if (!path || !wideEnough()) return;
  e.preventDefault();
  e.stopPropagation();
  openBeside(path);
}

/* ── The side page ───────────────────────────────────────────────────────── */

export function SidePage({ box }: { box: React.RefObject<HTMLDivElement | null> }) {
  const { side, closeSide, openBeside, setPickerOpen } = useSplit();
  const { frame, src } = useContext(FrameRef);
  const router = useRouter();
  const pages = useMenuPages((s) => s.pages);
  const [loading, setLoading] = useState(true);
  useEffect(() => { setLoading(true); }, [src]);

  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    try { const w = Number(window.localStorage.getItem(WIDTH_KEY)); if (w >= MIN) setWidth(w); } catch { /* none kept */ }
  }, []);
  const dragging = useRef(false);
  const clamp = useCallback((w: number) => {
    const total = box.current?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.round(Math.min(Math.max(w, MIN), Math.max(MIN, total - 360)));
  }, [box]);
  function startDrag(e: PointerEvent<HTMLDivElement>) {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    // The frame would swallow the pointer while dragging over it.
    if (frame.current) frame.current.style.pointerEvents = "none";
  }
  function drag(e: PointerEvent<HTMLDivElement>) {
    if (!dragging.current || !box.current) return;
    setWidth(clamp(box.current.getBoundingClientRect().right - e.clientX));
  }
  function endDrag() {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.userSelect = "";
    if (frame.current) frame.current.style.pointerEvents = "";
    try { if (width) window.localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* not kept */ }
  }

  // Esc closes it — unless a dialog is open on this side, which Esc closes first.
  useEffect(() => {
    if (!side) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]')) return;
      closeSide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [side, closeSide]);

  if (!side || !src) return null;
  const label = pageLabel(side, pages);
  const mainPath = () => cleanPath(`${window.location.pathname}${window.location.search}`) ?? "/dashboard";
  const iconBtn = "inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground";

  return (
    <aside
      aria-label={`${label} — beside`}
      style={width ? ({ "--side-w": `${width}px` } as React.CSSProperties) : undefined}
      className="relative flex w-[var(--side-w,50%)] min-w-[380px] max-w-[calc(100%-360px)] shrink-0 flex-col border-l border-border bg-background"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize"
        title="Drag to resize · double-click for half"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => { setWidth(null); try { window.localStorage.removeItem(WIDTH_KEY); } catch { /* fine */ } }}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-primary/20 active:bg-primary/30"
      />
      <div className="flex items-center gap-1 border-b border-border bg-surface px-2 py-1.5">
        <button type="button" className={iconBtn} title="Back" aria-label="Back" onClick={() => { try { frame.current?.contentWindow?.history.back(); } catch { /* fine */ } }}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          title="Open another page here"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-sm hover:bg-surface-muted"
        >
          <PanelRight className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
          <span className="truncate font-medium">{label}</span>
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground-muted" />
        </button>
        <button
          type="button" className={iconBtn} title="Swap sides" aria-label="Swap sides"
          onClick={() => { const left = mainPath(); const right = side; openBeside(left); router.push(right); }}
        >
          <ArrowLeftRight className="h-4 w-4" />
        </button>
        <button type="button" className={iconBtn} title="Open full page" aria-label="Open full page" onClick={() => { const to = side; closeSide(); router.push(to); }}>
          <ExternalLink className="h-4 w-4" />
        </button>
        <button type="button" className={iconBtn} title="Close (Esc)" aria-label="Close" onClick={closeSide}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {loading && <p className="absolute inset-x-0 top-6 text-center text-sm text-foreground-muted">Loading…</p>}
        <iframe
          ref={frame}
          key={src}
          name={PANE_NAME}
          src={src}
          title={label}
          onLoad={() => setLoading(false)}
          className={cn("h-full w-full border-0 bg-background", loading && "opacity-0")}
        />
      </div>
    </aside>
  );
}

/* ── The picker: recent pages and every menu page ─────────────────────────── */

function PagePicker() {
  const { pickerOpen, setPickerOpen, openBeside } = useSplit();
  const pages = useMenuPages((s) => s.pages);
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<MenuPage[]>([]);
  useEffect(() => { if (pickerOpen) { setRecent(readRecent()); setQ(""); } }, [pickerOpen]);
  const needle = q.trim().toLowerCase();
  const match = (p: MenuPage) => !needle || p.label.toLowerCase().includes(needle) || p.href.toLowerCase().includes(needle);
  const recentShown = recent.filter(match).slice(0, 6);
  const pagesShown = pages.filter(match);
  const row = (p: MenuPage, icon: ReactNode) => (
    <button
      key={`${p.href}`}
      type="button"
      onClick={() => openBeside(p.href)}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-muted"
    >
      {icon}
      <span className="truncate">{p.label}</span>
      <span className="ml-auto truncate text-xs text-foreground-muted">{p.href.split("?")[0]}</span>
    </button>
  );
  return (
    <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Open a page beside</DialogTitle>
          <DialogDescription>It opens on the right, next to this one. Shift-click any link to do the same.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { const first = recentShown[0] ?? pagesShown[0]; if (first) openBeside(first.href); } }}
            placeholder="Search pages…"
            className="pl-8"
          />
        </div>
        <div className="max-h-[50vh] space-y-3 overflow-y-auto">
          {recentShown.length > 0 && (
            <div>
              <p className="px-2.5 pb-1 text-xs font-medium text-foreground-muted">Recent</p>
              {recentShown.map((p) => row(p, <Clock className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />))}
            </div>
          )}
          <div>
            <p className="px-2.5 pb-1 text-xs font-medium text-foreground-muted">Pages</p>
            {pagesShown.length ? pagesShown.map((p) => row(p, <PanelRight className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />))
              : <p className="px-2.5 py-2 text-sm text-foreground-muted">No page matches.</p>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Open beside" — for the menu and list rows. Nothing inside the side page itself, nor on a phone. */
export function OpenBesideButton({ href, className, label = "Open beside" }: { href: string; className?: string; label?: string }) {
  const { embedded, openBeside } = useSplit();
  if (embedded) return null;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); openBeside(href); }}
      className={cn("hidden md:inline-flex h-7 w-7 items-center justify-center rounded text-foreground-muted hover:bg-surface-muted hover:text-foreground", className)}
    >
      <PanelRight className="h-3.5 w-3.5" />
    </button>
  );
}
