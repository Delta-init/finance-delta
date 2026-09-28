import type { DefaultSession } from "next-auth";
import type { OrgChoiceItem } from "@delta/shared";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      organizationId: string;
      orgName: string;
      roleKey: string;
      roleName: string;
      permissions: string[];
      isSuperAdmin: boolean;
      needsOrgChoice: boolean;
      orgs?: OrgChoiceItem[];
      pendingToken?: string;
      baseCurrency: string;
      /** When this sign-in happened (ms). A new sign-in resets the approvals pop-up. */
      signedInAt: number;
    } & DefaultSession["user"];
    error?: string;
  }

  interface User {
    organizationId: string;
    orgName: string;
    roleKey: string;
    roleName: string;
    permissions: string[];
    isSuperAdmin: boolean;
    accessToken: string;
    refreshToken: string;
    needsOrgChoice?: boolean;
    orgs?: OrgChoiceItem[];
    pendingToken?: string;
    baseCurrency: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    organizationId: string;
    orgName: string;
    roleKey: string;
    roleName: string;
    permissions: string[];
    isSuperAdmin: boolean;
    accessToken: string;
    refreshToken: string;
    accessTokenExpires: number;
    needsOrgChoice?: boolean;
    orgs?: OrgChoiceItem[];
    pendingToken?: string;
    baseCurrency: string;
    signedInAt?: number;
    error?: string;
  }
}
