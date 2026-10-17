import { describe, expect, test } from "bun:test";
import { isLateDate, lateEntryCutoff } from "./late-entry.schema";

describe("late entries", () => {
  // 2026-10-17 01:00 in Dubai is still 2026-10-16 in UTC: the day is Dubai's.
  const now = new Date("2026-10-16T21:00:00Z");
  test("the cutoff is today in Dubai less the days", () => {
    expect(lateEntryCutoff(7, now)).toBe("2026-10-10");
  });
  test("7 days back is on time, 8 is late", () => {
    expect(isLateDate("2026-10-10", 7, now)).toBe(false);
    expect(isLateDate("2026-10-09", 7, now)).toBe(true);
    expect(isLateDate(new Date("2026-10-09T00:00:00Z"), 7, now)).toBe(true);
  });
  test("today, the future, nothing, and 0 days are never late", () => {
    expect(isLateDate("2026-10-17", 7, now)).toBe(false);
    expect(isLateDate("2027-01-01", 7, now)).toBe(false);
    expect(isLateDate("", 7, now)).toBe(false);
    expect(isLateDate("2020-01-01", 0, now)).toBe(false);
  });
});
