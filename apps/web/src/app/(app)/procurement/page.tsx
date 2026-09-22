"use client";

import { useState } from "react";
import { ClipboardList, Check, X, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  useProcurementRequests, useApproveProcurement, useRejectProcurement, type ProcurementRequest,
} from "@/features/procurement/api";
import { useVendors } from "@/features/vendors/api";

/**
 * What HR has approved and finance has not yet decided.
 *
 * Approving raises the purchase order, which is why the vendor is asked for
 * here rather than in HRMS: the vendor list is ours, and half these requests
 * are written before anybody has chosen a supplier.
 */
export default function ProcurementPage() {
  const { data: requests, isLoading, error } = useProcurementRequests();
  const { data: vendors } = useVendors({ limit: 200 });
  const approve = useApproveProcurement();
  const reject = useRejectProcurement();

  const [vendorFor, setVendorFor] = useState<Record<string, string>>({});
  const [noteFor, setNoteFor] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const rows = requests ?? [];

  const onApprove = async (r: ProcurementRequest) => {
    const vendorId = vendorFor[r._id];
    if (!vendorId) return;
    setBusy(r._id);
    try {
      await approve.mutateAsync({ id: r._id, hrmsOrgId: r.hrmsOrgId, vendorId, note: noteFor[r._id] });
    } finally { setBusy(null); }
  };

  const onReject = async (r: ProcurementRequest) => {
    setBusy(r._id);
    try {
      await reject.mutateAsync({ id: r._id, hrmsOrgId: r.hrmsOrgId, note: noteFor[r._id] });
    } finally { setBusy(null); }
  };

  return (
    <div>
      <PageHeader
        title="Procurement"
        description="Purchase requests HR has approved, waiting on the money decision."
      />

      {isLoading ? (
        <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <div className="rounded-lg border border-border p-12 text-center text-muted-foreground">
          Could not reach HRMS. Check the integration settings and try again.
        </div>
      ) : !rows.length ? (
        <div className="rounded-lg border border-border p-16 text-center text-muted-foreground">
          <ClipboardList className="mx-auto mb-3 h-8 w-8 opacity-50" />
          Nothing is waiting for a decision.
        </div>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <div key={r._id} className="rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{r.quantity} × {r.item}</h3>
                    {r.resubmitCount > 0 && <Badge tone="warning">resubmitted ×{r.resubmitCount}</Badge>}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {[
                      `${r.currency} ${(r.estimatedCost || 0).toLocaleString("en-US")}`,
                      r.department?.name,
                      r.requestedBy?.name ? `asked by ${r.requestedBy.name}` : null,
                      r.neededBy ? `needed by ${String(r.neededBy).slice(0, 10)}` : null,
                    ].filter(Boolean).join(" · ")}
                  </p>
                  {r.justification && <p className="mt-1 text-sm">{r.justification}</p>}
                  {r.vendor && <p className="mt-1 text-xs text-muted-foreground">Suggested vendor: {r.vendor}</p>}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-end gap-3">
                <div className="min-w-[200px]">
                  <label className="mb-1 block text-xs text-muted-foreground">Vendor *</label>
                  <Select value={vendorFor[r._id] ?? ""} onValueChange={(v) => setVendorFor((s) => ({ ...s, [r._id]: v }))}>
                    <SelectTrigger><SelectValue placeholder="Choose a vendor" /></SelectTrigger>
                    <SelectContent>
                      {(vendors?.data ?? []).map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-[220px] flex-1">
                  <label className="mb-1 block text-xs text-muted-foreground">Note</label>
                  <Input value={noteFor[r._id] ?? ""} placeholder="Optional — sent back to HR"
                    onChange={(e) => setNoteFor((s) => ({ ...s, [r._id]: e.target.value }))} />
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => void onApprove(r)} disabled={!vendorFor[r._id] || busy === r._id}>
                    {busy === r._id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    Approve &amp; raise PO
                  </Button>
                  <Button variant="outline" onClick={() => void onReject(r)} disabled={busy === r._id}>
                    <X className="h-4 w-4" />Reject
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
