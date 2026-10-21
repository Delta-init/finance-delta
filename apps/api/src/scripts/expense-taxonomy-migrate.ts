/**
 * Every organization's expense categories moved onto the taxonomy (the user, 2026-10-21: "we need to remove current all
 * categorys and we need backfill the category and subcategory").
 *
 *   1. The 17 categories with their subcategories (packages/shared expense-taxonomy.ts) added where missing; one of the
 *      same slug made by hand and never given subcategories takes the taxonomy's name and subcategories.
 *   2. Each expense (voided ones too, so no old slug is left) not already filed under one of them with a subcategory:
 *        - by where it came from: an HRMS salary advance → Employee Advances Receivable › Salary Advances; an HRMS
 *          one-time payment → Payroll & Employee Benefits › Bonuses; a payroll run → … › Basic Salary; a CRM commission
 *          payout → Sales Commission › Sales Commission (Team Leader Commission when it was only a team leader's);
 *        - else by words in its old category name, description and notes (RULES below, first match wins);
 *        - else by its old category where that leaves no doubt (Salaries & Wages, Commissions, Rent, Utilities);
 *        - else Other / Unclassified › Pending Classification, to be filed by hand.
 *      Its old category is kept on it (legacyCategory) and shown on the expense.
 *   3. The old categories, now unused, removed.
 *
 * Old means not in the taxonomy and without subcategories: one made since (it must have subcategories) is left alone,
 * with its expenses.
 *
 * Reads and prints only, unless --write. Run it from apps/api on the server (Bun reads MONGODB_URI from the .env), after
 * the API with this change is deployed:
 *
 *   bun src/scripts/expense-taxonomy-migrate.ts                       # what it would do, every organization
 *   bun src/scripts/expense-taxonomy-migrate.ts --org <id>            # one organization
 *   … --write --expect <N>                                            # do it, N as the dry run counted
 *   bun src/scripts/expense-taxonomy-migrate.ts --undo backups/expense-taxonomy-<time>.json [--write]
 *
 * Before writing, what it changes is saved to backups/expense-taxonomy-<time>.json beside apps/api, and --undo puts it
 * back. Safe to run again: what is already filed is left alone.
 */
import fs from "node:fs";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { EXPENSE_DEFAULTS, EXPENSE_TAXONOMY, categoryLabel } from "@delta/shared";
import { Organization } from "../modules/organization/organization.model";
import { Expense } from "../modules/expense/expense.model";
import { ExpenseCategory } from "../modules/expense-category/expense-category.model";
import { CrmCommissionPayout } from "../modules/crm-commission/crm-commission-payout.model";
import { PayrollRun } from "../modules/payroll/payroll-run.model";

type Target = readonly [category: string, subcategory: string];
interface Rule { to: Target; re: RegExp; only?: string[] }

const PENDING: Target = [EXPENSE_DEFAULTS.unclassified.category, EXPENSE_DEFAULTS.unclassified.subcategory];

/**
 * Words → where it goes, tried in order on "<old category name> <description> <notes>", lower-cased. More particular
 * ones first: a salary advance before salary, a team leader's commission before commission, food delivery before a
 * taxi, a bill for water before drinking water. `only`: just for expenses whose old category was one of these.
 */
const RULES: Rule[] = [
  // Not expenses in the P&L — money staff owe back, loans, VAT.
  { to: ["employee_advances", "emergency_advances"], re: /emergency advance/ },
  { to: ["employee_advances", "salary_advances"], re: /salary advance|advance (against |of |on )?salary|advance salary/ },
  { to: ["employee_advances", "other_staff_advances"], re: /\b(staff|employee) advance|\bloan to (staff|employee)/ },
  { to: ["loan_financing", "loan_principal"], re: /\bloan (repayment|principal|instal?ment)|\bemi\b/ },
  { to: ["loan_financing", "financing_fees"], re: /financing fee|loan (processing |arrangement )?fee|arrangement fee/ },
  { to: ["loan_financing", "interest_expense"], re: /\binterest\b/ },
  { to: ["vat_control", "vat_settlement"], re: /\bvat (payment|return|settlement|paid|payable)|federal tax authority|\bfta\b/ },
  // Commission before anything a commission's description names (a CRM).
  { to: ["sales_commission", "team_leader_commission"], re: /team ?lead(er)?'?s? commission|\btl commission/ },
  { to: ["sales_commission", "mentor_commission"], re: /mentor'?s? (commission|fee|payment)|trainer'?s? commission/ },
  { to: ["sales_commission", "sales_incentives"], re: /\bincentives?\b|\bspiff|sales contest|sales bonus/ },
  { to: ["sales_commission", "sales_commission"], re: /\bcommissions?\b/ },
  // Payroll.
  { to: ["payroll_benefits", "employer_benefits"], re: /gratuity|end of service|\beosb?\b|pension|leave salary/ },
  { to: ["payroll_benefits", "basic_salary"], re: /\bsalar(y|ies)\b|\bwages?\b|\bpayroll\b/ },
  { to: ["payroll_benefits", "overtime"], re: /\bover ?time\b/ },
  { to: ["payroll_benefits", "allowances"], re: /\ballowances?\b/ },
  { to: ["payroll_benefits", "bonuses"], re: /\bbonus(es)?\b/, only: ["salaries_wages", "salaries-wages", "other"] },
  // Visa and compliance.
  { to: ["staff_visa_compliance", "medical_insurance"], re: /medical insurance|health insurance/ },
  { to: ["staff_visa_compliance", "work_permits"], re: /work permit|labou?r (permit|card)|\bmohre\b|work card/ },
  { to: ["staff_visa_compliance", "employment_visa"], re: /\bvisas?\b|emirates id|immigration|entry permit|status change|\bamer\b|tasheel|\bgdrfa\b|residency|medical (test|fitness)/ },
  { to: ["staff_visa_compliance", "other_compliance"], re: /trade licen[cs]e|licen[cs]e renewal|chamber of commerce|attestation|notary|\blegal\b|lawyer|\baudit(or)?\b|\bpro (fee|services?)\b/ },
  // Bank and payment fees.
  { to: ["bank_fees", "payment_gateway_fees"], re: /(stripe|tabby|tamara|paypal|gateway|payfort|telr|razorpay|ccavenue)\b.*\b(fees?|charges?)|\b(fees?|charges?)\b.*(stripe|tabby|tamara|paypal|gateway|payfort|telr|razorpay|ccavenue)/ },
  { to: ["bank_fees", "card_fees"], re: /card (fees?|charges?)|\bpos (fees?|charges?|machine)|merchant (fees?|charges?)/ },
  { to: ["bank_fees", "currency_conversion_fees"], re: /currency conversion|conversion (fees?|charges?)|exchange (rate )?(fees?|charges?|difference|loss)/ },
  { to: ["bank_fees", "bank_charges"], re: /bank (charges?|fees?)|(transfer|wire|remittance|swift|\btt|cheque|chequebook) (fees?|charges?)|account maintenance/ },
  // Advertising.
  { to: ["advertising_marketing", "meta_ads"], re: /\b(meta|facebook|instagram|fb|insta)\b/ },
  { to: ["advertising_marketing", "google_ads"], re: /google ads?|adwords|youtube ads?|\bppc\b/ },
  { to: ["advertising_marketing", "linkedin_ads"], re: /linkedin/ },
  { to: ["advertising_marketing", "influencer_marketing"], re: /influencer/ },
  { to: ["advertising_marketing", "agency_fees"], re: /\bagency\b|\bseo\b|\bsmm\b/, only: ["marketing"] },
  { to: ["advertising_marketing", "content_production"], re: /\b(shoot|photoshoot|videography|photography|content|reels?|editing|studio)\b/, only: ["marketing", "other"] },
  // Staff welfare, before food and drink (a team lunch is an event).
  { to: ["events_training_welfare", "team_building"], re: /team building|team (outing|lunch|dinner)|\bouting\b|picnic|desert safari|bowling/ },
  { to: ["events_training_welfare", "staff_events"], re: /\bpart(y|ies)\b|celebration|\biftar\b|birthday|\bcakes?\b|farewell|annual day|\bonam\b|diwali|christmas|new year|anniversary/ },
  { to: ["events_training_welfare", "employee_training"], re: /\btraining\b|\bworkshop\b|certification|udemy|coursera/ },
  { to: ["events_training_welfare", "gifts_recognition"], re: /\bgifts?\b|\bawards?\b|troph(y|ies)|recognition|bouquet|flowers?/ },
  // Utilities and rent, before drinking water and a taxi's "rent a car".
  { to: ["travel_transport", "business_travel"], re: /rent a car|car (rental|hire)/ },
  { to: ["rent_utilities", "water"], re: /water bill/ },
  { to: ["rent_utilities", "electricity"], re: /electricity|\bdewa\b|\bsewa\b|\bfewa\b|\baddc\b|power bill/ },
  { to: ["rent_utilities", "internet"], re: /internet|wi-?fi|broadband|fib(er|re)\b|\belife\b/ },
  { to: ["rent_utilities", "other_utilities"], re: /chiller|empower|district cooling|gas bill|\butilit(y|ies)\b/ },
  { to: ["rent_utilities", "office_rent"], re: /\brent\b|\brental\b|\blease\b|ejari|tenancy/ },
  // Software and phones.
  { to: ["software_it", "telephone"], re: /\b3cx\b|telephone|landline|\bvoip\b|\bpbx\b|twilio/ },
  { to: ["software_it", "crm"], re: /\bcrm\b|zoho crm|hubspot|salesforce|bitrix/ },
  { to: ["software_it", "erp"], re: /\berp\b|odoo|quickbooks|\btally\b|\bxero\b|zoho books/ },
  { to: ["software_it", "lms"], re: /\blms\b|moodle|teachable|thinkific|kajabi|learndash/ },
  { to: ["software_it", "cloud_hosting"], re: /\baws\b|amazon web services|hostinger|vercel|digital ?ocean|\bazure\b|google cloud|\bgcp\b|cloudflare|hosting|\bservers?\b|\bvps\b|\bdomains?\b|godaddy|namecheap|mongodb|atlas|heroku|netlify/ },
  { to: ["software_it", "software_subscriptions"], re: /subscription|software|licen[cs]e|\bsaas\b|google workspace|g ?suite|microsoft 365|office 365|canva|adobe|chatgpt|openai|claude|notion|slack|\bzoom\b|figma|tradingview|metatrader|\bmt[45]\b|whatsapp business|\bwati\b|interakt|mailchimp|sendgrid|apple developer|play console/ },
  // Food, before a taxi (Careem food) and pantry.
  { to: ["employee_reimbursements", "staff_meals"], re: /\b(lunch|dinner|breakfast|meals?|food|talabat|deliveroo|zomato|noon food|restaurant|biryani|pizza|shawarma)\b/ },
  // Travel.
  { to: ["travel_transport", "flights"], re: /\bflights?\b|air ?tickets?|airline|flydubai|air arabia|indigo|air india|airfare/ },
  { to: ["travel_transport", "hotels"], re: /\bhotels?\b|accommodation|airbnb|booking\.com|lodging/ },
  { to: ["travel_transport", "fuel"], re: /\bfuel\b|petrol|diesel|\badnoc\b|\benoc\b|eppco/ },
  { to: ["travel_transport", "parking"], re: /parking|\bsalik\b|\btolls?\b|mawaqif/ },
  { to: ["travel_transport", "staff_commuting"], re: /commut(e|ing)|staff transport|pick ?up and drop|bus pass|\bnol\b|metro card/ },
  { to: ["travel_transport", "business_taxi"], re: /\btaxi\b|\bcabs?\b|\buber\b|careem|\bhala\b/ },
  { to: ["travel_transport", "business_travel"], re: /\btravel\b|business trip|\btrip\b/ },
  // A phone after travel: a Nol or Salik top-up is travel.
  { to: ["employee_reimbursements", "mobile_expenses"], re: /\bmobile\b|recharge|sim card|\bsim\b|phone bill|top ?up/ },
  // Office.
  { to: ["office_setup", "computers"], re: /\b(laptops?|computers?|pc|desktops?|macbook|imac|monitors?|keyboards?|mouse|ssd|hard ?disks?|ipads?|tablets?)\b/ },
  { to: ["office_setup", "furniture"], re: /\b(furniture|chairs?|tables?|desks?|sofas?|cabinets?|shel(f|ves)|cupboards?|workstations?)\b/ },
  { to: ["office_setup", "renovation"], re: /renovation|fit ?out|partition|painting|carpentry|interior|flooring|glass work|false ceiling|gypsum/ },
  { to: ["office_setup", "repairs_maintenance"], re: /repairs?|maintenance|plumb(er|ing)|electrician|technician|pest control|ac service/ },
  { to: ["office_setup", "equipment"], re: /printer|projector|\btv\b|television|camera|tripod|microphone|\bmic\b|headset|headphones|router|\bups\b|air ?conditioner|fridge|refrigerator|microwave|coffee machine|water dispenser|\bcctv\b|speakers?|ring light|whiteboard/ },
  { to: ["office_supplies", "printing"], re: /\bprint(ing|s)?\b|photocopy|xerox|business cards?|visiting cards?|flyers?|brochures?|banners?|roll ?up|signage|id cards?/ },
  { to: ["office_supplies", "cleaning_supplies"], re: /cleaning|cleaner|detergent|\bsoap\b|saniti[sz]er|garbage bags?|trash bags?|\bmop\b|broom|dettol|harpic|air freshener|hand ?wash/ },
  { to: ["office_supplies", "pantry_supplies"], re: /\btea\b|coffee|\bmilk\b|sugar|\bwater\b|pantry|biscuits?|\bcups?\b|tissues?|juice|nescafe|grocer(y|ies)|supermarket|carrefour|\blulu\b|spinneys/ },
  { to: ["office_supplies", "stationery"], re: /stationery|stationary|\bpens?\b|\bpapers?\b|\ba4\b|notebooks?|folders?|stapler|markers?|envelopes?|sticky notes|register book/ },
];

/** An old category that, words or not, can only mean one place. */
const OLD_DEFAULTS: Record<string, Target> = {
  salaries_wages: ["payroll_benefits", "basic_salary"],
  "salaries-wages": ["payroll_benefits", "basic_salary"],
  commissions: ["sales_commission", "sales_commission"],
  rent: ["rent_utilities", "office_rent"],
  utilities: ["rent_utilities", "other_utilities"],
};

const TAX = new Map(EXPENSE_TAXONOMY.map((c) => [c.slug, c]));
const nameOf = (t: Target) => {
  const c = TAX.get(t[0])!;
  return { category: c.name, subcategory: c.subcategories.find((s) => s.slug === t[1])!.name };
};
for (const r of RULES) if (!TAX.get(r.to[0])?.subcategories.some((s) => s.slug === r.to[1])) throw new Error(`Rule to ${r.to.join("/")}: not in the taxonomy`);

/** Where an expense goes and why. Exported for the e2e check. */
export function classify(e: { category?: string; categoryName?: string; description?: string; notes?: string; sourceKind?: string },
  hint?: Target): { to: Target; why: string } {
  if (e.sourceKind === "hrms_advance") return { to: ["employee_advances", "salary_advances"], why: "HRMS salary advance" };
  if (e.sourceKind === "hrms_one_time") return { to: ["payroll_benefits", "bonuses"], why: "HRMS one-time payment" };
  if (hint) return { to: hint, why: hint[0] === "payroll_benefits" ? "payroll run" : "CRM commission payout" };
  const old = e.category ?? "";
  const inTaxonomy = TAX.has(old);
  // What was written on it first, then the old category's name (or what was typed for "Other").
  for (const [text, where] of [[[e.description, e.notes].filter(Boolean).join(" "), "description"], [e.categoryName ?? "", "old category"]] as const) {
    const t = text.toLowerCase();
    for (const r of RULES) {
      if (r.only && !r.only.includes(old)) continue;
      // An expense already on a taxonomy category keeps it: only words for that category count.
      if (inTaxonomy && r.to[0] !== old) continue;
      const m = t.match(r.re);
      if (m) return { to: r.to, why: `"${m[0].trim()}" in ${where}` };
    }
  }
  if (OLD_DEFAULTS[old]) return { to: OLD_DEFAULTS[old]!, why: "old category" };
  return { to: PENDING, why: "unsure" };
}

interface OrgPlan {
  orgId: string;
  org: string;
  add: string[];
  reshape: { slug: string; from: string; to: string }[];
  expenses: { id: string; number: string; status: string; from: string; to: Target; why: string }[];
  remove: { slug: string; name: string }[];
}
const count = (p: OrgPlan[]) => p.reduce((n, o) => n + o.add.length + o.reshape.length + o.expenses.length + o.remove.length, 0);

async function planOrg(orgId: Types.ObjectId, orgName: string): Promise<{ plan: OrgPlan; cats: any[]; exps: any[] }> {
  const cats = await ExpenseCategory.find({ organizationId: orgId }).lean<any[]>();
  const have = new Map(cats.map((c) => [c.slug as string, c]));
  const plan: OrgPlan = { orgId: String(orgId), org: orgName, add: [], reshape: [], expenses: [], remove: [] };
  for (const t of EXPENSE_TAXONOMY) {
    const c = have.get(t.slug);
    if (!c) plan.add.push(t.slug);
    else if (!(c.subcategories ?? []).length) plan.reshape.push({ slug: t.slug, from: c.name, to: t.name });
  }
  // The subcategories each taxonomy category will have once this is done.
  const subsAfter = (slug: string) => {
    const c = have.get(slug);
    return c && (c.subcategories ?? []).length ? (c.subcategories as { slug: string }[]) : TAX.get(slug)!.subcategories;
  };

  // Made since the taxonomy (with subcategories of its own): left as it is, its expenses too.
  const madeSince = new Set(cats.filter((c) => !TAX.has(c.slug) && (c.subcategories ?? []).length).map((c) => c.slug as string));

  // Where payroll runs and commission payouts put their expenses.
  const hints = new Map<string, Target>();
  for (const p of await CrmCommissionPayout.find({ organizationId: orgId, expenseId: { $ne: null } }).select("expenseId roles").lean<any[]>()) {
    const tlOnly = (p.roles ?? []).length > 0 && (p.roles as string[]).every((r) => r === "tl");
    hints.set(String(p.expenseId), ["sales_commission", tlOnly ? "team_leader_commission" : "sales_commission"]);
  }
  for (const run of await PayrollRun.find({ organizationId: orgId, "payments.expenseId": { $ne: null } }).select("payments.expenseId").lean<any[]>()) {
    for (const p of run.payments ?? []) if (p.expenseId) hints.set(String(p.expenseId), ["payroll_benefits", "basic_salary"]);
  }

  const exps = await Expense.find({ organizationId: orgId })
    .select("expenseNumber status category categoryName subcategory subcategoryName description notes source.kind legacyCategory").lean<any[]>();
  for (const e of exps) {
    if (madeSince.has(e.category)) continue;
    if (TAX.has(e.category) && e.subcategory && subsAfter(e.category).some((s) => s.slug === e.subcategory)) continue;
    const { to, why } = classify({ category: e.category, categoryName: e.categoryName, description: e.description, notes: e.notes, sourceKind: e.source?.kind }, hints.get(String(e._id)));
    plan.expenses.push({ id: String(e._id), number: e.expenseNumber, status: e.status, from: e.categoryName || e.category, to, why });
  }
  for (const c of cats) if (!TAX.has(c.slug) && !madeSince.has(c.slug)) plan.remove.push({ slug: c.slug, name: c.name });
  return { plan, cats, exps };
}

export async function migrateExpenseTaxonomy(opts: { orgId?: string; write: boolean; backupDir?: string }): Promise<{ plans: OrgPlan[]; backup?: string }> {
  const orgs = (await Organization.find(opts.orgId ? { _id: opts.orgId } : {}).select("name").sort({ createdAt: 1 }).lean<any[]>());
  if (opts.orgId && !orgs.length) throw new Error(`No organization ${opts.orgId}`);
  const planned = [];
  for (const o of orgs) planned.push(await planOrg(o._id, o.name));
  const plans = planned.map((p) => p.plan);
  if (!opts.write || !count(plans)) return { plans };

  // What is about to change, read back whole before anything does.
  const dir = opts.backupDir ?? path.resolve(process.cwd(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `expense-taxonomy-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const backup = {
    at: new Date().toISOString(),
    orgs: planned.map(({ plan, cats, exps }) => ({
      orgId: plan.orgId,
      added: plan.add,
      categories: cats.filter((c) => plan.reshape.some((r) => r.slug === c.slug) || plan.remove.some((r) => r.slug === c.slug)),
      expenses: exps.filter((e) => plan.expenses.some((x) => x.id === String(e._id))).map((e) => ({
        _id: String(e._id), category: e.category, categoryName: e.categoryName ?? "", subcategory: e.subcategory ?? null,
        subcategoryName: e.subcategoryName ?? "", legacyCategory: e.legacyCategory ?? null,
      })),
    })),
  };
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  const back = JSON.parse(fs.readFileSync(file, "utf8"));
  const n = (b: typeof backup) => b.orgs.reduce((t, o) => t + o.expenses.length + o.categories.length, 0);
  if (n(back) !== n(backup)) throw new Error(`The backup ${file} did not read back whole — nothing written`);
  console.log(`Backup: ${file}`);

  for (const { plan, exps } of planned) {
    const oid = new Types.ObjectId(plan.orgId);
    for (const slug of [...plan.add, ...plan.reshape.map((r) => r.slug)]) {
      const t = TAX.get(slug)!;
      await ExpenseCategory.updateOne(
        { organizationId: oid, slug },
        { $set: { name: t.name, isSystem: true, inPnl: t.inPnl, subcategories: t.subcategories.map((s) => ({ ...s })) } },
        { upsert: true },
      );
    }
    const byId = new Map(exps.map((e) => [String(e._id), e]));
    for (const x of plan.expenses) {
      const e = byId.get(x.id)!;
      const names = nameOf(x.to);
      await Expense.updateOne({ _id: e._id }, {
        $set: {
          category: x.to[0], categoryName: names.category, subcategory: x.to[1], subcategoryName: names.subcategory,
          // The first move's old category is the one worth keeping.
          ...(e.legacyCategory ? {} : { legacyCategory: { slug: e.category, name: e.categoryName || e.category } }),
        },
      });
    }
    for (const r of plan.remove) {
      if (await Expense.exists({ organizationId: oid, category: r.slug })) throw new Error(`${plan.org}: "${r.name}" is still used — stopped before removing it`);
      await ExpenseCategory.deleteOne({ organizationId: oid, slug: r.slug });
    }
  }
  return { plans, backup: file };
}

/** Puts back what a run changed, from its backup: the expenses' categories, the removed and reshaped categories, and takes out the added ones nothing uses. */
export async function undoExpenseTaxonomy(file: string, write: boolean): Promise<string[]> {
  const b = JSON.parse(fs.readFileSync(file, "utf8")) as { orgs: { orgId: string; added: string[]; categories: any[]; expenses: any[] }[] };
  const out: string[] = [];
  for (const o of b.orgs) {
    const oid = new Types.ObjectId(o.orgId);
    out.push(`${o.orgId}: ${o.expenses.length} expense(s) back, ${o.categories.length} category(ies) back, up to ${o.added.length} added one(s) out`);
    if (!write) continue;
    for (const e of o.expenses) {
      const set = { category: e.category, categoryName: e.categoryName, subcategory: e.subcategory, subcategoryName: e.subcategoryName };
      await Expense.updateOne({ _id: new Types.ObjectId(e._id) },
        e.legacyCategory ? { $set: { ...set, legacyCategory: e.legacyCategory } } : { $set: set, $unset: { legacyCategory: 1 } });
    }
    for (const c of o.categories) {
      const { _id, ...rest } = c;
      await ExpenseCategory.replaceOne({ organizationId: oid, slug: c.slug }, { ...rest, _id: new Types.ObjectId(_id), organizationId: oid }, { upsert: true });
    }
    for (const slug of o.added) {
      if (!(await Expense.exists({ organizationId: oid, category: slug }))) await ExpenseCategory.deleteOne({ organizationId: oid, slug });
    }
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : undefined; };
  const write = argv.includes("--write");
  const orgId = arg("--org");
  if (orgId && !Types.ObjectId.isValid(orgId)) { console.error("--org needs an organization id"); process.exit(1); }
  const { connectDb } = await import("../config/db");
  await connectDb();

  const undo = arg("--undo");
  if (undo) {
    for (const l of await undoExpenseTaxonomy(undo, write)) console.log(l);
    console.log(write ? "\nPut back." : "\nNothing written — run again with --write.");
    await mongoose.disconnect();
    process.exit(0);
  }

  const print = (plans: OrgPlan[]) => {
    for (const p of plans) {
      console.log(`\n== ${p.org} (${p.orgId})`);
      if (p.add.length) console.log(`  categories added: ${p.add.map((s) => TAX.get(s)!.name).join(", ")}`);
      for (const r of p.reshape) console.log(`  category reshaped: "${r.from}" → "${r.to}" with its subcategories`);
      for (const x of p.expenses) {
        const n = nameOf(x.to);
        console.log(`  ${String(x.number).padEnd(11)} ${String(x.status).padEnd(9)} ${String(x.from).slice(0, 26).padEnd(26)} → ${categoryLabel(n.category, n.subcategory)}  (${x.why})`);
      }
      for (const r of p.remove) console.log(`  category removed: "${r.name}"`);
      const pending = p.expenses.filter((x) => x.to === PENDING).length;
      console.log(`  — ${p.expenses.length} expense(s) filed, ${pending} of them to Pending Classification`);
    }
  };
  const dry = await migrateExpenseTaxonomy({ orgId, write: false });
  if (write) {
    const expect = Number(arg("--expect"));
    if (expect !== count(dry.plans)) {
      print(dry.plans);
      console.error(`\nRefusing to write: ${count(dry.plans)} change(s), and --expect ${arg("--expect") ?? "(missing)"} was given.`);
      await mongoose.disconnect();
      process.exit(1);
    }
    const done = await migrateExpenseTaxonomy({ orgId, write: true });
    print(done.plans);
    console.log(`\n${count(done.plans)} change(s) written. Undo: bun src/scripts/expense-taxonomy-migrate.ts --undo ${done.backup} --write`);
  } else {
    print(dry.plans);
    console.log(`\n${count(dry.plans)} change(s). Nothing written — run again with --write --expect ${count(dry.plans)}.`);
  }
  await mongoose.disconnect();
}
