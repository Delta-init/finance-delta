"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Wallet } from "./types";

/*
 * My Wallet (2026-11-04): your month from HRMS — salary a day at a time, what came off and why, commission, what
 * finance has paid. The server asks HRMS as whoever is signed in; the same whichever organization is open.
 */
export const useWallet = (month: string) =>
  useQuery({
    queryKey: ["wallet", month],
    queryFn: () => api.get<Wallet>(`wallet?month=${encodeURIComponent(month)}`),
    // HRMS asks finance behind it on every load; a minute keeps flicking between months cheap.
    staleTime: 60_000,
    retry: false,
  });

/** This month where the company keeps its books. */
export const walletThisMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date()).slice(0, 7);
