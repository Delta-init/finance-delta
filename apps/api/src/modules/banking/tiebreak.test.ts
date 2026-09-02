import { describe, expect, it } from "bun:test";
import { withTiebreak } from "./banking.service";

describe("withTiebreak", () => {
  it("breaks a tie in the same direction as the sort", () => {
    // A cash book reads downward: date ascending, and within a day the order
    // things were entered. Anything else makes the balance column read as
    // nonsense even when every figure in it is right.
    expect(withTiebreak({ date: 1 })).toEqual({ date: 1, createdAt: 1, _id: 1 });
    expect(withTiebreak({ date: -1 })).toEqual({ date: -1, createdAt: -1, _id: -1 });
  });

  it("leaves an explicit tiebreak alone", () => {
    expect(withTiebreak({ createdAt: 1 })).toEqual({ createdAt: 1, _id: 1 });
    expect(withTiebreak({ date: 1, createdAt: -1 })).toEqual({ date: 1, createdAt: -1, _id: 1 });
  });

  it("always ends in something unique, so paging cannot repeat or drop a row", () => {
    const sorts: Record<string, 1 | -1>[] = [
      { amountMinor: -1 },
      { description: 1 },
      { runningBalanceMinor: -1 },
    ];
    for (const s of sorts) expect(withTiebreak(s)._id).toBeDefined();
  });
});
