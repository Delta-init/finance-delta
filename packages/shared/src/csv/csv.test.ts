import { describe, expect, test } from "bun:test";
import { csvField, toCsv } from "./index";

describe("csvField", () => {
  test("leaves an ordinary value alone", () => {
    expect(csvField("Office supplies")).toBe("Office supplies");
    expect(csvField(1050)).toBe("1050");
  });

  test("quotes a value containing a comma", () => {
    // Otherwise the row gains a column and every figure after it shifts left.
    expect(csvField("Paid Ali, 50")).toBe('"Paid Ali, 50"');
  });

  test("doubles quotes inside a quoted value", () => {
    expect(csvField('Paid "Ali"')).toBe('"Paid ""Ali"""');
  });

  test("quotes a value containing a line break", () => {
    expect(csvField("one\ntwo")).toBe('"one\ntwo"');
  });

  test("empty and absent are both an empty field", () => {
    expect(csvField("")).toBe("");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  test("a value Excel would run as a formula is kept as text", () => {
    // =1+1 in a cell is a formula, not a description. The leading quote makes
    // Excel treat it as text, and the character itself is not lost.
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("+971 50 000 0000")).toBe("'+971 50 000 0000");
    expect(csvField("-90")).toBe("'-90");
    expect(csvField("@handle")).toBe("'@handle");
  });

  test("a formula that also needs quoting gets both", () => {
    expect(csvField("=SUM(A1,A2)")).toBe(`"'=SUM(A1,A2)"`);
  });
});

describe("toCsv", () => {
  const rows = [
    { date: "2026-09-02", description: "Paid Ali, 50", inMinor: 0, outMinor: 5000 },
    { date: "2026-09-03", description: "Student payment", inMinor: 230300, outMinor: 0 },
  ];
  const columns = [
    { header: "Date", value: (r: (typeof rows)[number]) => r.date },
    { header: "Description", value: (r: (typeof rows)[number]) => r.description },
    { header: "In", value: (r: (typeof rows)[number]) => (r.inMinor ? (r.inMinor / 100).toFixed(2) : "") },
    { header: "Out", value: (r: (typeof rows)[number]) => (r.outMinor ? (r.outMinor / 100).toFixed(2) : "") },
  ];

  test("writes a header and one line per row", () => {
    const csv = toCsv(rows, columns);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Date,Description,In,Out");
    expect(lines[1]).toBe('2026-09-02,"Paid Ali, 50",,50.00');
    expect(lines[2]).toBe("2026-09-03,Student payment,2303.00,");
  });

  test("no rows still gives a usable file with its header", () => {
    expect(toCsv([], columns)).toBe("Date,Description,In,Out\r\n");
  });

  test("ends with a newline, which some tools need to see the last row", () => {
    expect(toCsv(rows, columns).endsWith("\r\n")).toBe(true);
  });
});
