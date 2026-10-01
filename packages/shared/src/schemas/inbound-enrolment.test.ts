import { describe, expect, it } from "bun:test";
import {
  enrolmentInputSchema,
  inboundEnrolmentLanguage,
  inboundEnrolmentSchema,
} from "./invoice.schema";

const PAYLOAD = {
  externalId: "crm-1",
  customer: { name: "A Student", email: "student@example.com", phone: "+971500000000" },
  course: { name: "A Course", amountMinor: 130000 },
  salespersonEmail: "rep@example.com",
};

describe("inbound enrolment language", () => {
  // The CRM has no language field and sends "". The two schemas disagree by
  // design; what must hold is that the bridge between them produces something
  // the stricter one accepts, because the database is stricter still and a
  // rejection there costs the sale.
  it("turns what the caller can supply into what an enrolment requires", () => {
    const inbound = inboundEnrolmentSchema.parse({ ...PAYLOAD, language: "" });
    expect(inbound.language).toBe("");

    const enrolment = {
      course: inbound.course!.name,
      modeOfStudy: inbound.modeOfStudy,
      language: inboundEnrolmentLanguage(inbound.language),
    };
    expect(enrolmentInputSchema.safeParse(enrolment).success).toBe(true);
  });

  it("is what the strict schema rejects that makes this necessary", () => {
    const bare = { course: "A Course", modeOfStudy: "online" as const, language: "" };
    expect(enrolmentInputSchema.safeParse(bare).success).toBe(false);
  });

  it("keeps a language the caller did supply", () => {
    expect(inboundEnrolmentLanguage("Arabic")).toBe("Arabic");
    expect(inboundEnrolmentLanguage("  English  ")).toBe("English");
  });

  it("stands in for one that is missing entirely, not only empty", () => {
    expect(inboundEnrolmentLanguage(undefined)).toBe("Not specified");
    expect(inboundEnrolmentLanguage("   ")).toBe("Not specified");
  });

  // The default the schema applies is the empty string, so a caller omitting
  // the field lands in exactly the case above rather than a different one.
  it("omitting the field is the same case as sending it empty", () => {
    expect(inboundEnrolmentSchema.parse(PAYLOAD).language).toBe("");
  });
});

describe("inbound enrolment bonus and balance", () => {
  // Asked at the close: yes with an amount, or no. Information only — it is
  // never a line on the invoice and never part of the balance.
  it("keeps a bonus that was given, with its amount", () => {
    const inbound = inboundEnrolmentSchema.parse({ ...PAYLOAD, bonus: { given: true, amountMinor: 50000 }, balanceMinor: 80000 });
    expect(inbound.bonus).toEqual({ given: true, amountMinor: 50000 });
    expect(inbound.balanceMinor).toBe(80000);
  });

  it("refuses a bonus that was given without an amount", () => {
    expect(inboundEnrolmentSchema.safeParse({ ...PAYLOAD, bonus: { given: true, amountMinor: 0 } }).success).toBe(false);
    expect(inboundEnrolmentSchema.safeParse({ ...PAYLOAD, bonus: { given: true } }).success).toBe(false);
  });

  // "No" is an answer, and carries no amount whatever was sent beside it.
  it("records no bonus as no, with nothing beside it", () => {
    expect(inboundEnrolmentSchema.parse({ ...PAYLOAD, bonus: { given: false, amountMinor: 9900 } }).bonus).toEqual({ given: false, amountMinor: 0 });
    expect(inboundEnrolmentSchema.parse({ ...PAYLOAD, bonus: { given: false } }).bonus).toEqual({ given: false, amountMinor: 0 });
  });

  // A caller from before the question was asked sends neither, and that is
  // different from answering "no".
  it("leaves both out for a caller that does not send them", () => {
    const inbound = inboundEnrolmentSchema.parse(PAYLOAD);
    expect(inbound.bonus).toBeUndefined();
    expect(inbound.balanceMinor).toBeUndefined();
  });

  it("refuses money that is negative or not whole minor units", () => {
    expect(inboundEnrolmentSchema.safeParse({ ...PAYLOAD, balanceMinor: -1 }).success).toBe(false);
    expect(inboundEnrolmentSchema.safeParse({ ...PAYLOAD, balanceMinor: 10.5 }).success).toBe(false);
    expect(inboundEnrolmentSchema.safeParse({ ...PAYLOAD, bonus: { given: true, amountMinor: -500 } }).success).toBe(false);
  });

  it("is accepted on an enrolment as finance keeps it", () => {
    const enrolment = {
      course: "A Course", modeOfStudy: "online" as const, language: "English",
      bonus: { given: true, amountMinor: 50000 }, declaredBalanceMinor: 80000,
    };
    const parsed = enrolmentInputSchema.parse(enrolment);
    expect(parsed.bonus).toEqual({ given: true, amountMinor: 50000 });
    expect(parsed.declaredBalanceMinor).toBe(80000);
  });
});
