import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/dashboard/app-sidebar";
import { SiteHeader } from "@/components/dashboard/site-header";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <SidebarProvider>
      <AppSidebar
        user={{
          name: session.user.name ?? "User",
          roleName: session.user.roleName,
          permissions: session.user.permissions,
        }}
      />
      <SidebarInset>
        <SiteHeader />
        <main className="flex-1 overflow-y-auto bg-background">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
