import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { loginSchema, type AuthResult } from "@delta/shared";
import { authConfig } from "@/auth.config";

const API_URL =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:4000/api/v1";

/** Decode a JWT's `exp` (seconds) without verifying — for refresh timing only. */
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

async function refreshTokens(refreshToken: string): Promise<AuthResult | null> {
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data: AuthResult };
  return json.data;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
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

        const { data } = (await res.json()) as { data: AuthResult };
        // The object returned here is passed to the `jwt` callback as `user`.
        return {
          id: data.user.id,
          name: data.user.name,
          email: data.user.email,
          organizationId: data.user.organizationId,
          roleKey: data.user.roleKey,
          roleName: data.user.roleName,
          permissions: data.user.permissions,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // Initial sign-in: copy everything from the authorize() result.
      if (user) {
        const u = user as typeof token & { accessToken: string };
        token.id = u.id;
        token.organizationId = u.organizationId;
        token.roleKey = u.roleKey;
        token.roleName = u.roleName;
        token.permissions = u.permissions;
        token.accessToken = u.accessToken;
        token.refreshToken = u.refreshToken;
        token.accessTokenExpires = getJwtExpiryMs(u.accessToken);
        return token;
      }

      // Subsequent calls: refresh the access token shortly before it expires.
      const expires = (token.accessTokenExpires as number) ?? 0;
      if (Date.now() < expires - 60_000) return token;

      const refreshed = await refreshTokens(token.refreshToken as string);
      if (!refreshed) {
        token.error = "RefreshTokenError";
        return token;
      }
      token.accessToken = refreshed.accessToken;
      token.refreshToken = refreshed.refreshToken;
      token.permissions = refreshed.user.permissions;
      token.roleKey = refreshed.user.roleKey;
      token.roleName = refreshed.user.roleName;
      token.accessTokenExpires = getJwtExpiryMs(refreshed.accessToken);
      delete token.error;
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id as string;
      session.user.organizationId = token.organizationId as string;
      session.user.roleKey = token.roleKey as string;
      session.user.roleName = token.roleName as string;
      session.user.permissions = (token.permissions as string[]) ?? [];
      session.error = token.error as string | undefined;
      return session;
    },
  },
});
