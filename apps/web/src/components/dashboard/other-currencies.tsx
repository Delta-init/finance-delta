"use client";

import { OtherCurrencies } from "@/features/reports/OtherCurrencies";
import { useDashboardStats } from "@/features/dashboard/api";

/**
 * Under the dashboard's cards (2026-11-26): what they leave out because it is in another currency than the
 * organization's — this month's revenue and expenses, what is owed either way. Every card is the organization's own
 * currency only; rupees used to be added into them as dirhams. Nothing when there is none.
 */
export function DashboardOtherCurrencies() {
  const { data } = useDashboardStats();
  return <OtherCurrencies lines={data?.otherCurrencies} />;
}
