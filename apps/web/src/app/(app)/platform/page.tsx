"use client";

import { useState } from "react";
import { Building2 } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { usePlatformOrgs, useCreateOrg } from "@/features/platform/api";
import { toast } from "@/lib/toast";
import type { ApiError } from "@/lib/api";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR", "QAR", "KWD"] as const;

export default function PlatformOrgsPage() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [baseCurrency, setBaseCurrency] = useState("AED");

  const { data: orgs, isLoading } = usePlatformOrgs();
  const { mutate: createOrg, isPending } = useCreateOrg();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    createOrg(
      { name: name.trim(), legalName: legalName.trim() || undefined, baseCurrency },
      {
        onSuccess: () => {
          toast.success("Organization created");
          setOpen(false);
          setName("");
          setLegalName("");
          setBaseCurrency("AED");
        },
        onError: (err: unknown) => {
          const apiErr = err as ApiError;
          toast.error(apiErr?.message ?? "Failed to create organization");
        },
      },
    );
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Building2}
        title="Organizations"
        description="Manage all organizations across the platform."
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>New Organization</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New Organization</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4 pt-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground" htmlFor="org-name">
                    Name <span className="text-danger">*</span>
                  </label>
                  <Input
                    id="org-name"
                    placeholder="Acme Corp"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground" htmlFor="org-legal-name">
                    Legal Name <span className="text-foreground-muted text-xs font-normal">(optional)</span>
                  </label>
                  <Input
                    id="org-legal-name"
                    placeholder="Acme Corporation LLC"
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground" htmlFor="org-currency">
                    Base Currency
                  </label>
                  <select
                    id="org-currency"
                    value={baseCurrency}
                    onChange={(e) => setBaseCurrency(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isPending || !name.trim()}>
                    {isPending ? "Creating…" : "Create"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="rounded-xl border border-border bg-surface">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-sm text-foreground-muted">
            Loading organizations…
          </div>
        ) : !orgs?.length ? (
          <div className="flex items-center justify-center py-16 text-sm text-foreground-muted">
            No organizations yet. Create the first one.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-4 px-5 py-3 text-xs font-medium uppercase tracking-wide text-foreground-muted">
              <span>Name</span>
              <span>Legal Name</span>
              <span>Currency</span>
              <span>Members</span>
              <span>Created</span>
            </div>
            {orgs.map((org) => (
              <Link
                key={org.id}
                href={`/platform/${org.id}/members`}
                className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-4 px-5 py-4 items-center hover:bg-surface-muted transition-colors cursor-pointer"
              >
                <span className="font-medium text-foreground truncate">{org.name}</span>
                <span className="text-sm text-foreground-muted truncate">
                  {org.legalName || <span className="italic opacity-50">—</span>}
                </span>
                <Badge tone="primary">{org.baseCurrency}</Badge>
                <Badge tone="neutral">{org.memberCount} {org.memberCount === 1 ? "member" : "members"}</Badge>
                <span className="text-sm text-foreground-muted whitespace-nowrap">
                  {new Date(org.createdAt).toLocaleDateString()}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
