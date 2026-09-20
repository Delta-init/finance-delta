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

/**
 * Cookies that survive the Root portal's frame.
 *
 * The portal opens each system it fronts in an iframe, which makes this
 * application third-party to the page around it. Auth.js sets SameSite=Lax by
 * default, and a Lax cookie is never stored in that position — by design,
 * since that is the defence against cross-site request forgery.
 *
 * So signing in from the portal looked like a failure and was not: the
 * handover worked, the session cookie was set, the browser discarded it, and
 * this application — seeing no session — showed the login page again.
 *
 * The CSRF cookie matters as much as the session one. It is checked on the
 * sign-in POST, so a Lax CSRF cookie means the request is refused before any
 * of the rest is reached.
 *
 * Production only: SameSite=None requires Secure, and a Secure cookie is
 * dropped over plain http, so locally this would trade one silent sign-in
 * failure for another. In development Auth.js keeps its own defaults.
 *
 * The names are the ones Auth.js already uses here — verified against what
 * this deployment serves — so nobody is signed out by the change.
 *
 * This is a real reduction: Lax was keeping the session off cross-site
 * requests, and lifting it means another site can cause an authenticated
 * request to be sent. The CSRF token remains the defence on the auth routes.
 */
const crossSite = process.env.NODE_ENV === "production";

const frameFriendlyCookies = crossSite
  ? {
      sessionToken: {
        name: "__Secure-authjs.session-token",
        options: {
          httpOnly: true,
          sameSite: "none" as const,
          path: "/",
          secure: true,
        },
      },
      callbackUrl: {
        name: "__Secure-authjs.callback-url",
        options: {
          httpOnly: true,
          sameSite: "none" as const,
          path: "/",
          secure: true,
        },
      },
      // `__Host-` requires Secure, Path=/ and no Domain, all of which hold.
      // It is the stronger prefix — a cookie by that name cannot have been set
      // by a subdomain — and it is what Auth.js already uses here.
      csrfToken: {
        name: "__Host-authjs.csrf-token",
        options: {
          httpOnly: true,
          sameSite: "none" as const,
          path: "/",
          secure: true,
        },
      },
    }
  : undefined;

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  ...authConfig,
  cookies: frameFriendlyCookies,
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

    /*
     * Arriving from the Root portal instead of typing a password.
     *
     * Its own provider rather than a branch inside the one above, because the
     * credential is a different thing: a single-use token the portal minted,
     * not an email and a password. Folding them together would mean a provider
     * that accepts either, and the branch that decides which is the one an
     * attacker would go looking at.
     *
     * The shape it returns is identical, so everything downstream — the org
     * choice, the refresh, the session callbacks — cannot tell the difference
     * and does not need to.
     */
    Credentials({
      id: "sso",
      name: "Root portal",
      credentials: { ssoToken: {} },
      async authorize(raw) {
        const ssoToken = String((raw as { ssoToken?: unknown })?.ssoToken ?? "").trim();
        if (!ssoToken) return null;

        const res = await fetch(`${API_URL}/auth/sso-login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ssoToken }),
        });
        if (!res.ok) return null;

        const json = (await res.json()) as { data: AuthSuccess | OrgChoiceResult };
        const data = json.data;

        // Somebody who belongs to more than one organization is asked which,
        // exactly as they would be after a password login.
        if ("status" in data && data.status === "choose_org") {
          return {
            id: "pending",
            name: "",
            email: "",
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
