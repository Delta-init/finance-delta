import { describe, expect, it } from "bun:test";
import { bonusCurrency, CRM_BONUS_CURRENCY } from "./invoice.schema";

/*
 * The bonus's currency (the user, 2026-10-12): a sales CRM's close queued before
 * the CRMs said "USD" carries none, and was meant in US dollars all the same.
 * Only an enrolment typed in finance keeps the invoice's currency.
 */
describe("bonusCurrency", () => {
  it("keeps the bonus's own currency, whoever sold it", () => {
    expect(bonusCurrency({ crm: "delta", bonus: { currency: "USD" } }, "AED", "crm")).toBe("USD");
    expect(bonusCurrency({ bonus: { currency: "inr" } }, "AED", undefined)).toBe("INR");
    expect(bonusCurrency({ crm: "remote", bonus: { currency: "AED" } }, "AED", "crm")).toBe("AED");
  });

  it("is USD for a sales CRM's bonus that came without one", () => {
    expect(CRM_BONUS_CURRENCY).toBe("USD");
    for (const crm of ["delta", "remote", "draw", "banglore"]) {
      expect(bonusCurrency({ crm, bonus: { given: true, amountMinor: 50000 } as never }, "AED", "crm")).toBe("USD");
    }
    expect(bonusCurrency({ crm: "banglore", bonus: {} }, "INR", "banglore-crm")).toBe("USD");
  });

  it("works the CRM out from the source for a close from before the CRMs named themselves", () => {
    expect(bonusCurrency({ bonus: {} }, "AED", "crm")).toBe("USD");
    expect(bonusCurrency({ bonus: { currency: null } }, "AED", "draw-crm")).toBe("USD");
    expect(bonusCurrency({ bonus: { currency: "" } }, "INR", "banglore-crm")).toBe("USD");
  });

  it("keeps the invoice's currency for one typed in finance", () => {
    expect(bonusCurrency({ bonus: {} }, "AED", undefined)).toBe("AED");
    expect(bonusCurrency({ bonus: {} }, "inr", null)).toBe("INR");
    expect(bonusCurrency({ crm: null, bonus: null }, "GBP", "")).toBe("GBP");
    expect(bonusCurrency(undefined, undefined, undefined)).toBe("AED");
    // A source that is not a sales CRM is no CRM.
    expect(bonusCurrency({ bonus: {} }, "AED", "hrms")).toBe("AED");
  });

  it("ignores a stored currency that is not three letters", () => {
    expect(bonusCurrency({ crm: "delta", bonus: { currency: "dollars" } }, "AED", "crm")).toBe("USD");
    expect(bonusCurrency({ bonus: { currency: "dollars" } }, "AED", undefined)).toBe("AED");
  });
});
