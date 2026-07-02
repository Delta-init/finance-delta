import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { loginSchema, type AuthSuccess, type OrgChoiceResult } from "@delta/shared";
import { authConfig } from "@/auth.config";

const API_URL =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:4000/api/v1";

function getJwtExpiryMs(token: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8"),
    );
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function refreshTokens(refreshToken: string): Promise<AuthSuccess | null> {
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data: AuthSuccess };
  return json.data;
}

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = loginSchema.safeParse(raw);
        if (!parsed.success) return null;

        const res = await fetch(`${API_URL}/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed.data),
        });
        if (!res.ok) return null;

        const json = (await res.json()) as { data: AuthSuccess | OrgChoiceResult };
        const data = json.data;

        // Multi-org: user must pick an org before receiving real tokens.
        if ("status" in data && data.status === "choose_org") {
          return {
            id: "pending",
            name: "",
            email: parsed.data.email,
            organizationId: "",
            orgName: "",
            roleKey: "",
            roleName: "",
            permissions: [],
            isSuperAdmin: false,
            accessToken: "",
            refreshToken: "",
            needsOrgChoice: true,
            orgs: data.orgs,
            pendingToken: data.pendingToken,
            baseCurrency: "AED",
          };
        }

        const success = data as AuthSuccess;
        return {
          id: success.user.id,
          name: success.user.name,
          email: success.user.email,
          organizationId: success.user.organizationId,
          orgName: success.user.orgName ?? "",
          roleKey: success.user.roleKey,
          roleName: success.user.roleName,
          permissions: success.user.permissions,
          isSuperAdmin: success.user.isSuperAdmin ?? false,
          accessToken: success.accessToken,
          refreshToken: success.refreshToken,
          needsOrgChoice: false,
          baseCurrency: success.user.baseCurrency ?? "AED",
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session: updateData }) {
      // Session update triggered by unstable_update() (e.g. after org switch).
      if (trigger === "update" && updateData) {
        const patch = updateData as Partial<typeof token>;
        return { ...token, ...patch, needsOrgChoice: false };
      }

      // Initial sign-in.
      if (user) {
        const u = user as typeof token & {
          accessToken: string;
          isSuperAdmin: boolean;
          needsOrgChoice?: boolean;
        };

        if (u.needsOrgChoice) {
          return {
            ...token,
            id: u.id ?? "",
            needsOrgChoice: true,
            orgs: u.orgs,
            pendingToken: u.pendingToken,
            organizationId: "",
            orgName: "",
            isSuperAdmin: false,
            roleKey: "",
            roleName: "",
            permissions: [],
            accessToken: "",
            refreshToken: "",
            accessTokenExpires: 0,
          };
        }

        return {
          ...token,
          id: u.id,
          organizationId: u.organizationId,
          orgName: u.orgName ?? "",
          roleKey: u.roleKey,
          roleName: u.roleName,
          permissions: u.permissions,
          isSuperAdmin: u.isSuperAdmin,
          accessToken: u.accessToken,
          refreshToken: u.refreshToken,
          accessTokenExpires: getJwtExpiryMs(u.accessToken),
          needsOrgChoice: false,
          baseCurrency: (u as Record<string, unknown>).baseCurrency as string ?? "AED",
        };
      }

      // Pending org choice — don't refresh, just return as-is.
      if (token.needsOrgChoice) return token;

      // Proactively refresh before expiry.
      const expires = (token.accessTokenExpires as number) ?? 0;
      if (Date.now() < expires - 60_000) return token;

      const refreshed = await refreshTokens(token.refreshToken as string);
      if (!refreshed) {
        return { ...token, error: "RefreshTokenError" };
      }
      return {
        ...token,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        permissions: refreshed.user.permissions,
        roleKey: refreshed.user.roleKey,
        roleName: refreshed.user.roleName,
        organizationId: refreshed.user.organizationId,
        orgName: refreshed.user.orgName ?? "",
        isSuperAdmin: refreshed.user.isSuperAdmin ?? false,
        accessTokenExpires: getJwtExpiryMs(refreshed.accessToken),
        baseCurrency: refreshed.user.baseCurrency ?? (token.baseCurrency as string) ?? "AED",
        error: undefined,
      };
    },

    async session({ session, token }) {
      session.user.id = (token.id as string) ?? "";
      session.user.organizationId = (token.organizationId as string) ?? "";
      session.user.orgName = (token.orgName as string) ?? "";
      session.user.roleKey = (token.roleKey as string) ?? "";
      session.user.roleName = (token.roleName as string) ?? "";
      session.user.permissions = (token.permissions as string[]) ?? [];
      session.user.isSuperAdmin = (token.isSuperAdmin as boolean) ?? false;
      session.user.needsOrgChoice = (token.needsOrgChoice as boolean) ?? false;
      session.user.orgs = token.orgs as typeof session.user.orgs;
      session.user.pendingToken = token.pendingToken as string | undefined;
      session.user.baseCurrency = (token.baseCurrency as string) ?? "AED";
      session.error = token.error as string | undefined;
      return session;
    },
  },
});
