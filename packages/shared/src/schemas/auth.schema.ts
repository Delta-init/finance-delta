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
  baseCurrency: z.string().optional().default("AED"),
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

/**
 * "I forgot my password".
 *
 * The response never varies, so this schema is the only place an unknown
 * address is treated differently from a known one — and it is not, it just
 * has to be an address.
 */
export const forgotPasswordSchema = z.object({
  email: z.string().email("Enter a valid email"),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/** Spending a one-time link to set a password. */
export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Missing token"),
  // Same floor as creating an account, so a link cannot be used to set a
  // weaker password than the account could have been given in the first place.
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
