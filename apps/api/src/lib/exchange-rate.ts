import { logger } from "./logger";

interface RateCache { base: string; rates: Record<string, number>; fetchedAt: number }
let cache: RateCache | null = null;
const TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * What one unit of `fromCurrency` is worth in `toCurrency`.
 *
 * Returns null when it could not find out. It used to return 1.0, which meant a
 * dollar invoice raised while the rate service was down was stored as one
 * dollar to the dirham — indistinguishable, afterwards, from a rate somebody
 * had checked. A missing rate is a thing to ask about; a wrong one that looks
 * deliberate is not.
 */
export async function getExchangeRate(
  fromCurrency: string,
  toCurrency: string,
): Promise<number | null> {
  if (fromCurrency === toCurrency) return 1;
  try {
    const now = Date.now();
    if (!cache || cache.base !== fromCurrency || now - cache.fetchedAt > TTL_MS) {
      const res = await fetch(`https://open.er-api.com/v6/latest/${fromCurrency}`);
      const json = (await res.json()) as { rates?: Record<string, number> };
      if (json.rates) {
        cache = { base: fromCurrency, rates: json.rates, fetchedAt: now };
      }
    }
    const rate = cache?.base === fromCurrency ? cache.rates[toCurrency] : undefined;
    return typeof rate === "number" && rate > 0 ? rate : null;
  } catch (err) {
    logger.warn({ err, fromCurrency, toCurrency }, "Exchange rate lookup failed");
    return null;
  }
}
