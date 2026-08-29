import { describe, expect, it } from "bun:test";
import { headerSafeName } from "./storage";

describe("headerSafeName", () => {
  it("leaves an ordinary filename alone", () => {
    expect(headerSafeName("receipt.pdf")).toBe("receipt.pdf");
    expect(headerSafeName("Taxi 12 Aug 2026.jpg")).toBe("Taxi 12 Aug 2026.jpg");
  });

  it("closes the header-injection route", () => {
    // The name reaches us as whatever the browser sent, and goes into
    // Content-Disposition. A line break there ends the header, so the uploader
    // would be choosing what else the response carries.
    const safe = headerSafeName(`inv"oice\r\nX-Injected: yes.pdf`);
    expect(safe).not.toContain(`"`);
    expect(safe).not.toContain("\r");
    expect(safe).not.toContain("\n");
  });

  it("strips quotes and backslashes, which close the field early", () => {
    expect(headerSafeName(`a"b`)).not.toContain(`"`);
    expect(headerSafeName("a\\b")).not.toContain("\\");
  });

  it("strips every control character, not only CR and LF", () => {
    for (const code of [0x00, 0x07, 0x09, 0x0b, 0x1f, 0x7f]) {
      const out = headerSafeName(`a${String.fromCharCode(code)}b`);
      expect(out).toBe("a_b");
    }
  });

  it("always yields something usable", () => {
    // A name that sanitises away to nothing must not produce filename="".
    expect(headerSafeName("")).toBe("file");
    expect(headerSafeName("   ")).toBe("file");
    expect(headerSafeName(`"""`)).toBe("___");
  });

  it("caps the length", () => {
    expect(headerSafeName("a".repeat(500))).toHaveLength(120);
  });
});
