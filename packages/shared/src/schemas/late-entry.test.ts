import { describe, expect, test } from "bun:test";
import { isLateDate, lateEntryCutoff } from "./late-entry.schema";

describe("late entries", () => {
  // 2026-10-17 01:00 in Dubai is still 2026-10-16 in UTC: the day is Dubai's.
  const now = new Date("2026-10-16T21:00:00Z");
  test("the cutoff is today in Dubai less the days, less one", () => {
    expect(lateEntryCutoff(7, now)).toBe("2026-10-11");
    expect(lateEntryCutoff(1, now)).toBe("2026-10-17");
  });
  test("N or more days back is late: with 7, 6 back is on time and 7 back late", () => {
    expect(isLateDate("2026-10-11", 7, now)).toBe(false);
    expect(isLateDate("2026-10-10", 7, now)).toBe(true);
    expect(isLateDate(new Date("2026-10-10T00:00:00Z"), 7, now)).toBe(true);
  });
  test("1 day (2026-10-21): yesterday is late, today is not", () => {
    expect(isLateDate("2026-10-16", 1, now)).toBe(true);
    expect(isLateDate("2026-10-17", 1, now)).toBe(false);
  });
  test("today, the future, nothing, and 0 days are never late", () => {
    expect(isLateDate("2026-10-17", 7, now)).toBe(false);
    expect(isLateDate("2027-01-01", 7, now)).toBe(false);
    expect(isLateDate("", 7, now)).toBe(false);
    expect(isLateDate("2020-01-01", 0, now)).toBe(false);
  });
});
