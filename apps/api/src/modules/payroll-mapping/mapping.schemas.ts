import { z } from "zod";

/**
 * Kept local to the module rather than in `@delta/shared`. Nothing in the web
 * app consumes these yet, and a shared schema that only one side uses is a
 * migration cost with no reader. Move them across when the mapping screen
 * needs the types.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Must be a valid id");

export const createOrgLinkSchema = z.object({
  hrmsOrgId: objectId,
});

export const syncDecisionSchema = z.object({
  kind: z.enum(["department", "employee"]),
  hrmsId: objectId,
  action: z.enum(["link", "create", "import_only", "deactivate", "skip"]),
  targetDepartmentId: objectId.optional(),
  targetUserId: objectId.optional(),
});

export const applySyncSchema = z.object({
  hrmsOrgId: objectId,
  // Bounded because this is one request doing many writes with no transaction
  // to unwind it; a roster larger than this should be applied in pages.
  decisions: z.array(syncDecisionSchema).min(1).max(1000),
});

export const syncPreviewQuerySchema = z.object({
  hrmsOrgId: objectId,
});

export const employeeQuerySchema = z.object({
  hrmsOrgId: objectId.optional(),
  status: z.enum(["active", "inactive"]).optional(),
  role: z.enum(["salesperson", "no_commission_rate"]).optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
