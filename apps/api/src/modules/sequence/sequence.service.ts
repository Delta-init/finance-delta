import { Types } from "mongoose";
import { Sequence } from "./sequence.model";

/**
 * Atomically allocate the next human-readable number for a resource, scoped to
 * an organization. Returns e.g. "QT-00001". Uses findOneAndUpdate($inc) so
 * concurrent callers never collide.
 */
export async function nextNumber(
  orgId: string,
  key: string,
  prefix: string,
  pad = 5,
): Promise<string> {
  const doc = await Sequence.findOneAndUpdate(
    { organizationId: new Types.ObjectId(orgId), key },
    { $inc: { next: 1 }, $setOnInsert: { prefix } },
    { upsert: true, new: true },
  );
  const value = doc.next; // value after increment
  return `${prefix}${String(value).padStart(pad, "0")}`;
}
