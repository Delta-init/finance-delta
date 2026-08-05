import { describe, it, expect } from "bun:test";
import { hasPermission, PERMISSIONS, WILDCARD } from "./permissions";

describe("hasPermission", () => {
  it("grants everything to the wildcard (admin) permission set", () => {
    expect(hasPermission([WILDCARD], "customer:create")).toBe(true);
    expect(hasPermission([WILDCARD], "department:delete")).toBe(true);
    expect(hasPermission([WILDCARD], "user:delete")).toBe(true);
  });

  it("grants an exact permission and denies one that is absent", () => {
    const granted = ["customer:read", "invoice:read"];
    expect(hasPermission(granted, "customer:read")).toBe(true);
    expect(hasPermission(granted, "customer:create")).toBe(false);
    expect(hasPermission(granted, "invoice:read")).toBe(true);
  });

  it("denies everything for an empty permission set", () => {
    expect(hasPermission([], "customer:read")).toBe(false);
  });
});

describe("permission catalog", () => {
  it("includes the department write permissions (regression for the RBAC fix)", () => {
    // These back the requirePermission guards on the departments write routes;
    // a viewer without them must be blocked.
    expect(PERMISSIONS).toContain("department:read");
    expect(PERMISSIONS).toContain("department:create");
    expect(PERMISSIONS).toContain("department:update");
    expect(PERMISSIONS).toContain("department:delete");
  });

  it("has no duplicate entries", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it("simulates the departments RBAC fix: a read-only viewer cannot write", () => {
    const viewer = ["customer:read", "invoice:read", "report:read", "department:read"];
    expect(hasPermission(viewer, "department:read")).toBe(true);
    expect(hasPermission(viewer, "department:create")).toBe(false);
    expect(hasPermission(viewer, "department:update")).toBe(false);
    expect(hasPermission(viewer, "department:delete")).toBe(false);
  });
});
