"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/*
 * Back (the user, 2026-11-17: "in the nav a back button"): to the page you came from, the way the browser's back
 * does — but only to a finance page. Opened straight from a link, a new tab or a bookmark there is no finance page to
 * go back to, so it goes up a level instead (Banking › Detail → Banking), and on a top page with nowhere to go it
 * isn't shown.
 *
 * The pages visited in this tab are kept in sessionStorage — a page opened again after one before it is the browser's
 * back, so it comes off the trail rather than onto it. Only the path counts: a filter changed in the address isn't a
 * page.
 */
const TRAIL_KEY = "finance-nav-trail";
const TRAIL_MAX = 50;

function readTrail(): string[] {
  try {
    const t = JSON.parse(window.sessionStorage.getItem(TRAIL_KEY) ?? "[]");
    return Array.isArray(t) ? t.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** The finance pages visited in this tab, the current one last. */
function useTrail(): string[] {
  const pathname = usePathname();
  const [trail, setTrail] = useState<string[]>([]);
  useEffect(() => {
    if (!pathname) return;
    const t = readTrail();
    if (t[t.length - 1] === pathname) {
      // The same page again — a refresh.
    } else if (t[t.length - 2] === pathname) {
      t.pop(); // back
    } else {
      t.push(pathname);
    }
    const next = t.slice(-TRAIL_MAX);
    try { window.sessionStorage.setItem(TRAIL_KEY, JSON.stringify(next)); } catch { /* private mode: the trail is this page */ }
    setTrail(next);
  }, [pathname]);
  return trail;
}

export function BackButton({ parentHref, className }: { parentHref: string | null; className?: string }) {
  const router = useRouter();
  const trail = useTrail();
  const canGoBack = trail.length >= 2;
  if (!canGoBack && !parentHref) return null;
  return (
    <button
      type="button"
      onClick={() => (canGoBack ? router.back() : parentHref && router.push(parentHref))}
      aria-label="Back"
      title="Back"
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground",
        "w-9 justify-center md:w-auto md:border md:border-border md:px-2.5",
        className,
      )}
    >
      <ArrowLeft className="h-[18px] w-[18px] md:h-4 md:w-4" />
      <span className="hidden md:inline">Back</span>
    </button>
  );
}
