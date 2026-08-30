import { describe, expect, test } from "bun:test";
import { SYSTEM_ROLES } from "./roles";
import { hasPermission } from "./permissions";

const perms = (key: string) =>
  SYSTEM_ROLES.find((r) => r.key === key)!.permissions as string[];

describe("the Salesperson role", () => {
  const salesperson = perms("salesperson");

  test("sees only the invoices they entered", () => {
    expect(salesperson).toContain("invoice:read:own");
    // The broad one would return the whole organization's billing, and the
    // scope resolver lets it win wherever both are held.
    expect(salesperson).not.toContain("invoice:read");
  });

  test("can still raise an invoice", () => {
    expect(salesperson).toContain("invoice:write:own");
    expect(salesperson).not.toContain("invoice:write");
  });

  test("cannot move money", () => {
    // Recording a payment, voiding and deleting are all guarded on the broad
    // `invoice:write` in the routes, so holding only the narrow one is what
    // keeps a salesperson out of them.
    expect(hasPermission(salesperson, "invoice:write")).toBe(false);
  });

  test("keeps quotations, orders and customers", () => {
    for (const p of [
      "quotation:read", "quotation:create", "quotation:update",
      "salesorder:read", "salesorder:create",
      "customer:read", "customer:update",
    ]) {
      expect(salesperson).toContain(p);
    }
  });

  test("customer:update is what keeps the Customers page in their menu", () => {
    // The sidebar hides own-scoped people from the customer list unless they
    // hold this. A counsellor does not; a salesperson does.
    expect(salesperson).toContain("customer:update");
    expect(perms("employee")).not.toContain("customer:update");
  });
});

describe("the Employee role is unchanged by this", () => {
  const employee = perms("employee");

  test("still own-scoped on invoices, still no expenses", () => {
    expect(employee).toEqual([
      "invoice:read:own",
      "invoice:write:own",
      "customer:read",
      "customer:create",
    ]);
  });
});

describe("roles that see everything still do", () => {
  test("manager and accountant keep organization-wide invoices", () => {
    for (const key of ["manager", "accountant"]) {
      expect(perms(key)).toContain("invoice:read");
      expect(perms(key)).toContain("invoice:write");
    }
  });

  test("a viewer reads invoices but cannot write any", () => {
    expect(perms("viewer")).toContain("invoice:read");
    expect(perms("viewer")).not.toContain("invoice:write");
    expect(perms("viewer")).not.toContain("invoice:write:own");
  });
});
