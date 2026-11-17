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

/**
 * The settlement window's search (2026-11-17): ?q= (words or an amount), ?from= / ?to= (days), ?before=1 (include the
 * money dated before the PSP's start date) — every match counted and summed, the first 5,000 sent.
 */
export const searchUnsettled = asyncHandler(async (req, res) => {
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  ok(res, await svc.searchUnsettled(org(req), req.params.id!, {
    q: s(req.query.q), from: s(req.query.from), to: s(req.query.to), includeBeforeStart: req.query.before === "1" || req.query.before === "true",
  }));
});

/** Every PSP account's unsettled money — the dashboard's card. */
export const allSummaries = asyncHandler(async (req, res) => {
  ok(res, await svc.allPspSummaries(org(req)));
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
