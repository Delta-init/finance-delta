import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Per-page content header: icon + title + description + optional action — on a phone the action goes under the title
 *  (2026-11-17), so neither is squeezed. */
export function PageHeader({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-700">
            <Icon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-0.5 text-sm text-foreground-muted">{description}</p>
          )}
        </div>
      </div>
      {/* Pages pass their buttons in a row of their own; on a narrow screen that row wraps rather than running off the
          edge ([&>div]: the page's own row). */}
      {action && <div className="flex flex-wrap items-center gap-2 sm:shrink-0 [&>div]:flex-wrap">{action}</div>}
    </div>
  );
}
