import { z } from "zod";
import { tagRefSchema } from "./tag.schema";
import { departmentRefSchema } from "./department.schema";

const addressSchema = z.object({
  street: z.string().max(200).optional().default(""),
  city: z.string().max(100).optional().default(""),
  state: z.string().max(100).optional().default(""),
  zip: z.string().max(20).optional().default(""),
  country: z.string().max(100).optional().default(""),
});
export type CustomerAddress = z.infer<typeof addressSchema>;

export const createCustomerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(120),
  email: z.string().email("Enter a valid email"),
  phone: z.string().min(3, "Phone is required").max(40),
  companyName: z.string().max(160).optional().default(""),
  currency: z.string().min(3).max(3).optional(),
  vatNumber: z.string().max(50).optional().default(""),
  discountPct: z.number().min(0).max(100).optional().default(0),
  departmentId: z.string().optional(),
  billingAddress: addressSchema.optional().default({}),
  shippingAddress: addressSchema.optional().default({}),
  tagIds: z.array(z.string()).optional().default([]),
  /**
   * Whether finance emails this client — invoices, tax invoices, receipts, reminders (the user, 2026-11-16). On unless
   * somebody turns it off; staff emails about the client are not affected.
   */
  receivesEmails: z.boolean().optional(),
  /** Why emails were turned off, when they are — kept with who and when. */
  emailsOffReason: z.string().max(300).optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = createCustomerSchema.partial().extend({
  status: z.enum(["active", "archived"]).optional(),
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const customerSchema = z.object({
  id: z.string(),
  customerCode: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  companyName: z.string(),
  currency: z.string(),
  vatNumber: z.string(),
  discountPct: z.number(),
  department: departmentRefSchema.nullable().optional(),
  billingAddress: addressSchema,
  shippingAddress: addressSchema,
  status: z.enum(["active", "archived"]),
  tags: z.array(tagRefSchema).default([]),
  /** Finance emails this client (2026-11-16). Off: none of its emails reach them — see emailsOff for who and why. */
  receivesEmails: z.boolean().default(true),
  emailsOff: z.object({ at: z.string(), byName: z.string(), reason: z.string() }).nullable().optional(),
  createdAt: z.string(),
});
export type Customer = z.infer<typeof customerSchema>;
