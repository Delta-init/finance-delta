import { describe, expect, it } from "bun:test";
import { PAYMENT_METHODS } from "@delta/shared";
import { Invoice } from "./invoice.model";

/**
 * The form and the database have to agree on what a payment method is.
 *
 * They did not, twice. "tabby" was added to the shared list and not to the
 * schema, so the form offered it and the save was refused; "tamara" and
 * "billexpro" had quietly gone the same way. The enum is now taken from the
 * shared list, and this fails if anybody writes it out by hand again.
 */
function enumAt(path: string): string[] {
  const p = Invoice.schema.path(path) as unknown as { enumValues?: string[] };
  return p?.enumValues ?? [];
}

describe("payment methods", () => {
  it("the invoice's own payment enum is the shared list", () => {
    expect(enumAt("payments.method").sort()).toEqual([...PAYMENT_METHODS].sort());
  });

  it("the enrolment's declared method is the same list", () => {
    expect(enumAt("enrolment.declaredPaymentMethod").sort()).toEqual([...PAYMENT_METHODS].sort());
  });

  it("includes the ones a counsellor actually takes", () => {
    for (const m of ["cash", "tabby", "tamara", "billexpro", "easebuzz_emi"]) {
      expect(PAYMENT_METHODS).toContain(m as never);
    }
  });
});
