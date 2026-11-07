import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/dashboard/app-sidebar";
import { SiteHeader } from "@/components/dashboard/site-header";
import { OrgPickerModal } from "@/components/org-picker/OrgPickerModal";
import { RootPortalHistoryBridge } from "@/components/root-portal-history-bridge";
import { SplitShell } from "@/components/split-view/split-view";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // User is authenticated but hasn't picked an org yet.
  if (session.user.needsOrgChoice) {
    return (
      <OrgPickerModal orgs={session.user.orgs ?? []} />
    );
  }

  return (
    <SidebarProvider>
      <RootPortalHistoryBridge />
      <AppSidebar
        user={{
          name: session.user.name ?? "User",
          orgName: session.user.orgName ?? "",
          roleName: session.user.roleName,
          permissions: session.user.permissions,
          isSuperAdmin: session.user.isSuperAdmin ?? false,
        }}
      />
      <SidebarInset>
        <SiteHeader />
        {/* The page, and a record opened beside it (the split pane, 2026-11-07). */}
        <SplitShell>{children}</SplitShell>
      </SidebarInset>
    </SidebarProvider>
  );
}
