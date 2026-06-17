import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { createConnection } from "net";
import { logger } from "../lib/logger";
import { Expense } from "../modules/expense/expense.model";
import { nextNumber } from "../modules/sequence/sequence.service";
import { env } from "../config/env";

const QUEUE_NAME = "recurring-expenses";
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

function addFrequency(date: Date, freq: "weekly" | "monthly" | "quarterly" | "yearly"): Date {
  const d = new Date(date);
  if (freq === "weekly") d.setDate(d.getDate() + 7);
  else if (freq === "monthly") d.setMonth(d.getMonth() + 1);
  else if (freq === "quarterly") d.setMonth(d.getMonth() + 3);
  else d.setFullYear(d.getFullYear() + 1);
  return d;
}

async function processRecurring() {
  const now = new Date();
  const due = await Expense.find({
    isRecurring: true,
    status: { $in: ["approved", "draft"] },
    "recurrence.nextDate": { $lte: now },
  });

  for (const template of due) {
    const d = template as unknown as Record<string, unknown>;
    const rec = d.recurrence as {
      frequency: "weekly" | "monthly" | "quarterly" | "yearly";
      nextDate: Date;
      endDate?: Date;
    };
    if (!rec) continue;

    const orgId = template.organizationId.toString();
    const nextDate = addFrequency(rec.nextDate, rec.frequency);
    const expired = rec.endDate && nextDate > rec.endDate;

    try {
      const expenseNumber = await nextNumber(orgId, "expense", "EXP-");

      await Expense.create({
        organizationId: template.organizationId,
        expenseNumber,
        category: template.category,
        description: template.description,
        expenseDate: now,
        amountMinor: template.amountMinor,
        taxPct: template.taxPct,
        taxMinor: template.taxMinor,
        totalMinor: template.totalMinor,
        currency: template.currency,
        paymentAccount: d.paymentAccount,
        paymentMethod: d.paymentMethod,
        reference: d.reference,
        submittedById: template.submittedById,
        submittedByName: template.submittedByName,
        status: "draft",
        isRecurring: false,
        parentExpenseId: template._id,
        mileage: d.mileage,
        attachments: d.attachments ?? [],
        projectName: d.projectName ?? "",
        costCentre: d.costCentre ?? "",
        notes: template.notes,
      });

      await Expense.findByIdAndUpdate(template._id, {
        $set: {
          "recurrence.nextDate": nextDate,
          ...(expired ? { isRecurring: false } : {}),
        },
      });

      logger.info({ expenseNumber, orgId }, "Recurring expense generated");
    } catch (err) {
      logger.error({ err, templateId: template._id }, "Failed to generate recurring expense");
    }
  }
}

let recurringQueue: Queue | null = null;

export async function startRecurringExpenseWorker(): Promise<void> {
  if (!(await redisIsAvailable())) {
    logger.warn("Recurring expense worker disabled — Redis unavailable");
    return;
  }

  recurringQueue = new Queue(QUEUE_NAME, { connection });

  await recurringQueue.add("check", {}, {
    repeat: { pattern: "30 1 * * *" },
    jobId: "daily-recurring-expense-check",
  });

  const worker = new Worker(QUEUE_NAME, processRecurring, { connection });
  worker.on("failed", (_job, err) => logger.error({ err }, "Recurring expense worker job failed"));
  worker.on("error", (err) => logger.warn({ err }, "Recurring expense worker connection issue"));

  logger.info("Recurring expense worker started");
}

export function getRecurringExpenseQueue(): Queue | null { return recurringQueue; }
