import { describe, expect, it } from "bun:test";
import { logoFor, isFallbackLogo, DELTA_LOGO_WEB, DELTA_LOGO_EMAIL } from "./index";

describe("logoFor", () => {
  it("uses the organization's own logo when it has one", () => {
    const own = { logoUrl: "https://acme.test/logo.png" };
    expect(logoFor(own)).toBe("https://acme.test/logo.png");
    expect(logoFor(own, { forEmail: true })).toBe("https://acme.test/logo.png");
  });

  it("falls back to Delta when it has not", () => {
    expect(logoFor({ logoUrl: "" })).toBe(DELTA_LOGO_WEB);
    expect(logoFor(null)).toBe(DELTA_LOGO_WEB);
    expect(logoFor(undefined)).toBe(DELTA_LOGO_WEB);
    expect(logoFor({})).toBe(DELTA_LOGO_WEB);
  });

  it("gives email an absolute URL", () => {
    // A relative path in a message body resolves against nothing.
    expect(logoFor(null, { forEmail: true })).toBe(DELTA_LOGO_EMAIL);
    expect(DELTA_LOGO_EMAIL.startsWith("https://")).toBe(true);
    expect(DELTA_LOGO_WEB.startsWith("/")).toBe(true);
  });

  it("treats whitespace as unset", () => {
    // A field somebody cleared by selecting and deleting is not a logo.
    expect(logoFor({ logoUrl: "   " })).toBe(DELTA_LOGO_WEB);
    expect(isFallbackLogo({ logoUrl: "   " })).toBe(true);
  });

  it("says when the logo is the fallback", () => {
    expect(isFallbackLogo({ logoUrl: "https://acme.test/logo.png" })).toBe(false);
    expect(isFallbackLogo(null)).toBe(true);
  });
});
