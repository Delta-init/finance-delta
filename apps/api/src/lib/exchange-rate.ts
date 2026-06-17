import { logger } from "./logger";

interface RateCache { base: string; rates: Record<string, number>; fetchedAt: number }
let cache: RateCache | null = null;
const TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getExchangeRate(fromCurrency: string, toCurrency: string): Promise<number> {
  if (fromCurrency === toCurrency) return 1;
  try {
    const now = Date.now();
    if (!cache || cache.base !== fromCurrency || now - cache.fetchedAt > TTL_MS) {
      const res = await fetch(`https://open.er-api.com/v6/latest/${fromCurrency}`);
      const json = await res.json() as { rates?: Record<string, number> };
      if (json.rates) {
        cache = { base: fromCurrency, rates: json.rates, fetchedAt: now };
      }
    }
    return cache?.rates?.[toCurrency] ?? 1;
  } catch (err) {
    logger.warn({ err, fromCurrency, toCurrency }, "Exchange rate fetch failed — using 1.0");
    return 1;
  }
}
