import { describe, expect, it } from "bun:test";
import {
  parseAmount,
  detectDecimalStyle,
  parseDate,
  detectDateFormats,
  parseDelimited,
  detectDelimiter,
  fingerprint,
  detectHeaderRow,
  columnRefs,
  usefulColumns,
  looksLikeTotalRow,
  readStatementMeta,
  verifyBalances,
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

// The shape of a real Federal Bank export: a block of account details, then
// headings twenty rows down, then transactions, then a totals line and notes.
const REAL_HEADER = [
  "", "", "", "Date", "", "Value Date", "Particulars", "", "", "", "Tran Type",
  "Tran ID", "Cheque Details", "", "", "Withdrawals", "", "", "Deposits", "",
  "", "Balance", "Balance Type", "", "", "", "", "",
];

describe("detectHeaderRow", () => {
  it("finds headings that are not on the first row", () => {
    const rows = [
      ["", "", "", "", "Name", "", "", "", "EDUFINTRA PRIVATE LIMITED"],
      ["", "", "", "", "Account Number       :", "", "", "", "21660200006498"],
      ["", "", "", "", "Opening Balance      :", "", "", "", "3,16,775.07"],
      REAL_HEADER,
      ["", "", "", "17/08/2026", "", "17/08/2026", "TO ATM"],
    ];
    expect(detectHeaderRow(rows).headerRow).toBe(3);
    expect(detectHeaderRow(rows).metadataRows).toBe(3);
  });

  it("finds a heading row that is already first", () => {
    expect(detectHeaderRow([["Date", "Description", "Amount", "Balance"], ["a", "b", "c", "d"]]).headerRow).toBe(0);
  });

  it("is not fooled by a metadata line mentioning a date", () => {
    // "Date of Issue" and "Account Open Date" are not a heading row.
    const rows = [
      ["Date of Issue :", "24/08/2026"],
      ["Account Open Date :", "15/04/2026"],
      ["Date", "Particulars", "Withdrawals", "Deposits", "Balance"],
    ];
    expect(detectHeaderRow(rows).headerRow).toBe(2);
  });

  it("reports nothing rather than guessing when there is no heading row", () => {
    expect(detectHeaderRow([["a", "b"], ["c", "d"]]).headerRow).toBe(-1);
  });
});

describe("columnRefs and usefulColumns", () => {
  it("identifies columns by position, not by heading text", () => {
    const refs = columnRefs(REAL_HEADER);
    expect(refs[15]).toEqual({ index: 15, label: "Withdrawals", unnamed: false });
    expect(refs[18]).toEqual({ index: 18, label: "Deposits", unnamed: false });
    // Eighteen columns share the same blank heading; by name they would all
    // resolve to the first one.
    expect(refs.filter((c) => c.unnamed)).toHaveLength(18);
    expect(refs[0]!.label).not.toBe(refs[1]!.label);
  });

  it("drops padding columns that are empty everywhere", () => {
    const rows = [["", "", "", "17/08/2026", "", "", "TO ATM", "", "", "", "", "", "", "", "", "10,000.00"]];
    const kept = usefulColumns(columnRefs(REAL_HEADER), rows);
    expect(kept.some((c) => c.index === 3)).toBe(true);   // Date, named
    expect(kept.some((c) => c.index === 15)).toBe(true);  // Withdrawals, named
    expect(kept.some((c) => c.index === 24)).toBe(false); // unnamed and always empty
  });
});

describe("looksLikeTotalRow", () => {
  it("recognises the lines that are not transactions", () => {
    expect(looksLikeTotalRow(["", "GRAND TOTAL", "1,47,327.62"])).toBe(true);
    expect(looksLikeTotalRow(["Closing Balance", "3,04,487.45"])).toBe(true);
    expect(looksLikeTotalRow(["****END OF STATEMENT****"])).toBe(true);
    expect(looksLikeTotalRow(["Brought Forward", "100.00"])).toBe(true);
  });

  it("leaves real transactions alone", () => {
    expect(looksLikeTotalRow(["17/08/2026", "UPI IN/328607988207", "2,000.00"])).toBe(false);
    // "TOTAL" inside a merchant name is not a totals row.
    expect(looksLikeTotalRow(["17/08/2026", "TO ECM/TOTAL FITNESS LTD", "500.00"])).toBe(false);
  });
});

describe("readStatementMeta", () => {
  const metaRows = [
    ["", "", "", "", "Name", "", "", "", "EDUFINTRA PRIVATE LIMITED"],
    ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "Account Number       :", "", "", "", "", "", "21660200006498"],
    ["", "", "", "", "Opening Balance                 :", "", "", "", "3,16,775.07"],
    ["", "", "", "", "Effective Available Balance :", "", "", "", "304487.45"],
  ];

  it("reads the account number and the balances", () => {
    const meta = readStatementMeta(metaRows);
    expect(meta.accountNumber).toBe("21660200006498");
    expect(meta.openingBalanceMinor).toBe(31677507);
    expect(meta.closingBalanceMinor).toBe(30448745);
  });

  it("returns nothing rather than guessing when the block has none of it", () => {
    expect(readStatementMeta([["just", "some", "text"]])).toEqual({});
  });
});

describe("verifyBalances", () => {
  it("accepts a run that lands where the bank says", () => {
    const r = verifyBalances(31677507, [
      { amountMinor: -1000000, statedBalanceMinor: 30677507 },
      { amountMinor: 200000, statedBalanceMinor: 30877507 },
    ]);
    expect(r.ok).toBe(true);
  });

  it("points at the first line that disagrees", () => {
    const r = verifyBalances(31677507, [
      { amountMinor: -1000000, statedBalanceMinor: 30677507 },
      // Read as a credit when it was a debit — the classic mapping mistake.
      { amountMinor: 200000, statedBalanceMinor: 30477507 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.firstMismatchAt).toBe(1);
    expect(r.expectedMinor).toBe(30877507);
    expect(r.statedMinor).toBe(30477507);
  });

  it("passes over lines with no stated balance", () => {
    expect(verifyBalances(0, [{ amountMinor: 100 }, { amountMinor: 200 }]).ok).toBe(true);
  });
});
