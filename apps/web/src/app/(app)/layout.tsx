import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/dashboard/app-sidebar";
import { SiteHeader } from "@/components/dashboard/site-header";
import { OrgPickerModal } from "@/components/org-picker/OrgPickerModal";

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
        <main className="flex-1 overflow-y-auto bg-background">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
