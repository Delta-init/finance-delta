import type { Request, Response } from "express";
import { AppError, asyncHandler, ok } from "../../lib/http";
import * as authService from "./auth.service";

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
