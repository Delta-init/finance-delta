import type { Request, Response } from "express";
import { AppError, asyncHandler, ok } from "../../lib/http";
import * as authService from "./auth.service";
import { env } from "../../config/env";
import {
  requestPasswordReset,
  resetPassword as doResetPassword,
} from "./password-reset.service";

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const result = await authService.login(email, password);
  ok(res, result);
});

/**
 * Sign in somebody the Root portal has already identified.
 *
 * The browser arrives at /sso with a single-use token and posts it here. This
 * server spends it against the portal — one call, server to server, the token
 * never stored — and signs in whoever it vouches for.
 *
 * Fails closed. With no ROOT_ERP_API_URL this refuses rather than falling back
 * to a default, because a server that quietly asks itself to vouch for a token
 * would accept anything.
 */
export const ssoLogin = asyncHandler(async (req: Request, res: Response) => {
  const ssoToken = String((req.body as { ssoToken?: unknown })?.ssoToken ?? "").trim();
  if (!ssoToken) throw new AppError("VALIDATION_ERROR", "ssoToken is required");

  const rootApi = env.ROOT_ERP_API_URL.replace(/\/+$/, "");
  if (!rootApi) throw new AppError("VALIDATION_ERROR", "SSO is not configured on this server");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let identity: { email?: string } | undefined;
  try {
    const verified = await fetch(
      `${rootApi}/api/auth/verify-sso-token?token=${encodeURIComponent(ssoToken)}`,
      { signal: controller.signal },
    );
    // One message whatever went wrong. Distinguishing expired from spent from
    // never-existed tells somebody holding a stale token which case they hit.
    if (!verified.ok) throw new AppError("UNAUTHENTICATED", "Invalid or expired sign-in link");
    const body = (await verified.json()) as { data?: { email?: string } };
    identity = body.data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("UNAUTHENTICATED", "The sign-in service could not be reached");
  } finally {
    clearTimeout(timer);
  }

  if (!identity?.email) throw new AppError("UNAUTHENTICATED", "Invalid or expired sign-in link");
  ok(res, await authService.ssoLogin(identity.email));
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new AppError("UNAUTHENTICATED", "Refresh token required");
  const result = await authService.refresh(refreshToken);
  ok(res, result);
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body ?? {};
  if (refreshToken) await authService.logout(refreshToken);
  res.status(204).end();
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  const user = await authService.getMe(req.auth!.userId, req.auth!.organizationId);
  ok(res, user);
});

export const switchOrg = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.switchOrg(
    req.auth!.userId,
    req.auth!.isSuperAdmin,
    req.body,
  );
  ok(res, result);
});

/**
 * Always 200, always the same body.
 *
 * Whether the address belongs to an account, to a suspended one, or to nobody
 * at all, the caller is told the same thing — otherwise this endpoint, which
 * needs no login, becomes a way to find out who has an account here.
 */
export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  await requestPasswordReset(req.body.email);
  ok(res, { message: "If that address has an account, a reset link is on its way." });
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  await doResetPassword(req.body.token, req.body.password);
  ok(res, { message: "Your password has been set. You can sign in now." });
});
