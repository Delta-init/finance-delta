/**
 * Mail through one kept-open SMTP connection, and the emails the server refuses for now sent again (2026-11-18:
 * Gmail's "454 4.7.0 Too many login attempts") — against a stand-in SMTP server in this process and a scratch
 * database:
 *   1. many emails, one sign-in;
 *   2. a "454 … try again later": logged "Trying again", kept in the outbox (with the message), not due before its time;
 *   3. still refused at the next try: waits for the one after; let in: sent, the log says sent at the later try, the
 *      outbox empty — and an invoice's own "emailed" follows;
 *   4. a 550 (no such address): failed at once, nothing kept;
 *   5. still refused after three more tries: failed, nothing kept;
 *   6. which errors pass and which do not.
 * Run through scripts/mail-retry-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

/* ── The stand-in SMTP server ── */
const stub = { logins: 0, messages: 0, lockout: false, refuse: new Set<string>(), sockets: new Set<any>() };
const server = Bun.listen<{ buf: string; data: boolean; to: string[] }>({
  hostname: "127.0.0.1", port: 0,
  socket: {
    open(s) { s.data = { buf: "", data: false, to: [] }; stub.sockets.add(s); s.write("220 stub ESMTP\r\n"); },
    close(s) { stub.sockets.delete(s); },
    data(s, chunk) {
      s.data.buf += chunk.toString();
      let i: number;
      while ((i = s.data.buf.indexOf("\r\n")) >= 0) {
        const line = s.data.buf.slice(0, i);
        s.data.buf = s.data.buf.slice(i + 2);
        if (s.data.data) {
          if (line === ".") { s.data.data = false; stub.messages++; s.write(`250 2.0.0 OK id-${stub.messages}\r\n`); }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") s.write("250-stub\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (cmd === "AUTH") {
          stub.logins++;
          s.write(stub.lockout ? "454-4.7.0 Too many login attempts, please try again later. For more information,\r\n454 4.7.0 go to https://support.google.com/a/answer/6140680#tempauth - gsmtp\r\n" : "235 2.7.0 Accepted\r\n");
        } else if (cmd === "MAIL") { s.data.to = []; s.write("250 2.1.0 OK\r\n"); }
        else if (cmd === "RCPT") {
          const addr = (line.match(/<([^>]+)>/)?.[1] ?? "").toLowerCase();
          if (stub.refuse.has(addr)) s.write("550 5.1.1 The email account that you tried to reach does not exist\r\n");
          else { s.data.to.push(addr); s.write("250 2.1.5 OK\r\n"); }
        } else if (cmd === "DATA") { s.data.data = true; s.write("354 Go ahead\r\n"); }
        else if (cmd === "RSET" || cmd === "NOOP") s.write("250 2.0.0 OK\r\n");
        else if (cmd === "QUIT") { s.write("221 2.0.0 Bye\r\n"); s.end(); }
        else s.write("502 5.5.1 Unrecognized command\r\n");
      }
    },
  },
});
Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(server.port), SMTP_USER: "mailer@e2e.local", SMTP_PASS: "x", SMTP_SECURE: "false", RESEND_API_KEY: "" });
const dropConnections = async () => { for (const s of [...stub.sockets]) s.end(); await Bun.sleep(300); };

const mail = await import("../lib/email");
const { EmailLog } = await import("../modules/email-log/email-log.model");
const { MailOutbox } = await import("../modules/email-log/mail-outbox.model");
const { Invoice } = await import("../modules/invoice/invoice.model");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const ORG = new Types.ObjectId();
const notice = (to: string, subject: string, log: Record<string, unknown> = {}) =>
  mail.sendNotice({ to: [to], subject, title: subject, lines: ["A line"], log: { organizationId: ORG, kind: "notice", ...log } as never });
const logOf = (subject: string) => EmailLog.findOne({ subject }).lean<any>();
const MIN = 60_000;

step("1. One connection kept open");
for (let k = 1; k <= 5; k++) await notice(`staff${k}@e2e.local`, `Notice ${k}`);
check("five emails, one sign-in", stub.messages === 5 && stub.logins === 1, j({ messages: stub.messages, logins: stub.logins }));
check("…each logged as sent", (await EmailLog.countDocuments({ state: "sent" })) === 5);

step("2. Refused for now");
stub.lockout = true;
await dropConnections();
const r = await notice("client@e2e.local", "Your receipt");
const l1 = await logOf("Your receipt");
const box = await MailOutbox.findOne({ logId: l1?._id }).lean<any>();
check("Gmail's 454: logged \"Trying again\", with what the server said", r.sent === 0 && l1?.state === "retrying" && /454.*Too many login attempts/.test(l1?.error ?? ""), j({ r, l1 }));
check("…kept in the outbox with the message, due in 15 minutes", !!box && /A line/.test(box.html) && box.attempts === 1
  && Math.abs(new Date(box.nextAt).getTime() - (Date.now() + 15 * MIN)) < MIN, j(box && { a: box.attempts, n: box.nextAt }));
check("not tried before its time", (await mail.retryQueuedEmails(new Date())).sent === 0 && (await MailOutbox.countDocuments()) === 1);

step("3. Tried again");
await dropConnections();
let pass = await mail.retryQueuedEmails(new Date(Date.now() + 16 * MIN));
const box2 = await MailOutbox.findOne({ logId: l1?._id }).lean<any>();
check("still refused at 15 minutes: waits 30 more", pass.waiting === 1 && box2?.attempts === 2 && new Date(box2.nextAt).getTime() > Date.now() + 40 * MIN && (await logOf("Your receipt"))?.state === "retrying", j({ pass, box2 }));
stub.lockout = false;
await dropConnections();
const before = stub.messages;
pass = await mail.retryQueuedEmails(new Date(Date.now() + 50 * MIN));
const l2 = await logOf("Your receipt");
check("let in: sent — the log says so, at the third try, with the message id; nothing left waiting",
  pass.sent === 1 && stub.messages === before + 1 && l2?.state === "sent" && l2?.retries === 2 && l2?.error === "" && /^<.+@.+>$/.test(l2?.messageId ?? "") && (await MailOutbox.countDocuments()) === 0, j({ pass, l2 }));

// An invoice's own record of being emailed follows a message sent at a later try.
const INV = new Types.ObjectId();
await mongoose.connection.db!.collection("invoices").insertOne({ _id: INV, organizationId: ORG, invoiceNumber: "IN-00001", emailDelivery: { state: "failed", at: new Date(), messageId: "", error: "454" } });
stub.lockout = true;
await dropConnections();
await notice("client2@e2e.local", "Invoice IN-00001", { kind: "invoice", ref: { type: "invoice", id: INV, label: "IN-00001" } });
stub.lockout = false;
await dropConnections();
await mail.retryQueuedEmails(new Date(Date.now() + 16 * MIN));
const inv = await Invoice.findById(INV).lean<any>();
check("an invoice sent at the second try: its own record says emailed", inv?.emailDelivery?.state === "sent" && /^<.+@.+>$/.test(inv?.emailDelivery?.messageId ?? ""), j(inv?.emailDelivery));

step("4. Refused for good");
stub.refuse.add("nobody@e2e.local");
await notice("nobody@e2e.local", "To nobody");
const l3 = await logOf("To nobody");
check("a 550 (no such address): failed at once, nothing kept to try again", l3?.state === "failed" && (await MailOutbox.countDocuments()) === 0, j(l3));

step("5. Given up after three more tries");
stub.lockout = true;
await dropConnections();
await notice("client3@e2e.local", "Never let in");
for (const m of [16, 47, 93]) { await dropConnections(); await mail.retryQueuedEmails(new Date(Date.now() + m * MIN)); }
const l4 = await logOf("Never let in");
check("still refused at 15, 30 and 45 minutes on: failed, with why, three retries, nothing kept",
  l4?.state === "failed" && l4?.retries === 3 && /454/.test(l4?.error ?? "") && (await MailOutbox.countDocuments()) === 0, j(l4));
stub.lockout = false;

step("6. Which errors pass");
const t = mail.isTemporaryMailError;
check("Gmail's 454 4.7.0, a 421, a timeout, a dropped connection: try again",
  t("Invalid login: 454-4.7.0 Too many login attempts, please try again later.") && t("421 4.7.0 Try again later, closing connection.") && t("Connection timeout") && t("ETIMEDOUT") && t("Connection closed unexpectedly"));
check("a wrong password (535 5.7.8), a 550, no address, emails off: not", !t("Invalid login: 535-5.7.8 Username and Password not accepted.") && !t("550 5.1.1 does not exist")
  && !t("no_recipients") && !t("opted_out") && !t("not_configured") && !t(""));

await mongoose.disconnect();
server.stop(true);
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
