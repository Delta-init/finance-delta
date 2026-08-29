import type { Request, Response } from "express";
import { AppError, asyncHandler, ok } from "../../lib/http";
import * as authService from "./auth.service";
import {
  requestPasswordReset,
  resetPassword as doResetPassword,
} from "./password-reset.service";

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const result = await authService.login(email, password);
  ok(res, result);
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
