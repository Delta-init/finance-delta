import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { BankAccount } from "./bank-account.model";

/**
 * A payment typed in someone's own hands goes into an account (the user, 2026-11-11: "If we create or mapped record
 * payment that comes in Bank"): "Not in a bank account" ("") is refused while the organization has an open account —
 * otherwise the money was recorded and never showed in Banking. Not given at all, the payment method's account is
 * used as before; payments other systems record (CS Portal, the CRMs) are not asked.
 */
export async function assertAccountChosen(orgId: string, bankAccountId: unknown): Promise<void> {
  if (bankAccountId !== "") return;
  const any = await BankAccount.exists({ organizationId: new Types.ObjectId(orgId), isActive: { $ne: false } });
  if (any) throw new AppError("VALIDATION_ERROR", "Choose the account the money went into or came out of — every payment shows in Banking");
}
