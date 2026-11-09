"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ExternalLink, X } from "lucide-react";
import { NO_SUBCATEGORY } from "@delta/shared";
import { cn } from "@/lib/utils";

/*
 * A split screen (the user, 2026-11-07: "click on it and the page opens there — split screen"): a record opens in a
 * pane beside the page it was clicked on, which stays where it was. The pane is in the address (`?pane=kind:id`, its
 * own settings under `p.`), so a refresh, Back or a shared link keeps it; a link inside it opens on the left and keeps
 * the pane; "Open full page" leaves for the record's own page. On a phone it covers the screen. Salespeople, and a category budget's expenses —
 * another kind is a line in PANES.
 */

/** The address key naming what the pane shows: "salesperson:<id>". */
export const PANE_KEY = "pane";
/** What the pane's page keeps in the address (its dates, its tab) — apart from the page beside it. */
export const PANE_PREFIX = "p.";

const PersonDetail = dynamic(() => import("@/features/people/PersonDetail").then((m) => m.PersonDetail), {
  loading: () => <p className="p-6 text-sm text-foreground-muted">Loading…</p>,
});

const ExpenseListPane = dynamic(() => import("@/features/expenses/ExpenseListPane").then((m) => m.ExpenseListPane), {
  loading: () => <p className="p-6 text-sm text-foreground-muted">Loading…</p>,
});
const ExpensePane = dynamic(() => import("@/features/expenses/ExpenseListPane").then((m) => m.ExpensePane), {
  loading: () => <p className="p-6 text-sm text-foreground-muted">Loading…</p>,
});

const PANES = {
  salesperson: {
    label: "Salesperson",
    /** The record's own page, with the pane's period carried over. */
    href: (id: string, q: URLSearchParams) => {
      const keep = new URLSearchParams();
      for (const k of ["from", "to", "tab"]) { const v = q.get(PANE_PREFIX + k); if (v) keep.set(k, v); }
      const qs = keep.toString();
      return `/reports/salesperson/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`;
    },
    render: (id: string) => <PersonDetail id={id} keyPrefix={PANE_PREFIX} embedded />,
  },
  /* A category budget's breakdown (2026-11-09): what a category (p.sub: one subcategory) spent from p.from to p.to,
     in p.currency — and one of those expenses. The full page is the Expenses list with the same filters. */
  expenses: {
    label: "Expenses",
    href: (id: string, q: URLSearchParams) => {
      const p = new URLSearchParams({ category: id, status: "approved" });
      const sub = q.get(PANE_PREFIX + "sub");
      if (sub && sub !== NO_SUBCATEGORY) p.set("subcategory", sub);
      const from = q.get(PANE_PREFIX + "from"), to = q.get(PANE_PREFIX + "to");
      if (from || to) p.set("range", "custom");
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      return `/expenses?${p}`;
    },
    render: (id: string) => <ExpenseListPane category={id} />,
  },
  expense: {
    label: "Expense",
    href: (id: string) => `/expenses/${encodeURIComponent(id)}`,
    render: (id: string) => <ExpensePane id={id} onClose={closePane} />,
  },
} satisfies Record<string, { label: string; href: (id: string, q: URLSearchParams) => string; render: (id: string) => ReactNode }>;
export type PaneKind = keyof typeof PANES;

/** The address without the pane — and without what the pane kept. */
function withoutPane(search: string): URLSearchParams {
  const p = new URLSearchParams(search);
  for (const k of [...p.keys()]) if (k === PANE_KEY || k.startsWith(PANE_PREFIX)) p.delete(k);
  return p;
}
const url = (p: URLSearchParams) => { const qs = p.toString(); return `${window.location.pathname}${qs ? `?${qs}` : ""}`; };

/**
 * Open a record in the pane, with its page's own settings if given (a period: { from, to }). Opening it adds a step to
 * the history, so Back (or a phone's back) closes it again.
 */
export function openPane(kind: PaneKind, id: string, settings: Record<string, string> = {}) {
  const wasOpen = new URLSearchParams(window.location.search).has(PANE_KEY);
  const p = withoutPane(window.location.search);
  p.set(PANE_KEY, `${kind}:${id}`);
  for (const [k, v] of Object.entries(settings)) if (v) p.set(PANE_PREFIX + k, v);
  if (wasOpen) window.history.replaceState(null, "", url(p));
  else window.history.pushState(null, "", url(p));
}

export function closePane() {
  window.history.replaceState(null, "", url(withoutPane(window.location.search)));
}

/** The record's own page, for a link's href (a new tab, Ctrl/Cmd-click). */
export function paneHref(kind: PaneKind, id: string) {
  return PANES[kind].href(id, new URLSearchParams());
}

/**
 * Click handling for a link that opens in the pane: a plain click opens it here; Ctrl/Cmd/Shift/middle-click is left
 * to the browser (a new tab or window, on the record's own page). Never also the row's own click.
 */
export function paneClick(kind: PaneKind, id: string) {
  return (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openPane(kind, id);
  };
}

const WIDTH_KEY = "finance.pane.width";
const MIN = 380;

/** The page and, beside it when one is open, the pane. Replaces the layout's <main>. */
export function SplitShell({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  return (
    <div ref={box} className="flex min-h-0 flex-1">
      <main className="min-w-0 flex-1 overflow-y-auto bg-background">{children}</main>
      <Suspense fallback={null}><Pane box={box} /></Suspense>
    </div>
  );
}

function Pane({ box }: { box: React.RefObject<HTMLDivElement | null> }) {
  const search = useSearchParams();
  const router = useRouter();
  const raw = search.get(PANE_KEY) ?? "";
  const at = raw.indexOf(":");
  const kind = (at > 0 ? raw.slice(0, at) : "") as PaneKind;
  const id = at > 0 ? raw.slice(at + 1) : "";
  const pane = id && kind in PANES ? PANES[kind] : null;

  // Its width, as the person last left it (on this browser) — half the page at first.
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
  }
  function drag(e: PointerEvent<HTMLDivElement>) {
    if (!dragging.current || !box.current) return;
    setWidth(clamp(box.current.getBoundingClientRect().right - e.clientX));
  }
  function endDrag() {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.userSelect = "";
    try { if (width) window.localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* not kept */ }
  }

  // Esc closes it — unless a dialog is open, which Esc closes first.
  useEffect(() => {
    if (!pane) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]')) return;
      closePane();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pane]);

  if (!pane) return null;

  /* A link inside the pane opens on the left and the pane stays: the pane's part of the address goes along. A new tab,
     an outside link or "Open full page" (data-pane-exit) is left alone. */
  function keepPane(e: MouseEvent<HTMLDivElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (!a || a.target === "_blank" || a.hasAttribute("download") || a.hasAttribute("data-pane-exit")) return;
    const to = new URL(a.href, window.location.href);
    if (to.origin !== window.location.origin) return;
    e.preventDefault();
    const now = new URLSearchParams(window.location.search);
    for (const [k, v] of now) if (k === PANE_KEY || k.startsWith(PANE_PREFIX)) to.searchParams.set(k, v);
    router.push(`${to.pathname}${to.search}${to.hash}`);
  }

  return (
    <aside
      aria-label={`${pane.label} pane`}
      style={width ? ({ "--pane-w": `${width}px` } as React.CSSProperties) : undefined}
      className={cn(
        "fixed inset-0 z-40 flex flex-col bg-background",
        "md:relative md:inset-auto md:z-auto md:w-[var(--pane-w,50%)] md:min-w-[380px] md:max-w-[calc(100%-360px)] md:shrink-0 md:border-l md:border-border",
      )}
    >
      {/* The divider: drag to make the pane wider or narrower. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the pane"
        title="Drag to resize"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => { setWidth(null); try { window.localStorage.removeItem(WIDTH_KEY); } catch { /* fine */ } }}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize md:block hover:bg-primary/20 active:bg-primary/30"
      />
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">{pane.label}</span>
        <div className="flex items-center gap-1">
          <Link
            href={pane.href(id, new URLSearchParams(search.toString()))}
            data-pane-exit
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-foreground-muted hover:bg-surface-muted hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open full page
          </Link>
          <button
            type="button"
            onClick={closePane}
            aria-label="Close the pane"
            title="Close (Esc)"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" onClickCapture={keepPane}>
        {/* A different record starts fresh. */}
        <div key={raw}>{pane.render(id)}</div>
      </div>
    </aside>
  );
}
