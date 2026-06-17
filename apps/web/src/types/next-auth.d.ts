import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      organizationId: string;
      roleKey: string;
      roleName: string;
      permissions: string[];
    } & DefaultSession["user"];
    error?: string;
  }

  interface User {
    organizationId: string;
    roleKey: string;
    roleName: string;
    permissions: string[];
    accessToken: string;
    refreshToken: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    organizationId: string;
    roleKey: string;
    roleName: string;
    permissions: string[];
    accessToken: string;
    refreshToken: string;
    accessTokenExpires: number;
    error?: string;
  }
}
