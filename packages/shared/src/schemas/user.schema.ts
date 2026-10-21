import { z } from "zod";
import { tagRefSchema } from "./tag.schema";
import { departmentRefSchema } from "./department.schema";

export const createUserSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(80),
  email: z.string().email("Enter a valid email"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
  roleId: z.string().min(1, "Select a role"),
  departmentId: z.string().optional(),
  tagIds: z.array(z.string()).optional().default([]),
  /** Tagged Manager in this organization: decides late entries (2026-10-17). */
  isManager: z.boolean().optional().default(false),
  /**
   * Platform-wide access: every organization, every permission. Not a role —
   * the person still holds one here, and the flag sits above it. Only an
   * existing super admin may set this; the server refuses anybody else, so an
   * organization administrator cannot promote themselves out of their own
   * organization.
   */
  isSuperAdmin: z.boolean().optional().default(false),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  /** Their sign-in email (2026-10-20): refused when another account already has it. */
  email: z.string().email("Enter a valid email").max(160).optional(),
  /** A new password, set by an administrator (2026-10-20). */
  password: z.string().min(8, "Password must be at least 8 characters").max(128).optional(),
  roleId: z.string().min(1).optional(),
  departmentId: z.string().nullable().optional(),
  status: z.enum(["active", "suspended"]).optional(),
  tagIds: z.array(z.string()).optional(),
  isManager: z.boolean().optional(),
  /** Granted and taken away only by somebody who already holds it. */
  isSuperAdmin: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

/* Salespeople on the Users page (2026-10-20): payroll-only accounts given a real role, and CRM salespeople given one. */
export const convertSalespersonSchema = z.object({
  roleId: z.string().min(1, "Select a role"),
  departmentId: z.string().nullable().optional(),
  isManager: z.boolean().optional(),
  password: z.string().min(8, "Password must be at least 8 characters").max(128).optional(),
  sendInvite: z.boolean().optional().default(false),
}).refine((v) => v.sendInvite || !!v.password, { message: "Send an invite or set a password — otherwise they still can't sign in", path: ["password"] });
export type ConvertSalespersonInput = z.infer<typeof convertSalespersonSchema>;

export const createCrmSalespersonSchema = z.object({
  email: z.string().email("Enter a valid email"),
  name: z.string().min(2, "Name must be at least 2 characters").max(80),
  roleId: z.string().min(1, "Select a role"),
  departmentId: z.string().nullable().optional(),
  isManager: z.boolean().optional(),
  password: z.string().min(8, "Password must be at least 8 characters").max(128).optional(),
  sendInvite: z.boolean().optional().default(false),
  moveInvoices: z.boolean().optional().default(true),
});
export type CreateCrmSalespersonInput = z.infer<typeof createCrmSalespersonSchema>;

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  status: z.enum(["active", "suspended"]),
  role: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  isSuperAdmin: z.boolean().optional().default(false),
  department: departmentRefSchema.nullable().optional(),
  /**
   * Their department on their payroll employee record (from HRMS), in the list only (2026-10-22) — what an expense
   * entered for them takes when their user has none of its own.
   */
  employeeDepartment: departmentRefSchema.nullable().optional(),
  tags: z.array(tagRefSchema).default([]),
  /** Tagged Manager in this organization: decides late entries. */
  isManager: z.boolean().optional().default(false),
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;
