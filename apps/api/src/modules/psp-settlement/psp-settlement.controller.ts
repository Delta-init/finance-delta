import type { Request } from "express";
import { asyncHandler, created, ok } from "../../lib/http";
import * as svc from "./psp-settlement.service";

const org = (req: Request) => req.auth!.organizationId;

async function actorOf(req: Request) {
  const { User } = await import("../user/user.model");
  const name = (await User.findById(req.auth!.userId).select("name").lean<{ name?: string }>())?.name ?? "";
  return { userId: req.auth!.userId, name };
}

/** The PSP account's money not settled yet (?to=YYYY-MM-DD: up to that day). */
export const unsettled = asyncHandler(async (req, res) => {
  ok(res, await svc.unsettledLines(org(req), req.params.id!, { to: typeof req.query.to === "string" ? req.query.to : undefined }));
});

export const summary = asyncHandler(async (req, res) => {
  ok(res, await svc.pspSummary(org(req), req.params.id!));
});

export const list = asyncHandler(async (req, res) => {
  ok(res, await svc.listSettlements(org(req), req.params.id!));
});

export const create = asyncHandler(async (req, res) => {
  created(res, await svc.createSettlement(org(req), req.params.id!, req.body, await actorOf(req)));
});

export const remove = asyncHandler(async (req, res) => {
  await svc.deleteSettlement(org(req), req.params.id!, req.params.settlementId!);
  res.status(204).end();
});
