import { describe, expect, test } from "bun:test";
import {
  checkManualPayrollLine, checkManualPayrollRows, findManualPayrollHeaderRow, manualPayrollLineSchema,
  manualPayrollTemplateRows, matchManualPayrollColumns, MANUAL_PAYROLL_FIELDS, parsePayrollAmount, readManualPayrollRows,
} from "./manual-payroll";

const line = (over: Record<string, unknown> = {}) =>
  manualPayrollLineSchema.parse({ name: "Employee One", grossMinor: 45_000_00, ...over });

describe("manual payroll amounts", () => {
  test("text as people type it: grouping, Indian grouping, currency, /-, brackets, minus", () => {
    expect(parsePayrollAmount("45,000")).toEqual({ ok: true, minor: 45_000_00 });
    expect(parsePayrollAmount("4,50,000.50")).toEqual({ ok: true, minor: 450_000_50 });
    expect(parsePayrollAmount("₹45,000")).toEqual({ ok: true, minor: 45_000_00 });
    expect(parsePayrollAmount("Rs. 45,000/-")).toEqual({ ok: true, minor: 45_000_00 });
    expect(parsePayrollAmount("AED 1,250.75")).toEqual({ ok: true, minor: 1_250_75 });
    expect(parsePayrollAmount("1,250.75 INR")).toEqual({ ok: true, minor: 1_250_75 });
    expect(parsePayrollAmount("(500)")).toEqual({ ok: true, minor: -500_00 });
    expect(parsePayrollAmount("-₹500")).toEqual({ ok: true, minor: -500_00 });
    expect(parsePayrollAmount("157.5")).toEqual({ ok: true, minor: 157_50 });
  });
  test("numbers as Excel holds them, rounded like money", () => {
    expect(parsePayrollAmount(45000)).toEqual({ ok: true, minor: 45_000_00 });
    expect(parsePayrollAmount(1.005)).toEqual({ ok: true, minor: 101 });
    expect(parsePayrollAmount(45000.100000000006)).toEqual({ ok: true, minor: 45_000_10 });
  });
  test("blank is not given, a dash is zero, anything else is a reason", () => {
    expect(parsePayrollAmount("")).toEqual({ ok: true, minor: null });
    expect(parsePayrollAmount(undefined)).toEqual({ ok: true, minor: null });
    expect(parsePayrollAmount("-")).toEqual({ ok: true, minor: 0 });
    expect(parsePayrollAmount("abc").ok).toBe(false);
    expect(parsePayrollAmount("12.345").ok).toBe(false);
    expect(parsePayrollAmount("1.2.3").ok).toBe(false);
  });
});

describe("manual payroll lines", () => {
  test("net is gross less the named deductions, zeros left out", () => {
    const c = checkManualPayrollLine(line({ deductions: { pf: 1_800_00, tds: 1_500_00, professionalTax: 200_00 } }), "INR");
    expect(c.problems).toEqual([]);
    expect(c.netMinor).toBe(41_500_00);
    expect(c.deductionsMinor).toBe(3_500_00);
    expect(c.deductions.map((d) => d.label)).toEqual(["PF", "Professional tax", "TDS (income tax)"]);
    expect(c.currency).toBe("INR");
  });
  test("a stated net that agrees passes; one that does not is flagged", () => {
    expect(checkManualPayrollLine(line({ deductions: { pf: 1_000_00 }, netMinor: 44_000_00 }), "INR").problems).toEqual([]);
    expect(checkManualPayrollLine(line({ deductions: { pf: 1_000_00 }, netMinor: 45_000_00 }), "INR").problems[0]).toContain("Net in the file is 45,000.00");
  });
  test("missing name, missing gross, negative net, negative deduction, bad currency", () => {
    expect(checkManualPayrollLine(line({ name: " " }), "INR").problems).toContain("Name is missing");
    expect(checkManualPayrollLine(line({ grossMinor: 0 }), "INR").problems).toContain("Gross pay is missing");
    expect(checkManualPayrollLine(line({ grossMinor: 1_000_00, deductions: { other: 2_000_00 } }), "INR").problems[0]).toContain("negative");
    expect(checkManualPayrollLine(line({ deductions: { esi: -5_00 } }), "INR").problems).toContain("ESI can't be negative");
    expect(checkManualPayrollLine(line({ currency: "rupees" }), "INR").problems[0]).toContain("3-letter");
    expect(checkManualPayrollLine(line({ currency: "inr" }), "INR").problems).toEqual([]);
    expect(checkManualPayrollLine(line({ currency: "aed" }), "INR").problems[0]).toContain("put them on the AED month");
  });
  test("an employee code once — in the file and against the month; one currency; totals of the good rows", () => {
    const rows = checkManualPayrollRows([
      line({ rowNo: 2, employeeCode: "E-1" }),
      line({ rowNo: 3, employeeCode: "e-1", name: "Employee Two" }),
      line({ rowNo: 4, employeeCode: "E-9", name: "Employee Three" }),
      line({ rowNo: 5, name: "Employee Four", grossMinor: 1_000_00, currency: "AED" }),
      line({ rowNo: 6, name: "Employee Five" }),
    ], "INR", ["E-9"]);
    expect(rows.rows[1]!.check.problems[0]).toContain("on row 2 too");
    expect(rows.rows[2]!.check.problems[0]).toContain("already on this month");
    expect(rows.rows[3]!.check.problems[0]).toContain("this month is in INR");
    expect(rows.good).toBe(2);
    expect(rows.bad).toBe(3);
    expect(rows.byCurrency).toEqual([
      { currency: "INR", employeeCount: 2, grossMinor: 90_000_00, deductionsMinor: 0, netMinor: 90_000_00 },
    ]);
  });
});

describe("reading a manual payroll sheet", () => {
  const heads = MANUAL_PAYROLL_FIELDS.map((f) => f.label);
  test("the template reads back as it was written: headings found, every column matched, nets agree", () => {
    const sheet = [["Payroll — November"], [], heads, ...manualPayrollTemplateRows("INR"), ["Total", "", "", "", "", "", "", "", "66,000.00"]];
    const hr = findManualPayrollHeaderRow(sheet);
    expect(hr).toBe(2);
    const cols = matchManualPayrollColumns(sheet[hr]!);
    expect(Object.keys(cols).length).toBe(MANUAL_PAYROLL_FIELDS.length);
    const read = readManualPayrollRows(sheet, hr, cols);
    expect(read.unreadable).toEqual([]);
    expect(read.skipped).toBe(1);
    expect(read.lines.map((l) => [l.rowNo, l.name, l.grossMinor, l.netMinor])).toEqual([
      [4, "Employee One", 45_000_00, 41_500_00],
      [5, "Employee Two", 21_000_00, 18_342_50],
    ]);
    const checked = checkManualPayrollRows(read.lines, "INR");
    expect(checked.bad).toBe(0);
    expect(checked.byCurrency[0]!.netMinor).toBe(59_842_50);
  });
  test("other headings people use; a column that isn't there is simply not read", () => {
    const cols = matchManualPayrollColumns(["Emp ID", "Employee Name", "Dept", "Gross Salary", "EPF", "ESIC", "PT", "Income Tax", "Net Salary"]);
    expect(cols).toEqual({ employeeCode: 0, name: 1, departmentName: 2, gross: 3, pf: 4, esi: 5, professionalTax: 6, tds: 7, net: 8 });
    expect(matchManualPayrollColumns(["Name", "Gross", "Other allowances"]).other).toBeUndefined();
  });
  test("a cell that isn't an amount leaves its row out, with why", () => {
    const sheet = [["Name", "Gross pay", "PF"], ["Employee One", "45,000", "abc"], ["Employee Two", 30000, 1800]];
    const read = readManualPayrollRows(sheet, 0, matchManualPayrollColumns(sheet[0]!));
    expect(read.unreadable).toEqual([{ rowNo: 2, name: "Employee One", problems: ['PF: "abc" isn\'t an amount'] }]);
    expect(read.lines.map((l) => [l.name, l.grossMinor, l.deductions.pf, l.netMinor])).toEqual([["Employee Two", 30_000_00, 1_800_00, null]]);
  });
  test("an amount beyond any payroll is said, not stored", () => {
    const sheet = [["Name", "Gross pay"], ["Employee One", "999,999,999,999,999"]];
    const read = readManualPayrollRows(sheet, 0, matchManualPayrollColumns(sheet[0]!));
    expect(read.lines).toEqual([]);
    expect(read.unreadable[0]!.problems[0]).toContain("too large");
  });
  test("no heading row with a name and a gross is -1", () => {
    expect(findManualPayrollHeaderRow([["Date", "Amount"], ["2026-11-01", "5"]])).toBe(-1);
  });
});
