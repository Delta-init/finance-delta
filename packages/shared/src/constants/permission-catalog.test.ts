import { describe, expect, test } from "bun:test";
import { PERMISSIONS } from "./permissions";
import { permissionSections, summarisePermissions } from "./permission-catalog";

describe("permissionSections", () => {
  const sections = permissionSections();
  const shown = sections.flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.value)));

  test("every permission can be granted — none is left out of the UI", () => {
    // The point of deriving from PERMISSIONS: a permission that exists but
    // cannot be ticked is invisible to whoever is building a role.
    expect([...shown].sort()).toEqual([...PERMISSIONS].sort());
  });

  test("shows each permission exactly once", () => {
    expect(new Set(shown).size).toBe(shown.length);
  });

  test("gives every action a label that is not the raw string", () => {
    for (const s of sections) {
      for (const g of s.groups) {
        for (const item of g.items) {
          expect(item.label.length).toBeGreaterThan(0);
          expect(item.label).not.toBe(item.value);
        }
      }
    }
  });

  test("explains the :own actions, which are the ones people get wrong", () => {
    const own = sections
      .flatMap((s) => s.groups.flatMap((g) => g.items))
      .filter((i) => i.action.endsWith(":own"));
    expect(own.length).toBeGreaterThan(0);
    for (const item of own) expect(item.note).toBeTruthy();
  });

  test("puts invoices under Sales and users under Administration", () => {
    const find = (resource: string) =>
      sections.find((s) => s.groups.some((g) => g.resource === resource))?.label;
    expect(find("invoice")).toBe("Sales");
    expect(find("user")).toBe("Administration");
  });
});

describe("summarisePermissions", () => {
  test("names what a role reaches rather than counting", () => {
    expect(summarisePermissions(["invoice:read:own", "invoice:write:own", "customer:read"]))
      .toBe("Invoices, Customers");
  });

  test("the wildcard says so plainly", () => {
    expect(summarisePermissions(["*"])).toBe("Everything");
  });

  test("an empty role is not blank", () => {
    expect(summarisePermissions([])).toBe("Nothing");
  });

  test("caps the list so a long role does not overflow the cell", () => {
    const summary = summarisePermissions(
      ["customer:read", "quotation:read", "invoice:read", "tag:read", "vendor:read", "bill:read"],
      4,
    );
    expect(summary).toContain("+2 more");
  });
});
