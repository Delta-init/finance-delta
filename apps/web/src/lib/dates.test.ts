import { describe, expect, test } from "bun:test";
import { maskDmy, parseDmy, toDmy, todayDubai } from "./dates";

describe("dates typed and shown as dd/mm/yyyy (2026-11-11)", () => {
  test("shown day first", () => {
    expect(toDmy("2026-11-05")).toBe("05/11/2026");
    expect(toDmy("2026-11-05T10:00:00.000Z")).toBe("05/11/2026");
    expect(toDmy("")).toBe("");
    expect(toDmy("nonsense")).toBe("");
  });
  test("typed day first — never read as month first", () => {
    expect(parseDmy("05/11/2026")).toBe("2026-11-05");
    expect(parseDmy("5/11/2026")).toBe("2026-11-05");
    expect(parseDmy("05-11-2026")).toBe("2026-11-05");
    expect(parseDmy("05.11.26")).toBe("2026-11-05");
    expect(parseDmy("05112026")).toBe("2026-11-05");
    expect(parseDmy("2026-11-05")).toBe("2026-11-05");
    expect(parseDmy("13/05/2026")).toBe("2026-05-13");
  });
  test("not a real date: refused", () => {
    expect(parseDmy("31/02/2026")).toBeNull();
    expect(parseDmy("05/13/2026")).toBeNull();
    expect(parseDmy("05/11")).toBeNull();
    expect(parseDmy("")).toBeNull();
    expect(parseDmy("29/02/2028")).toBe("2028-02-29");
  });
  test("slashes put in while typing", () => {
    expect(maskDmy("05")).toBe("05");
    expect(maskDmy("0511")).toBe("05/11");
    expect(maskDmy("05112026")).toBe("05/11/2026");
    expect(maskDmy("5/11/2026")).toBe("5/11/2026");
  });
  test("today is Dubai's", () => {
    expect(todayDubai(new Date("2026-11-10T21:30:00.000Z"))).toBe("2026-11-11");
    expect(todayDubai(new Date("2026-11-10T19:30:00.000Z"))).toBe("2026-11-10");
  });
});
