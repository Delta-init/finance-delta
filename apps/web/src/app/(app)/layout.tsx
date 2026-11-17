import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/dashboard/app-sidebar";
import { SiteHeader } from "@/components/dashboard/site-header";
import { OrgPickerModal } from "@/components/org-picker/OrgPickerModal";
import { RootPortalHistoryBridge } from "@/components/root-portal-history-bridge";
import { SplitShell } from "@/components/split-view/split-view";
import { SplitProvider } from "@/components/split-view/side-page";

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
    // The split screen's state (any page beside, 2026-11-17): the header's Split button, the menu and the page share it.
    <SplitProvider>
    <SidebarProvider>
      <RootPortalHistoryBridge />
      {/* data-app-chrome: hidden inside the side page's frame (2026-11-17, globals.css). */}
      <div data-app-chrome className="contents">
      <AppSidebar
        user={{
          name: session.user.name ?? "User",
          orgName: session.user.orgName ?? "",
          roleName: session.user.roleName,
          permissions: session.user.permissions,
          isSuperAdmin: session.user.isSuperAdmin ?? false,
        }}
      />
      </div>
      <SidebarInset data-app-inset>
        <div data-app-chrome className="contents"><SiteHeader /></div>
        {/* The page, and a record opened beside it (the split pane, 2026-11-07). */}
        <SplitShell>{children}</SplitShell>
      </SidebarInset>
    </SidebarProvider>
    </SplitProvider>
  );
}
