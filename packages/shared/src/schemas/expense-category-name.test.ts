import { describe, expect, test } from "bun:test";
import { createExpenseSchema } from "./expense.schema";

const base = {
  category: "other",
  description: "Plants for reception",
  expenseDate: "2026-08-31",
  amountMinor: 5000,
};

describe("naming an Other expense", () => {
  test("a name is optional", () => {
    expect(createExpenseSchema.parse(base).categoryOther).toBe("");
  });

  test("carries the name when given", () => {
    expect(createExpenseSchema.parse({ ...base, categoryOther: "Office plants" }).categoryOther)
      .toBe("Office plants");
  });

  test("refuses one long enough to break a report column", () => {
    expect(() =>
      createExpenseSchema.parse({ ...base, categoryOther: "x".repeat(61) }),
    ).toThrow();
    expect(createExpenseSchema.parse({ ...base, categoryOther: "x".repeat(60) }).categoryOther)
      .toHaveLength(60);
  });
});

import { resolveCategoryName } from "./expense.schema";

describe("resolveCategoryName", () => {
  test("a typed name is used for Other", () => {
    expect(resolveCategoryName("other", "Other", "Office plants")).toBe("Office plants");
  });

  test("Other falls back to its own label when nothing was typed", () => {
    expect(resolveCategoryName("other", "Other")).toBe("Other");
    expect(resolveCategoryName("other", "Other", "")).toBe("Other");
    expect(resolveCategoryName("other", "Other", "   ")).toBe("Other");
  });

  test("a real category cannot be renamed", () => {
    // Otherwise a claim filed under Rent could call itself Coffee, and the name
    // is what every screen shows.
    expect(resolveCategoryName("rent", "Rent", "Coffee")).toBe("Rent");
    expect(resolveCategoryName("travel", "Travel", "Anything")).toBe("Travel");
  });

  test("trims and caps what it stores", () => {
    expect(resolveCategoryName("other", "Other", "  Office plants  ")).toBe("Office plants");
    expect(resolveCategoryName("other", "Other", "y".repeat(80))).toHaveLength(60);
  });
});
