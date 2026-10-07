import { Types } from "mongoose";
import { EmailLog } from "./email-log.model";

export interface EmailLogQuery {
  page: number;
  pageSize: number;
  search?: string;
  kind?: string;
  state?: string;
  from?: string;
  to?: string;
}

const row = (d: Record<string, unknown> & { _id: unknown }) => ({
  id: String(d._id),
  at: (d.createdAt as Date | undefined)?.toISOString() ?? null,
  kind: d.kind as string,
  to: (d.to as string[]) ?? [],
  subject: (d.subject as string) ?? "",
  state: d.state as string,
  error: (d.error as string) || undefined,
  ref: d.ref && (d.ref as { id?: unknown }).id
    ? { type: (d.ref as { type: string }).type, id: String((d.ref as { id: unknown }).id), label: (d.ref as { label?: string }).label ?? "" }
    : null,
  actorName: (d.actorName as string) || "Automatic",
});

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The organization's email log, newest first: every email finance tried to send. */
export async function listEmailLogs(orgId: string, q: EmailLogQuery) {
  const filter: Record<string, unknown> = { organizationId: new Types.ObjectId(orgId) };
  if (q.kind) filter.kind = q.kind;
  if (q.state) filter.state = q.state;
  if (q.from || q.to) {
    filter.createdAt = {
      ...(q.from ? { $gte: new Date(`${q.from}T00:00:00+04:00`) } : {}),
      ...(q.to ? { $lt: new Date(new Date(`${q.to}T00:00:00+04:00`).getTime() + 86_400_000) } : {}),
    };
  }
  if (q.search?.trim()) {
    const re = new RegExp(escape(q.search.trim()), "i");
    filter.$or = [{ to: re }, { subject: re }, { "ref.label": re }];
  }
  const [docs, total] = await Promise.all([
    EmailLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
    EmailLog.countDocuments(filter),
  ]);
  return {
    rows: docs.map((d) => row(d as never)),
    meta: { page: q.page, pageSize: q.pageSize, total, pageCount: Math.max(1, Math.ceil(total / q.pageSize)) },
  };
}

/** Every email sent about one invoice, newest first. */
export async function invoiceEmails(orgId: string, invoiceId: string) {
  const docs = await EmailLog.find({ organizationId: new Types.ObjectId(orgId), "ref.id": new Types.ObjectId(invoiceId) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(200)
    .lean();
  return docs.map((d) => row(d as never));
}
