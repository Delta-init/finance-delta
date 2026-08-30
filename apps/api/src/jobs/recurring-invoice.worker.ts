import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { createConnection } from "net";
import { logger } from "../lib/logger";
import { Invoice } from "../modules/invoice/invoice.model";
import { nextNumber } from "../modules/sequence/sequence.service";
import { invoiceNumberingFor } from "../modules/organization/organization.service";
import { env } from "../config/env";

const QUEUE_NAME = "recurring-invoices";
const connection: ConnectionOptions = { url: env.REDIS_URL };

function redisIsAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(env.REDIS_URL.startsWith("redis://") ? env.REDIS_URL : `redis://${env.REDIS_URL}`);
    const sock = createConnection({ host: url.hostname, port: Number(url.port) || 6379 });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(2000, () => done(false));
  });
}

function addFrequency(date: Date, freq: "weekly" | "monthly" | "annually"): Date {
  const d = new Date(date);
  if (freq === "weekly") d.setDate(d.getDate() + 7);
  else if (freq === "monthly") d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return d;
}

async function processRecurring() {
  const now = new Date();
  const due = await Invoice.find({
    "recurring.isActive": true,
    "recurring.nextRunAt": { $lte: now },
  });

  for (const template of due) {
    const rec = template.recurring as {
      frequency: "weekly" | "monthly" | "annually";
      nextRunAt: Date;
      endDate?: Date;
      isActive: boolean;
    };
    if (!rec) continue;

    const orgId = template.organizationId.toString();
    const nextRun = addFrequency(rec.nextRunAt, rec.frequency);
    const expired = rec.endDate && nextRun > rec.endDate;

    try {
      const numbering = await invoiceNumberingFor(orgId);
      const invoiceNumber = await nextNumber(orgId, "invoice", numbering.prefix, numbering.pad);
      const dueDate = addFrequency(now, rec.frequency);

      await Invoice.create({
        organizationId: template.organizationId,
        invoiceNumber,
        customerId: template.customerId,
        customerName: template.customerName,
        salespersonId: template.salespersonId,
        salespersonName: template.salespersonName,
        reference: template.reference,
        status: "draft",
        issueDate: now,
        dueDate,
        currency: template.currency,
        lineItems: template.lineItems,
        subtotalMinor: template.subtotalMinor,
        discountTotalMinor: template.discountTotalMinor,
        taxBreakdown: template.taxBreakdown,
        taxTotalMinor: template.taxTotalMinor,
        totalMinor: template.totalMinor,
        balanceMinor: template.totalMinor,
        notes: template.notes,
        terms: template.terms,
        tagIds: template.tagIds,
        branding: template.branding,
      });

      await Invoice.findByIdAndUpdate(template._id, {
        $set: { "recurring.nextRunAt": nextRun, "recurring.isActive": !expired },
      });

      logger.info({ invoiceNumber, orgId }, "Recurring invoice generated");
    } catch (err) {
      logger.error({ err, templateId: template._id }, "Failed to generate recurring invoice");
    }
  }
}

let recurringQueue: Queue | null = null;

export async function startRecurringWorker(): Promise<void> {
  if (!(await redisIsAvailable())) {
    logger.warn("Recurring invoice worker disabled — Redis unavailable");
    return;
  }

  recurringQueue = new Queue(QUEUE_NAME, { connection });

  await recurringQueue.add("check", {}, {
    repeat: { pattern: "0 1 * * *" },
    jobId: "daily-recurring-check",
  });

  const worker = new Worker(QUEUE_NAME, processRecurring, { connection });
  worker.on("failed", (_job, err) => logger.error({ err }, "Recurring worker job failed"));
  worker.on("error", (err) => logger.warn({ err }, "Recurring worker connection issue"));

  logger.info("Recurring invoice worker started");
}

export function getRecurringQueue(): Queue | null { return recurringQueue; }
