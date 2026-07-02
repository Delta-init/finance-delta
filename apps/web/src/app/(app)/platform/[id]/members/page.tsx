"use client";

import { use, useState } from "react";
import { Users, Trash2, ArrowLeft } from "lucide-react";
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
import { usePlatformOrgs, usePlatformMembers, useInviteMember, useRemoveMember, useOrgRoles } from "@/features/platform/api";
import { toast } from "@/lib/toast";
import type { ApiError } from "@/lib/api";

function getMemberStatusTone(status: string): "success" | "danger" | "neutral" {
  if (status === "active") return "success";
  if (status === "suspended") return "danger";
  return "neutral";
}

export default function OrgMembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [memberName, setMemberName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [password, setPassword] = useState("");

  const { data: orgs } = usePlatformOrgs();
  const org = orgs?.find((o) => o.id === id);

  const { data: members, isLoading } = usePlatformMembers(id);
  const { data: roles = [] } = useOrgRoles(id);
  const { mutate: inviteMember, isPending: inviting } = useInviteMember(id);
  const { mutate: removeMember } = useRemoveMember(id);

  function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !memberName.trim() || !roleId.trim()) return;
    inviteMember(
      {
        email: email.trim(),
        name: memberName.trim(),
        roleId: roleId.trim(),
        password: password.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Member invited");
          setOpen(false);
          setEmail("");
          setMemberName("");
          setRoleId("");
          setPassword("");
        },
        onError: (err: unknown) => {
          const apiErr = err as ApiError;
          toast.error(apiErr?.message ?? "Failed to invite member");
        },
      },
    );
  }

  function handleRemove(memberId: string, memberEmail: string) {
    if (!window.confirm(`Remove ${memberEmail} from this organization?`)) return;
    removeMember(memberId, {
      onSuccess: () => toast.success("Member removed"),
      onError: (err: unknown) => {
        const apiErr = err as ApiError;
        toast.error(apiErr?.message ?? "Failed to remove member");
      },
    });
  }

  return (
    <div className="space-y-6 p-6">
      {/* Back link */}
      <Link
        href="/platform"
        className="inline-flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Organizations
      </Link>

      <PageHeader
        icon={Users}
        title="Members"
        description={org ? `Managing members of ${org.name}` : "Managing organization members"}
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>Invite Member</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Invite Member</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleInvite} className="space-y-4 pt-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground" htmlFor="invite-email">
                    Email <span className="text-danger">*</span>
                  </label>
                  <Input
                    id="invite-email"
                    type="email"
                    placeholder="user@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground" htmlFor="invite-name">
                    Name <span className="text-danger">*</span>
                  </label>
                  <Input
                    id="invite-name"
                    placeholder="Jane Smith"
                    value={memberName}
                    onChange={(e) => setMemberName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground" htmlFor="invite-role">
                    Role <span className="text-danger">*</span>
                  </label>
                  <select
                    id="invite-role"
                    value={roleId}
                    onChange={(e) => setRoleId(e.target.value)}
                    required
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">Select a role…</option>
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground" htmlFor="invite-password">
                    Password (for new users) <span className="text-danger">*</span>
                  </label>
                  <Input
                    id="invite-password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={inviting || !email.trim() || !memberName.trim() || !roleId.trim()}
                  >
                    {inviting ? "Inviting…" : "Invite"}
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
            Loading members…
          </div>
        ) : !members?.length ? (
          <div className="flex items-center justify-center py-16 text-sm text-foreground-muted">
            No members yet. Invite the first one.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-4 px-5 py-3 text-xs font-medium uppercase tracking-wide text-foreground-muted">
              <span>Name</span>
              <span>Email</span>
              <span>Role</span>
              <span>Status</span>
              <span />
            </div>
            {members.map((member) => (
              <div
                key={member.id}
                className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-4 px-5 py-4 items-center"
              >
                <span className="font-medium text-foreground truncate">{member.name}</span>
                <span className="text-sm text-foreground-muted truncate">{member.email}</span>
                <Badge tone="primary">{member.roleName}</Badge>
                <Badge tone={getMemberStatusTone(member.memberStatus)} className="capitalize">
                  {member.memberStatus}
                </Badge>
                <button
                  onClick={() => handleRemove(member.id, member.email)}
                  className="flex items-center justify-center h-7 w-7 rounded-md text-foreground-muted hover:text-danger hover:bg-danger/10 transition-colors"
                  title="Remove member"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
