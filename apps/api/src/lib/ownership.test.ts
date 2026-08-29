import { describe, expect, it } from "bun:test";
import { resolveScope, scopeFilter, assertOwned, type Scope } from "./ownership";
import type { AuthContext } from "../middleware/auth";
import { AppError } from "./http";

const auth = (permissions: string[], extra: Partial<AuthContext> = {}): AuthContext => ({
  userId: "user-1",
  organizationId: "org-1",
  role: "employee",
  permissions,
  isSuperAdmin: false,
  ...extra,
});

describe("resolveScope", () => {
  it("gives the whole organization to the broad permission", () => {
    expect(resolveScope(auth(["expense:read"]), "expense:read", "expense:read:own")).toEqual({ all: true });
  });

  it("limits the narrow permission to the caller", () => {
    expect(resolveScope(auth(["expense:read:own"]), "expense:read", "expense:read:own")).toEqual({
      all: false,
      userId: "user-1",
    });
  });

  it("does not restrict somebody who holds both", () => {
    // An administrator also granted the narrow permission is not thereby
    // demoted to seeing only their own.
    const scope = resolveScope(auth(["expense:read", "expense:read:own"]), "expense:read", "expense:read:own");
    expect(scope).toEqual({ all: true });
  });

  it("lets a super admin through", () => {
    expect(resolveScope(auth([], { isSuperAdmin: true }), "expense:read", "expense:read:own")).toEqual({ all: true });
  });

  it("honours the wildcard", () => {
    expect(resolveScope(auth(["*"]), "expense:read", "expense:read:own")).toEqual({ all: true });
  });

  it("fails closed when neither permission is held", () => {
    // Should have been stopped at the route. Reaching here means it was not,
    // so it must not fall through to the broader answer.
    expect(() => resolveScope(auth([]), "expense:read", "expense:read:own")).toThrow(AppError);
    expect(() => resolveScope(auth(["invoice:read"]), "expense:read", "expense:read:own")).toThrow(AppError);
  });

  it("does not treat a lookalike permission as the real one", () => {
    expect(() => resolveScope(auth(["expense:read:own:extra"]), "expense:read", "expense:read:own")).toThrow(AppError);
    expect(() => resolveScope(auth(["expense:readx"]), "expense:read", "expense:read:own")).toThrow(AppError);
  });
});

describe("scopeFilter", () => {
  it("adds nothing for an unrestricted caller", () => {
    expect(scopeFilter({ all: true }, "submittedById")).toEqual({});
  });

  it("pins the owner field for a restricted caller", () => {
    expect(scopeFilter({ all: false, userId: "user-1" }, "submittedById")).toEqual({
      submittedById: "user-1",
    });
    expect(scopeFilter({ all: false, userId: "user-1" }, "salespersonId")).toEqual({
      salespersonId: "user-1",
    });
  });

  it("survives being spread alongside a caller's own filters", () => {
    // The scope sits at the top level and the caller's filters under $and, so
    // asking for somebody else's rows contradicts rather than widens.
    const filter: Record<string, unknown> = {
      organizationId: "org-1",
      ...scopeFilter({ all: false, userId: "user-1" }, "submittedById"),
      $and: [{ submittedById: "user-2" }],
    };
    expect(filter.submittedById).toBe("user-1");
    expect(filter.$and).toEqual([{ submittedById: "user-2" }]);
  });
});

describe("assertOwned", () => {
  const own: Scope = { all: false, userId: "user-1" };

  it("lets an unrestricted caller through regardless of owner", () => {
    expect(() => assertOwned({ all: true }, "user-2", "Expense")).not.toThrow();
  });

  it("lets an owner through", () => {
    expect(() => assertOwned(own, "user-1", "Expense")).not.toThrow();
  });

  it("compares by value, not identity", () => {
    // The owner arrives as a Mongo ObjectId, not a string.
    expect(() => assertOwned(own, { toString: () => "user-1" }, "Expense")).not.toThrow();
  });

  it("refuses somebody else's record", () => {
    expect(() => assertOwned(own, "user-2", "Expense")).toThrow(AppError);
  });

  it("says not-found rather than forbidden", () => {
    // A record that answers differently depending on whether it exists tells
    // somebody iterating ids which ones are real.
    try {
      assertOwned(own, "user-2", "Expense");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AppError).code).toBe("NOT_FOUND");
      expect((e as AppError).message).toBe("Expense not found");
    }
  });

  it("refuses a record with no owner at all", () => {
    expect(() => assertOwned(own, undefined, "Expense")).toThrow(AppError);
    expect(() => assertOwned(own, null, "Expense")).toThrow(AppError);
    expect(() => assertOwned(own, "", "Expense")).toThrow(AppError);
  });
});
