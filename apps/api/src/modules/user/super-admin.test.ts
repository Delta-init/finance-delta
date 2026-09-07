import { describe, expect, it } from "bun:test";
import { superAdminChange, type Actor } from "./user.service";

const SUPER: Actor = { userId: "boss", isSuperAdmin: true };
const ADMIN: Actor = { userId: "admin", isSuperAdmin: false };

describe("superAdminChange", () => {
  it("leaves the flag alone when nothing was asked for", () => {
    expect(superAdminChange(false, undefined, ADMIN, "someone")).toBeNull();
    expect(superAdminChange(true, undefined, ADMIN, "someone")).toBeNull();
  });

  // An ordinary administrator editing a super admin's name sends the whole
  // form back. Echoing the current value is not an escalation attempt.
  it("leaves the flag alone when the value already matches", () => {
    expect(superAdminChange(true, true, ADMIN, "someone")).toBeNull();
    expect(superAdminChange(false, false, ADMIN, "someone")).toBeNull();
  });

  it("refuses an organization administrator trying to grant it", () => {
    expect(() => superAdminChange(false, true, ADMIN, "someone")).toThrow(
      /Only a super admin/,
    );
  });

  it("refuses an organization administrator trying to take it away", () => {
    expect(() => superAdminChange(true, false, ADMIN, "someone")).toThrow(
      /Only a super admin/,
    );
  });

  it("lets a super admin grant it", () => {
    expect(superAdminChange(false, true, SUPER, "someone")).toBe(true);
  });

  it("lets a super admin take it off somebody else", () => {
    expect(superAdminChange(true, false, SUPER, "someone")).toBe(false);
  });

  it("refuses a super admin taking it off themselves", () => {
    expect(() => superAdminChange(true, false, SUPER, "boss")).toThrow(
      /your own super admin/,
    );
  });

  // Granting yourself what you already have is caught by the no-change rule
  // before either guard, so it is neither a refusal nor a write.
  it("is a no-op when a super admin re-affirms their own flag", () => {
    expect(superAdminChange(true, true, SUPER, "boss")).toBeNull();
  });
});
