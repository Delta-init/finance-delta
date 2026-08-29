import type { ReactNode } from "react";
import { LoginShowcase } from "@/features/auth/LoginShowcase";

/**
 * The signed-out layout, shared by every page somebody can reach before they
 * have an account to sign in with. Lifted from the login page rather than
 * copied, so the three of them cannot drift apart.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-screen w-full max-w-full overflow-hidden bg-surface lg:grid-cols-2">
      <div className="relative flex flex-col px-6 py-8 sm:px-10 lg:px-12">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary font-display text-sm font-bold text-primary-foreground">
            Δ
          </span>
          <span className="font-display text-sm font-semibold tracking-tight">Delta Finance</span>
        </div>
        <div className="flex flex-1 items-center justify-center py-10">{children}</div>
      </div>
      <div className="hidden p-3 lg:block">
        <LoginShowcase />
      </div>
    </div>
  );
}
