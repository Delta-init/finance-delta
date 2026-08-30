import { describe, expect, test } from "bun:test";
import { daysOverdue, describeOverdue } from "./overdue";

const at = (iso: string) => new Date(iso);

describe("daysOverdue", () => {
  test("counts whole calendar days, not elapsed hours", () => {
    // Due today, late in the evening: still due today, not a day late.
    expect(daysOverdue("2026-08-30", at("2026-08-30T23:30:00"))).toBe(0);
    // Due yesterday, early morning: a full day late already.
    expect(daysOverdue("2026-08-29", at("2026-08-30T00:30:00"))).toBe(1);
  });

  test("is negative before the due date", () => {
    expect(daysOverdue("2026-09-05", at("2026-08-30T12:00:00"))).toBe(-6);
  });

  test("counts across a month and a year boundary", () => {
    expect(daysOverdue("2026-08-31", at("2026-09-01T09:00:00"))).toBe(1);
    expect(daysOverdue("2025-12-31", at("2026-01-01T09:00:00"))).toBe(1);
  });

  test("counts across a leap day", () => {
    expect(daysOverdue("2028-02-28", at("2028-03-01T09:00:00"))).toBe(2);
  });

  test("does not shift by a day across daylight saving", () => {
    // A 23-hour day must not round the wrong way.
    expect(daysOverdue("2026-03-28", at("2026-03-30T12:00:00"))).toBe(2);
    expect(daysOverdue("2026-03-29", at("2026-03-30T00:10:00"))).toBe(1);
  });

  test("tolerates a full timestamp and a malformed date", () => {
    expect(daysOverdue("2026-08-29T00:00:00.000Z", at("2026-08-30T12:00:00"))).toBe(1);
    expect(daysOverdue("")).toBe(0);
    expect(daysOverdue("not-a-date")).toBe(0);
  });
});

describe("describeOverdue", () => {
  test("says what a person would say", () => {
    expect(describeOverdue("2026-08-30", at("2026-08-30T10:00:00"))).toBe("due today");
    expect(describeOverdue("2026-08-29", at("2026-08-30T10:00:00"))).toBe("1 day late");
    expect(describeOverdue("2026-08-20", at("2026-08-30T10:00:00"))).toBe("10 days late");
    expect(describeOverdue("2026-08-31", at("2026-08-30T10:00:00"))).toBe("due tomorrow");
    expect(describeOverdue("2026-09-04", at("2026-08-30T10:00:00"))).toBe("due in 5 days");
  });
});
