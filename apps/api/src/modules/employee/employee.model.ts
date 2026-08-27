import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * A person on the payroll, mirrored from HRMS.
 *
 * Deliberately not a `User`. A finance User carries a password hash and a login;
 * mirroring every employee as one would mint a dormant credential per head and
 * make offboarding a two-place job. Most people on this list will never sign in
 * to finance. `userId` links the minority who do — today the salespeople who
 * own a commission structure — and stays null for everyone else.
 *
 * HRMS owns the facts here; nothing on this record is edited in finance. It
 * exists so that a payroll line, a commission record and a department can all
 * point at the same person by a stable id instead of matching on a name or an
 * email that changes.
 */
const employeeSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    // Provenance. `hrmsOrgId` is carried on the row itself because several HRMS
    // organizations can feed one finance organization — without it, two
    // employees from different HRMS orgs are indistinguishable here.
    hrmsOrgId: { type: String, required: true },
    hrmsEmployeeId: { type: String, required: true },

    employeeCode: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, default: "", lowercase: true, trim: true },

    departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    hrmsDepartmentId: { type: String, default: "" },

    // Set only for people who also hold a finance login (e.g. salespeople with
    // a commission structure). Sparse-unique per org: one login, one person.
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    designation: { type: String, default: "" },
    employmentType: { type: String, default: "full_time" },
    currency: { type: String, default: "AED" },
    joiningDate: { type: Date, default: null },

    /**
     * Finance's own view: can this person be paid right now. Kept separate from
     * `hrmsStatus` so that a leaver still on a final settlement can be inactive
     * here without losing what HRMS actually said.
     */
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    hrmsStatus: { type: String, default: "" },

    /** Mirrored as a bare flag — finance never stores the account details. */
    hasBankDetails: { type: Boolean, default: false },

    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One finance row per HRMS employee, forever.
employeeSchema.index({ hrmsOrgId: 1, hrmsEmployeeId: 1 }, { unique: true });
// Employee codes are unique per HRMS org, not globally — two orgs feeding one
// finance org may both have an "EMP001", and neither is wrong.
employeeSchema.index({ organizationId: 1, hrmsOrgId: 1, employeeCode: 1 }, { unique: true });
// A finance login belongs to at most one employee.
employeeSchema.index(
  { organizationId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: "objectId" } } },
);
employeeSchema.index({ organizationId: 1, departmentId: 1 });
employeeSchema.index({ organizationId: 1, status: 1 });

export type EmployeeDoc = InferSchemaType<typeof employeeSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const Employee = model("Employee", employeeSchema);
