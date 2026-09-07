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
      course: inbound.course.name,
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
