import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe NextAuth config. Imported by middleware (Edge runtime) so it must
 * NOT pull in Node-only code (no providers with crypto deps, no DB adapters).
 * The full config in auth.ts spreads this and adds the Credentials provider +
 * jwt/session callbacks (which run in the Node runtime only).
 */
export const authConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
} satisfies NextAuthConfig;
