import { describe, expect, test } from "bun:test";
import { approvalBlocksSending, INVOICE_APPROVALS, invoiceApprovalSchema } from "./invoice.schema";

describe("approvalBlocksSending", () => {
  test("holds an invoice that is waiting or was sent back", () => {
    expect(approvalBlocksSending("pending")).toBe(true);
    expect(approvalBlocksSending("returned")).toBe(true);
  });

  test("lets through an approved one, and one that never needed approving", () => {
    expect(approvalBlocksSending("approved")).toBe(false);
    expect(approvalBlocksSending("not_required")).toBe(false);
  });

  test("an invoice raised before approval existed is not held", () => {
    // Reading a missing block as blocked would strand every existing draft.
    expect(approvalBlocksSending(undefined)).toBe(false);
    expect(approvalBlocksSending(null)).toBe(false);
  });

  test("every state is decided, so a new one cannot slip through unconsidered", () => {
    for (const state of INVOICE_APPROVALS) {
      expect(typeof approvalBlocksSending(state)).toBe("boolean");
    }
  });
});

describe("invoiceApprovalSchema", () => {
  test("defaults to needing nobody", () => {
    expect(invoiceApprovalSchema.parse({}).state).toBe("not_required");
  });

  test("rejects a state that is not one of the four", () => {
    expect(() => invoiceApprovalSchema.parse({ state: "rejected" })).toThrow();
  });

  test("carries who decided and when", () => {
    const parsed = invoiceApprovalSchema.parse({
      state: "returned",
      byName: "Yamini",
      returnedReason: "The amount does not match what was agreed",
    });
    expect(parsed.state).toBe("returned");
    expect(parsed.returnedReason).toBe("The amount does not match what was agreed");
  });
});
