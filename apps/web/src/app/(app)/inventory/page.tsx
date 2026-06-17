import { Package } from "lucide-react";

export default function InventoryPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-muted">
        <Package className="h-8 w-8 text-foreground-subtle" />
      </div>
      <div className="max-w-sm">
        <h1 className="text-lg font-semibold text-foreground">Inventory</h1>
        <p className="mt-2 text-sm text-foreground-muted">
          Track stock levels, manage items, and monitor inventory value.
        </p>
        <p className="mt-4 text-xs text-foreground-subtle">Coming soon</p>
      </div>
    </div>
  );
}
