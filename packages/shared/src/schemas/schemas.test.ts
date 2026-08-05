import { describe, it, expect } from "bun:test";
import { createQuotationSchema } from "./quotation.schema";
import { createInvoiceSchema, recordPaymentSchema } from "./invoice.schema";
import { createDepartmentSchema } from "./department.schema";
import { createUserSchema } from "./user.schema";

const quoteLine = { description: "Item", quantity: 1, unitPriceMinor: 10000 };
const invoiceLine = { description: "Item", quantity: 1, unitPriceMinor: 10000 };

describe("createQuotationSchema", () => {
  it("accepts a valid quotation with a multi-tax line", () => {
    const r = createQuotationSchema.safeParse({
      customerId: "c1",
      issueDate: "2026-01-01",
      expiryDate: "2026-01-15",
      lineItems: [{ ...quoteLine, taxes: [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }] }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects an empty line-item list", () => {
    const r = createQuotationSchema.safeParse({
      customerId: "c1",
      issueDate: "2026-01-01",
      expiryDate: "2026-01-15",
      lineItems: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-positive quantity", () => {
    const r = createQuotationSchema.safeParse({
      customerId: "c1",
      issueDate: "2026-01-01",
      expiryDate: "2026-01-15",
      lineItems: [{ ...quoteLine, quantity: -5 }],
    });
    expect(r.success).toBe(false);
  });

  it("requires a customer", () => {
    const r = createQuotationSchema.safeParse({
      issueDate: "2026-01-01",
      expiryDate: "2026-01-15",
      lineItems: [quoteLine],
    });
    expect(r.success).toBe(false);
  });
});

describe("createInvoiceSchema", () => {
  it("requires both a customer and a salesperson", () => {
    const base = { issueDate: "2026-01-01", dueDate: "2026-01-31", lineItems: [invoiceLine] };
    expect(createInvoiceSchema.safeParse({ ...base, customerId: "c1", salespersonId: "u1" }).success).toBe(true);
    expect(createInvoiceSchema.safeParse({ ...base, customerId: "c1" }).success).toBe(false);
    expect(createInvoiceSchema.safeParse({ ...base, salespersonId: "u1" }).success).toBe(false);
  });

  it("rejects a discount above 100%", () => {
    const r = createInvoiceSchema.safeParse({
      customerId: "c1",
      salespersonId: "u1",
      issueDate: "2026-01-01",
      dueDate: "2026-01-31",
      lineItems: [{ ...invoiceLine, discountPct: 150 }],
    });
    expect(r.success).toBe(false);
  });
});

describe("recordPaymentSchema", () => {
  it("rejects a negative or zero amount", () => {
    const base = { method: "cash", paidOn: "2026-01-05" };
    expect(recordPaymentSchema.safeParse({ ...base, amountMinor: 1000 }).success).toBe(true);
    expect(recordPaymentSchema.safeParse({ ...base, amountMinor: -500 }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ ...base, amountMinor: 0 }).success).toBe(false);
  });
});

describe("createDepartmentSchema", () => {
  it("requires a name and accepts an optional description", () => {
    expect(createDepartmentSchema.safeParse({ name: "Sales" }).success).toBe(true);
    expect(createDepartmentSchema.safeParse({ name: "" }).success).toBe(false);
    expect(createDepartmentSchema.safeParse({}).success).toBe(false);
  });
});

describe("createUserSchema", () => {
  it("requires an email, a role and an 8+ char password", () => {
    const ok = { name: "Jane Doe", email: "jane@x.com", password: "password1", roleId: "r1" };
    expect(createUserSchema.safeParse(ok).success).toBe(true);
    expect(createUserSchema.safeParse({ ...ok, password: "short" }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...ok, email: "not-an-email" }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...ok, roleId: "" }).success).toBe(false);
  });
});
