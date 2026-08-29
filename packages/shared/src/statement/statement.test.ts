import { describe, expect, it } from "bun:test";
import {
  parseAmount,
  detectDecimalStyle,
  parseDate,
  detectDateFormats,
  parseDelimited,
  detectDelimiter,
  fingerprint,
} from "./index";

describe("parseAmount", () => {
  it("reads plain and separated numbers", () => {
    expect(parseAmount("500").minor).toBe(50000);
    expect(parseAmount("500.25").minor).toBe(50025);
    expect(parseAmount("1,234.56").minor).toBe(123456);
    expect(parseAmount("1 234.56").minor).toBe(123456);
  });

  it("treats parenthesised amounts as debits", () => {
    // The old parser stripped the brackets and imported this as a credit.
    expect(parseAmount("(500.00)").minor).toBe(-50000);
    expect(parseAmount("(1,234.56)").minor).toBe(-123456);
  });

  it("honours DR and CR markers", () => {
    expect(parseAmount("500.00 DR").minor).toBe(-50000);
    expect(parseAmount("500.00 CR").minor).toBe(50000);
    expect(parseAmount("DR 500.00").minor).toBe(-50000);
    expect(parseAmount("500.00 Db").minor).toBe(-50000);
  });

  it("keeps an explicit minus", () => {
    expect(parseAmount("-500.00").minor).toBe(-50000);
    expect(parseAmount("-1,234.56").minor).toBe(-123456);
  });

  it("strips currency symbols and codes", () => {
    expect(parseAmount("AED 1,234.56").minor).toBe(123456);
    expect(parseAmount("₹1,234.56").minor).toBe(123456);
    expect(parseAmount("$1,234.56").minor).toBe(123456);
  });

  it("reads the European convention when told to", () => {
    // Read as "dot" this is 1.23, which is the bug that made an import a
    // thousand times too small without reporting anything.
    expect(parseAmount("1.234,56", "comma").minor).toBe(123456);
    expect(parseAmount("1.234.567,89", "comma").minor).toBe(123456789);
    expect(parseAmount("(1.234,56)", "comma").minor).toBe(-123456);
  });

  it("does not lose a fil to floating point", () => {
    // 1.005 * 100 is 100.49999999999999 in binary floating point.
    expect(parseAmount("1.005").ok).toBe(false);   // three decimals: suspicious
    expect(parseAmount("0.07").minor).toBe(7);
    expect(parseAmount("1.15").minor).toBe(115);
    expect(parseAmount("8.29").minor).toBe(829);
    expect(parseAmount("1234567.89").minor).toBe(123456789);
  });

  it("treats blank and dash as zero", () => {
    expect(parseAmount("")).toEqual({ ok: true, minor: 0 });
    expect(parseAmount("   ")).toEqual({ ok: true, minor: 0 });
    expect(parseAmount("-").minor).toBe(0);
    expect(parseAmount("—").minor).toBe(0);
  });

  it("refuses what it cannot read rather than inventing a number", () => {
    expect(parseAmount("n/a").ok).toBe(false);
    expect(parseAmount("abc").ok).toBe(false);
    expect(parseAmount("1.2.3").ok).toBe(false);
    // Three decimal places usually means the format is the other way round.
    expect(parseAmount("1.234").ok).toBe(false);
  });
});

describe("detectDecimalStyle", () => {
  it("recognises the dot convention", () => {
    expect(detectDecimalStyle(["1,234.56", "9,876.54"])).toBe("dot");
    expect(detectDecimalStyle(["1,234", "12"])).toBe("dot");
  });

  it("recognises the comma convention", () => {
    expect(detectDecimalStyle(["1.234,56", "9.876,54"])).toBe("comma");
    expect(detectDecimalStyle(["1.234", "12"])).toBe("comma");
  });

  it("admits when a column settles nothing", () => {
    // No separators at all, or only ever two trailing digits.
    expect(detectDecimalStyle(["500", "1200"])).toBe("ambiguous");
    expect(detectDecimalStyle([])).toBe("ambiguous");
  });
});

describe("parseDate", () => {
  it("reads each layout", () => {
    expect(parseDate("15/01/2026", "dmy").iso).toBe("2026-01-15");
    expect(parseDate("01/15/2026", "mdy").iso).toBe("2026-01-15");
    expect(parseDate("2026-01-15", "ymd").iso).toBe("2026-01-15");
    expect(parseDate("15-Jan-2026", "dMonY").iso).toBe("2026-01-15");
    expect(parseDate("15 Jan 2026", "dMonY").iso).toBe("2026-01-15");
  });

  it("does not shift the day", () => {
    // `new Date("01/15/2026").toISOString()` gives the 14th west of UTC. A
    // statement date is a calendar day and must survive as one.
    for (const d of ["01/01/2026", "31/12/2025", "01/03/2026"]) {
      expect(parseDate(d, "dmy").iso.endsWith(d.slice(0, 2))).toBe(true);
    }
    expect(parseDate("31/12/2025", "dmy").iso).toBe("2025-12-31");
  });

  it("accepts the separators banks use", () => {
    expect(parseDate("15.01.2026", "dmy").iso).toBe("2026-01-15");
    expect(parseDate("15-01-2026", "dmy").iso).toBe("2026-01-15");
    expect(parseDate("15 01 2026", "dmy").iso).toBe("2026-01-15");
  });

  it("expands two-digit years", () => {
    expect(parseDate("15/01/26", "dmy").iso).toBe("2026-01-15");
    expect(parseDate("15/01/99", "dmy").iso).toBe("1999-01-15");
  });

  it("rejects impossible dates instead of rolling them over", () => {
    // `new Date(2026, 1, 30)` silently becomes 2 March.
    expect(parseDate("30/02/2026", "dmy").ok).toBe(false);
    expect(parseDate("32/01/2026", "dmy").ok).toBe(false);
    expect(parseDate("15/13/2026", "dmy").ok).toBe(false);
    expect(parseDate("", "dmy").ok).toBe(false);
    expect(parseDate("not a date", "dmy").ok).toBe(false);
  });

  it("knows February in a leap year", () => {
    expect(parseDate("29/02/2024", "dmy").ok).toBe(true);
    expect(parseDate("29/02/2026", "dmy").ok).toBe(false);
  });
});

describe("detectDateFormats", () => {
  it("narrows to one layout when a day exceeds twelve", () => {
    expect(detectDateFormats(["15/01/2026", "03/02/2026"])).toEqual(["dmy"]);
    expect(detectDateFormats(["01/15/2026", "02/03/2026"])).toEqual(["mdy"]);
  });

  it("reports both when the column is genuinely ambiguous", () => {
    // 03/04 is 3 April or 4 March. Guessing picks the wrong month silently.
    const formats = detectDateFormats(["03/04/2026", "05/06/2026"]);
    expect(formats).toContain("dmy");
    expect(formats).toContain("mdy");
  });

  it("recognises ISO and named months", () => {
    expect(detectDateFormats(["2026-01-15"])).toContain("ymd");
    expect(detectDateFormats(["15-Jan-2026"])).toEqual(["dMonY"]);
  });

  it("returns nothing for an unreadable column", () => {
    expect(detectDateFormats(["rubbish", "more rubbish"])).toEqual([]);
    expect(detectDateFormats([])).toEqual([]);
  });
});

describe("parseDelimited", () => {
  it("keeps a quoted line break inside its own field", () => {
    // Splitting on newlines first shifts every later column, so the amount is
    // read out of the wrong cell.
    const rows = parseDelimited('Date,Description,Amount\n15/01/2026,"ATM\nCash",100.00');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(["15/01/2026", "ATM\nCash", "100.00"]);
  });

  it("keeps a quoted delimiter inside its own field", () => {
    const rows = parseDelimited('A,B\n"Smith, John",500');
    expect(rows[1]).toEqual(["Smith, John", "500"]);
  });

  it("reads an escaped quote", () => {
    const rows = parseDelimited('A\n"He said ""hi"""');
    expect(rows[1]).toEqual(['He said "hi"']);
  });

  it("drops a byte-order mark from the first header", () => {
    const rows = parseDelimited("﻿Date,Amount\n15/01/2026,100");
    expect(rows[0]![0]).toBe("Date");
  });

  it("handles CRLF and skips blank lines", () => {
    const rows = parseDelimited("A,B\r\n1,2\r\n\r\n3,4\r\n");
    expect(rows).toEqual([["A", "B"], ["1", "2"], ["3", "4"]]);
  });

  it("reads other delimiters", () => {
    expect(parseDelimited("A;B\n1;2", ";")).toEqual([["A", "B"], ["1", "2"]]);
    expect(detectDelimiter("Date;Description;Amount")).toBe(";");
    expect(detectDelimiter("Date,Description,Amount")).toBe(",");
    expect(detectDelimiter("SingleColumn")).toBe(",");
  });
});

describe("fingerprint", () => {
  const base = { isoDate: "2026-01-15", amountMinor: -50000, description: "ATM Withdrawal", reference: "REF1" };

  it("matches the same line across two exports", () => {
    expect(fingerprint(base)).toBe(
      fingerprint({ ...base, description: "atm  withdrawal!" }),
    );
  });

  it("separates lines that differ in what matters", () => {
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, amountMinor: -50001 }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, isoDate: "2026-01-16" }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, reference: "REF2" }));
  });

  it("does not confuse a credit with a debit of the same size", () => {
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, amountMinor: 50000 }));
  });
});
