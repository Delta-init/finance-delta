import { describe, expect, it } from "bun:test";
import { applyInstalmentDue, isCrmEnrolmentInvoice, nextInstalmentDue, uaeDay, uaeHour, type InstalmentInvoice } from "./instalments";

const partial = (over: Partial<InstalmentInvoice> = {}): InstalmentInvoice => ({
  status: "partial",
  balanceMinor: 250_000,
  approval: { state: "approved" },
  external: { source: "crm" },
  enrolment: { course: "Delta Wave Theory" },
  payments: [{ paidOn: new Date("2026-10-05T00:00:00.000Z") }],
  ...over,
});

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

describe("nextInstalmentDue", () => {
  it("is the latest payment's date plus 29 days", () => {
    expect(day(nextInstalmentDue(partial()))).toBe("2026-11-03");
  });

  it("goes by the latest paidOn, not the order the payments were recorded in", () => {
    const due = nextInstalmentDue(partial({
      payments: [{ paidOn: "2026-10-20" }, { paidOn: "2026-09-01" }, { paidOn: new Date("2026-10-10T18:30:00.000Z") }],
    }));
    expect(day(due)).toBe("2026-11-18");
  });

  it("counts calendar days on the UTC date, ignoring the time of day", () => {
    expect(day(nextInstalmentDue(partial({ payments: [{ paidOn: "2026-10-05T23:59:00.000Z" }] })))).toBe("2026-11-03");
    // Across a month end and a leap day
    expect(day(nextInstalmentDue(partial({ payments: [{ paidOn: "2028-02-01" }] })))).toBe("2028-03-01");
  });

  it("applies to every sales CRM, and to an enrolment typed here", () => {
    for (const source of ["crm", "draw-crm", "banglore-crm"]) {
      expect(nextInstalmentDue(partial({ external: { source }, enrolment: null }))).not.toBeNull();
    }
    expect(nextInstalmentDue(partial({ external: null }))).not.toBeNull();
  });

  it("does not apply to an invoice that is not an enrolment", () => {
    const plain = partial({ external: { source: "media-erp" }, enrolment: null });
    expect(isCrmEnrolmentInvoice(plain)).toBe(false);
    expect(nextInstalmentDue(plain)).toBeNull();
  });

  it("leaves paid, void, unapproved and unpaid invoices alone", () => {
    expect(nextInstalmentDue(partial({ balanceMinor: 0, status: "paid" }))).toBeNull();
    expect(nextInstalmentDue(partial({ balanceMinor: -5 }))).toBeNull();
    expect(nextInstalmentDue(partial({ status: "void" }))).toBeNull();
    expect(nextInstalmentDue(partial({ approval: { state: "pending" } }))).toBeNull();
    expect(nextInstalmentDue(partial({ payments: [] }))).toBeNull();
    expect(nextInstalmentDue(partial({ payments: [{ paidOn: "not a date" }] }))).toBeNull();
  });
});

describe("applyInstalmentDue", () => {
  it("sets the due date and says it changed, once", () => {
    const doc: InstalmentInvoice & { dueDate?: Date } = { ...partial(), dueDate: new Date("2026-10-05T00:00:00.000Z") };
    expect(applyInstalmentDue(doc)).toBe(true);
    expect(day(doc.dueDate!)).toBe("2026-11-03");
    expect(applyInstalmentDue(doc)).toBe(false);
  });

  it("uses the document's own setter when it has one", () => {
    const calls: [string, unknown][] = [];
    const doc = { ...partial(), dueDate: new Date("2026-10-05T00:00:00.000Z"), set: (p: string, v: unknown) => calls.push([p, v]) };
    expect(applyInstalmentDue(doc)).toBe(true);
    expect(calls[0]![0]).toBe("dueDate");
  });

  it("leaves a paid invoice's due date as it was", () => {
    const doc: InstalmentInvoice & { dueDate?: Date } = { ...partial({ balanceMinor: 0, status: "paid" }), dueDate: new Date("2026-10-05T00:00:00.000Z") };
    expect(applyInstalmentDue(doc)).toBe(false);
    expect(day(doc.dueDate!)).toBe("2026-10-05");
  });
});

describe("the UAE day", () => {
  it("is UTC+4", () => {
    expect(day(uaeDay(new Date("2026-10-11T19:59:00.000Z")))).toBe("2026-10-11");
    expect(day(uaeDay(new Date("2026-10-11T20:00:00.000Z")))).toBe("2026-10-12");
    expect(uaeHour(new Date("2026-10-11T06:00:00.000Z"))).toBe(10);
  });
});
