import { z } from "zod";

export const createDepartmentSchema = z.object({
  name: z.string().min(1, "Name is required").max(80),
  description: z.string().max(300).optional().default(""),
});
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;

export const updateDepartmentSchema = createDepartmentSchema.partial();
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;

export const departmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
});
export type Department = z.infer<typeof departmentSchema>;

/** Lightweight department reference embedded in user/customer DTOs. */
export const departmentRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type DepartmentRef = z.infer<typeof departmentRefSchema>;
