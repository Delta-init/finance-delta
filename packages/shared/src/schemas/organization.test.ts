import { describe, expect, test } from "bun:test";
import {
  formatOrgAddress,
  taxNumberLabel,
  defaultInvoiceTitle,
  updateOrganizationSchema,
} from "./organization.schema";

describe("taxNumberLabel", () => {
  test("names the registration after the system in use", () => {
    expect(taxNumberLabel("gst")).toBe("GSTIN");
    expect(taxNumberLabel("vat")).toBe("TRN");
  });

  test("falls back to something true everywhere", () => {
    expect(taxNumberLabel("sales_tax")).toBe("Tax reg. no.");
    expect(taxNumberLabel(undefined)).toBe("Tax reg. no.");
    expect(taxNumberLabel(null)).toBe("Tax reg. no.");
  });
});

describe("defaultInvoiceTitle", () => {
  test("only a registered seller heads a document TAX INVOICE", () => {
    expect(defaultInvoiceTitle("gst", "29ABCDE1234F1Z5")).toBe("TAX INVOICE");
    expect(defaultInvoiceTitle("vat", "100123456700003")).toBe("TAX INVOICE");
  });

  test("no registration means it is just an invoice", () => {
    expect(defaultInvoiceTitle("gst", "")).toBe("INVOICE");
    expect(defaultInvoiceTitle("gst", undefined)).toBe("INVOICE");
    // Whitespace is not a registration number.
    expect(defaultInvoiceTitle("vat", "   ")).toBe("INVOICE");
  });

  test("an organization that charges no tax cannot issue a tax invoice", () => {
    expect(defaultInvoiceTitle("none", "29ABCDE1234F1Z5")).toBe("INVOICE");
  });
});

describe("formatOrgAddress", () => {
  test("puts city, state and postcode on one line", () => {
    expect(
      formatOrgAddress({
        line1: "2nd Floor, Cyber Tower",
        line2: "Hitech City",
        city: "Kozhikode",
        state: "Kerala",
        postcode: "673001",
        country: "India",
      }),
    ).toEqual([
      "2nd Floor, Cyber Tower",
      "Hitech City",
      "Kozhikode, Kerala, 673001",
      "India",
    ]);
  });

  test("leaves out what has not been filled in rather than printing gaps", () => {
    expect(formatOrgAddress({ line1: "PO Box 12345", country: "UAE" })).toEqual([
      "PO Box 12345",
      "UAE",
    ]);
    expect(formatOrgAddress({ city: "Dubai" })).toEqual(["Dubai"]);
  });

  test("an empty or absent address prints nothing", () => {
    expect(formatOrgAddress({})).toEqual([]);
    expect(formatOrgAddress(undefined)).toEqual([]);
    expect(formatOrgAddress(null)).toEqual([]);
    // Whitespace-only lines are not lines.
    expect(formatOrgAddress({ line1: "  ", city: " " })).toEqual([]);
  });
});

describe("updateOrganizationSchema", () => {
  test("accepts a partial address without blanking the rest", () => {
    const parsed = updateOrganizationSchema.parse({ address: { city: "Dubai" } });
    expect(parsed.address).toEqual({ city: "Dubai" });
  });

  test("rejects an email that is not one, but allows clearing it", () => {
    expect(() => updateOrganizationSchema.parse({ email: "not-an-email" })).toThrow();
    expect(updateOrganizationSchema.parse({ email: "" }).email).toBe("");
  });

  test("keeps the number padding within what a sequence can produce", () => {
    expect(() => updateOrganizationSchema.parse({ invoiceDefaults: { numberPad: 0 } })).toThrow();
    expect(() => updateOrganizationSchema.parse({ invoiceDefaults: { numberPad: 11 } })).toThrow();
    expect(updateOrganizationSchema.parse({ invoiceDefaults: { numberPad: 6 } }).invoiceDefaults)
      .toEqual({ numberPad: 6 });
  });
});
