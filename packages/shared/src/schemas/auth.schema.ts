import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

/** Shape returned to the client on a successful auth. */
export const authUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  organizationId: z.string(),
  orgName: z.string().optional(),
  roleKey: z.string(),
  roleName: z.string(),
  permissions: z.array(z.string()),
  isSuperAdmin: z.boolean().optional().default(false),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/** Minimal org info returned in the org-picker step. */
export const orgChoiceItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseCurrency: z.string(),
});
export type OrgChoiceItem = z.infer<typeof orgChoiceItemSchema>;

/** Returned when a user belongs to multiple orgs and must pick one. */
export const orgChoiceResultSchema = z.object({
  status: z.literal("choose_org"),
  orgs: z.array(orgChoiceItemSchema),
  pendingToken: z.string(),
});
export type OrgChoiceResult = z.infer<typeof orgChoiceResultSchema>;

/** Normal successful auth result. */
export const authSuccessSchema = z.object({
  user: authUserSchema,
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type AuthSuccess = z.infer<typeof authSuccessSchema>;

export const authResultSchema = z.union([authSuccessSchema, orgChoiceResultSchema]);
export type AuthResult = z.infer<typeof authResultSchema>;

export const switchOrgSchema = z.object({
  organizationId: z.string().min(1, "Organization is required"),
});
export type SwitchOrgInput = z.infer<typeof switchOrgSchema>;

/** Platform-level org creation by super admin or org admin. */
export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(100),
  legalName: z.string().max(200).optional(),
  baseCurrency: z.string().min(3).max(3).default("AED"),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

/** Invite an existing user to an org, or create & invite. */
export const inviteMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  roleId: z.string().min(1),
  password: z.string().min(6).optional(),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
