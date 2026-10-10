/**
 * One email, one client (the user, 2026-10-10).
 *
 * Finance knows a client by their email: one email is one customer, and a close
 * that arrives with an email already known here is filed under that customer.
 * But a sales CRM can close several different people with one email — four
 * Remote CRM students went in under one address, and all four invoices were
 * filed under the first of them.
 *
 * So whether a close is for the person its email already belongs to is asked
 * here, the way the CRMs ask it before they let a close through: the phone
 * decides where both are known (their last nine digits), the name where one is
 * not (trimmed, ignoring case and spaces).
 *
 * Never a refusal — the sale is real and its invoice has to exist — but a flag
 * on the invoice: accounts check it before approving, and the CRM is told, so
 * the close can be sent back for the client's own email.
 */

type Person = { name?: string; phone?: string };

/** A phone's digits when there are enough of them to be a number; "" — not known — when not. */
function phoneDigits(phone: string | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 7 ? digits : "";
}

/** Whether a phone is known: enough digits to be a number at all. */
export function phoneKnown(phone: string | undefined): boolean {
  return phoneDigits(phone) !== "";
}

/**
 * Whether two phones are one number, by their last nine digits — so a number
 * written with or without its country code, spaces or a leading 0 is the same
 * number (fewer digits when either has fewer). Undefined when either is not
 * known: something else has to decide.
 */
export function samePhone(a: string | undefined, b: string | undefined): boolean | undefined {
  const x = phoneDigits(a);
  const y = phoneDigits(b);
  if (!x || !y) return undefined;
  const n = Math.min(9, x.length, y.length);
  return x.slice(-n) === y.slice(-n);
}

/** Whether two names are one name: trimmed, and ignoring case and spaces. */
export function sameName(a: string | undefined, b: string | undefined): boolean {
  const plain = (s: string | undefined) => (s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return plain(a) === plain(b);
}

/**
 * A close arriving with an email finance already knows: whether it is for
 * somebody other than the client the email belongs to. Only when both differ —
 * the name, and the phone where both are known. The same phone is the same
 * person (a second course is ordinary), and so is the same name under a new
 * number; with a phone not known, the names decide.
 */
export function closeIsForAnother(known: Person, sent: Person): boolean {
  return samePhone(known.phone, sent.phone) !== true && !sameName(known.name, sent.name);
}

/**
 * A correction that keeps the email: whether it is for somebody other than the
 * client the invoice is filed under — whose name and phone must then not be
 * written over. The phone decides where both are known (another number is
 * another person, whatever the name); the name decides where one is not.
 */
export function correctionIsForAnother(current: Person, sent: Person): boolean {
  const phones = samePhone(current.phone, sent.phone);
  return phones === undefined ? !sameName(current.name, sent.name) : !phones;
}

/**
 * The flag: the client the email belongs to, by name and code, and who the
 * close is for — never a phone number, because the CRM shows it to its staff.
 * The same name under another number gets its own words, since "this close is
 * for" the same name would explain nothing.
 */
export function emailBelongsToAnother(known: { name: string; customerCode: string }, sentName: string): string {
  const close = sentName.trim();
  if (sameName(known.name, close)) {
    return `The client's email already belongs to ${known.name} (${known.customerCode}), with another phone number — the number this close was sent with was not saved over theirs. Check before approving: if it is the same person, correct their phone on the customer; if not, send it back for the client's own email.`;
  }
  return `The client's email already belongs to ${known.name} (${known.customerCode}) — this close is for ${close}. It was filed under ${known.name}; check before approving, and send it back for the client's own email.`;
}
