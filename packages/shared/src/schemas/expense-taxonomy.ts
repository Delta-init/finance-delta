/*
 * The expense categories and their subcategories (the user, 2026-10-21) — every organization's set, replacing the
 * flat seven (Salaries & Wages … Other). `inPnl: false` marks what is recorded and listed but is not an expense in the
 * profit and loss — money staff owe back, loan principal, payroll clearing, VAT — a subcategory's own flag overriding
 * its category's (Loan / Financing: interest and fees are expenses, principal is not).
 */

export interface TaxonomySubcategory { slug: string; name: string; inPnl?: boolean }
export interface TaxonomyCategory { slug: string; name: string; inPnl: boolean; subcategories: TaxonomySubcategory[] }

const sub = (slug: string, name: string, inPnl?: boolean): TaxonomySubcategory => (inPnl === undefined ? { slug, name } : { slug, name, inPnl });

export const EXPENSE_TAXONOMY: readonly TaxonomyCategory[] = [
  { slug: "advertising_marketing", name: "Advertising & Marketing", inPnl: true, subcategories: [
    sub("meta_ads", "Meta Ads"), sub("google_ads", "Google Ads"), sub("linkedin_ads", "LinkedIn Ads"), sub("agency_fees", "Agency Fees"),
    sub("influencer_marketing", "Influencer Marketing"), sub("content_production", "Content Production")] },
  { slug: "bank_fees", name: "Bank Fees & Charges", inPnl: true, subcategories: [
    sub("bank_charges", "Bank Charges"), sub("payment_gateway_fees", "Payment Gateway Fees"), sub("card_fees", "Card Fees"),
    sub("currency_conversion_fees", "Currency Conversion Fees")] },
  { slug: "employee_advances", name: "Employee Advances Receivable", inPnl: false, subcategories: [
    sub("salary_advances", "Salary Advances"), sub("emergency_advances", "Emergency Advances"), sub("other_staff_advances", "Other Recoverable Staff Advances")] },
  { slug: "employee_reimbursements", name: "Employee Reimbursements", inPnl: true, subcategories: [
    sub("staff_meals", "Staff Meals"), sub("mobile_expenses", "Mobile Expenses"), sub("other_staff_claims", "Other Approved Staff Claims")] },
  { slug: "events_training_welfare", name: "Events, Training & Staff Welfare", inPnl: true, subcategories: [
    sub("staff_events", "Staff Events"), sub("employee_training", "Employee Training"), sub("team_building", "Team Building"),
    sub("gifts_recognition", "Gifts & Recognition")] },
  { slug: "loan_financing", name: "Loan / Financing", inPnl: true, subcategories: [
    sub("loan_principal", "Loan Principal", false), sub("interest_expense", "Interest Expense"), sub("financing_fees", "Financing Fees")] },
  { slug: "office_setup", name: "Office Setup, Equipment & Renovation", inPnl: true, subcategories: [
    sub("furniture", "Furniture"), sub("computers", "Computers"), sub("equipment", "Equipment"), sub("renovation", "Renovation"),
    sub("repairs_maintenance", "Repairs & Maintenance")] },
  { slug: "office_supplies", name: "Office Supplies & Pantry", inPnl: true, subcategories: [
    sub("stationery", "Stationery"), sub("printing", "Printing"), sub("pantry_supplies", "Pantry Supplies"), sub("cleaning_supplies", "Cleaning Supplies")] },
  { slug: "other_unclassified", name: "Other / Unclassified", inPnl: true, subcategories: [
    sub("pending_classification", "Pending Classification"), sub("other_approved", "Other Approved Expenses"),
    // Not costs (2026-10-21, the old books' import): partners' shares are equity, intercompany/investment payments assets.
    sub("partner_distributions", "Partner Distributions", false), sub("intercompany_investments", "Intercompany & Investments", false)] },
  { slug: "payroll_benefits", name: "Payroll & Employee Benefits", inPnl: true, subcategories: [
    sub("basic_salary", "Basic Salary"), sub("allowances", "Allowances"), sub("overtime", "Overtime"), sub("bonuses", "Bonuses"),
    sub("employer_benefits", "Employer Benefits")] },
  { slug: "payroll_payable", name: "Payroll Payable / Payroll Clearing", inPnl: false, subcategories: [
    sub("salary_payable", "Salary Payable"), sub("commission_payable", "Commission Payable"), sub("other_employee_payables", "Other Employee Payables")] },
  { slug: "rent_utilities", name: "Rent & Utilities", inPnl: true, subcategories: [
    sub("office_rent", "Office Rent"), sub("electricity", "Electricity"), sub("water", "Water"), sub("internet", "Internet"),
    sub("other_utilities", "Other Utilities")] },
  { slug: "sales_commission", name: "Sales / Mentor Commission & Incentives", inPnl: true, subcategories: [
    sub("sales_commission", "Sales Commission"), sub("team_leader_commission", "Team Leader Commission"), sub("mentor_commission", "Mentor Commission"),
    sub("sales_incentives", "Sales Incentives")] },
  { slug: "software_it", name: "Software, IT & Communications", inPnl: true, subcategories: [
    sub("crm", "CRM"), sub("erp", "ERP"), sub("lms", "LMS"), sub("cloud_hosting", "Cloud Hosting"), sub("software_subscriptions", "Software Subscriptions"),
    sub("telephone", "Telephone")] },
  { slug: "staff_visa_compliance", name: "Staff Visa, Insurance & Compliance", inPnl: true, subcategories: [
    sub("employment_visa", "Employment Visa"), sub("medical_insurance", "Medical Insurance"), sub("work_permits", "Work Permits"),
    sub("other_compliance", "Other Employment Compliance")] },
  { slug: "travel_transport", name: "Travel & Transportation", inPnl: true, subcategories: [
    sub("staff_commuting", "Staff Commuting Reimbursement"), sub("business_taxi", "Business Taxi"), sub("business_travel", "Business Travel"),
    sub("flights", "Flights"), sub("hotels", "Hotels"), sub("fuel", "Fuel"), sub("parking", "Parking")] },
  { slug: "vat_control", name: "VAT Control Account", inPnl: false, subcategories: [
    sub("input_vat", "Input VAT"), sub("output_vat", "Output VAT"), sub("vat_payable", "VAT Payable"), sub("vat_recoverable", "VAT Recoverable"),
    sub("vat_settlement", "VAT Settlement")] },
];

/** Where the flows finance makes by itself put their expense (2026-10-21): category and subcategory slugs. */
export const EXPENSE_DEFAULTS = {
  payroll: { category: "payroll_benefits", subcategory: "basic_salary" },
  salaryAdvance: { category: "employee_advances", subcategory: "salary_advances" },
  oneTimePayment: { category: "payroll_benefits", subcategory: "bonuses" },
  crmCommission: { category: "sales_commission", subcategory: "sales_commission" },
  crmCommissionTeamLeader: { category: "sales_commission", subcategory: "team_leader_commission" },
  procurement: { category: "other_unclassified", subcategory: "pending_classification" },
  unclassified: { category: "other_unclassified", subcategory: "pending_classification" },
} as const;

/** "Travel & Transportation › Fuel", or the category alone. */
export function categoryLabel(categoryName: string | null | undefined, subcategoryName: string | null | undefined): string {
  return [categoryName, subcategoryName].filter(Boolean).join(" › ");
}
