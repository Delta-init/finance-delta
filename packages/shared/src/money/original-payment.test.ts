import { describe, expect, it } from "bun:test";
import { formatOriginalPayment } from "./index";

/* The rate a payment was converted at, the way people say it (the user, 2026-10-13). */
describe("formatOriginalPayment", () => {
  it("quotes rupees against AED as 1 AED = so many INR", () => {
    expect(formatOriginalPayment({ currency: "INR", amountMinor: 5_118_750, rate: 1 / 22.75 }, "AED")).toBe("INR 51,188 at 1 AED = 22.75 INR") // rupees are shown whole;
  });
  it("keeps a unit worth more than the invoice's as 1 of it = so many", () => {
    expect(formatOriginalPayment({ currency: "USD", amountMinor: 100_000, rate: 3.6725 }, "AED")).toBe("USD 1,000.00 at 1 USD = 3.6725 AED");
    expect(formatOriginalPayment({ currency: "AED", amountMinor: 20_000, rate: 22.5 }, "INR")).toBe("AED 200.00 at 1 AED = 22.5 INR");
  });
  it("a rate of exactly 1 reads as it is", () => {
    expect(formatOriginalPayment({ currency: "AED", amountMinor: 100, rate: 1 }, "AED")).toBe("AED 1.00 at 1 AED = 1 AED");
  });
});
