import { describe, expect, test } from "bun:test";
import { closeIsForAnother, correctionIsForAnother, emailBelongsToAnother, phoneKnown, samePhone, sameName } from "./client-identity";

describe("one email, one client — who is the same person", () => {
  test("phones: the last nine digits, however the number is written", () => {
    expect(samePhone("+971 50 111 2233", "0501112233")).toBe(true);
    expect(samePhone("+971501112233", "00971-50-111-2233")).toBe(true);
    expect(samePhone("+91 98765 43210", "9876543210")).toBe(true);
    expect(samePhone("+971501112233", "+971559998877")).toBe(false);
    // A short local number against the full one: the digits both have.
    expect(samePhone("+974 3312 3456", "33123456")).toBe(true);
  });

  test("a phone with too few digits to be a number is not known", () => {
    expect(phoneKnown("n/a")).toBe(false);
    expect(phoneKnown("0")).toBe(false);
    expect(phoneKnown("123456")).toBe(false);
    expect(phoneKnown("+971501112233")).toBe(true);
    expect(samePhone("n/a", "+971501112233")).toBeUndefined();
    expect(samePhone("+971501112233", "")).toBeUndefined();
  });

  test("names: trimmed, ignoring case and spaces", () => {
    expect(sameName("  Najad Ahmed ", "najad  ahmed")).toBe(true);
    expect(sameName("NAJAD AHMED", "najadahmed")).toBe(true);
    expect(sameName("najad ahmed", "Halif")).toBe(false);
  });

  test("at the close: somebody else only when the name and the phone both differ", () => {
    const najad = { name: "najad ahmed", phone: "+971501112233" };
    expect(closeIsForAnother(najad, { name: "Halif", phone: "+971559998877" })).toBe(true);
    // The same number under another spelling: the same person, a second course.
    expect(closeIsForAnother(najad, { name: "Najad Ahamed", phone: "0501112233" })).toBe(false);
    // The same name under a new number: the same person too.
    expect(closeIsForAnother(najad, { name: "Najad Ahmed", phone: "+971520000001" })).toBe(false);
    // A phone not known: the names decide.
    expect(closeIsForAnother({ name: "Mohammed Lebbie", phone: "n/a" }, { name: "mohammed lebbie", phone: "+971561234567" })).toBe(false);
    expect(closeIsForAnother({ name: "Mohammed Lebbie", phone: "n/a" }, { name: "yfscghs", phone: "+971561234567" })).toBe(true);
  });

  test("on a correction keeping the email: the phone decides, the name when a phone is not known", () => {
    const najad = { name: "najad ahmed", phone: "+971501112233" };
    expect(correctionIsForAnother(najad, { name: "Halif", phone: "+971559998877" })).toBe(true);
    expect(correctionIsForAnother(najad, { name: "Najad Ahmed", phone: "+971559998877" })).toBe(true);
    // A spelling fix on the same number is the same person.
    expect(correctionIsForAnother(najad, { name: "Najaad Ahmed", phone: "050 111 2233" })).toBe(false);
    expect(correctionIsForAnother({ name: "Priya Nair", phone: "n/a" }, { name: "PRIYA NAIR", phone: "+971501110005" })).toBe(false);
    expect(correctionIsForAnother({ name: "Priya Nair", phone: "+971501110005" }, { name: "Someone Else", phone: "n/a" })).toBe(true);
  });

  test("the flag names the client the email belongs to, their code and the close's name — never a number", () => {
    const flag = emailBelongsToAnother({ name: "najad ahmed", customerCode: "CUST-00066" }, " Halif ");
    expect(flag).toBe(
      "The client's email already belongs to najad ahmed (CUST-00066) — this close is for Halif. It was filed under najad ahmed; check before approving, and send it back for the client's own email.",
    );
    const sameNameFlag = emailBelongsToAnother({ name: "Sara Khan", customerCode: "CUST-00007" }, "sara khan");
    expect(sameNameFlag).toContain("already belongs to Sara Khan (CUST-00007), with another phone number");
    expect(/\d{7,}/.test(flag + sameNameFlag)).toBe(false);
  });
});
