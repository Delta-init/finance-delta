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
  createdAt: z.string(),
});
export type Customer = z.infer<typeof customerSchema>;
