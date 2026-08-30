export interface PrintLabels {
  invoice: string; quotation: string; creditNote: string; receipt: string;
  billTo: string; quoteTo: string; issueDate: string; dueDate: string;
  expiryDate: string; description: string; qty: string; unitPrice: string;
  discount: string; tax: string; amount: string; subtotal: string; total: string;
  balanceDue: string; paid: string; notes: string; terms: string;
  paymentHistory: string; salesperson: string; reference: string;
  currency: string; print: string; close: string; reason: string;
  creditApplied: string; account: string;
  taxInvoice: string; bankDetails: string; accountName: string;
  accountNumber: string; bankName: string; branch: string;
  ifsc: string; swift: string; iban: string;
}

const en: PrintLabels = {
  invoice: "INVOICE", quotation: "QUOTATION", creditNote: "CREDIT NOTE", receipt: "PAYMENT RECEIPT",
  billTo: "Bill To", quoteTo: "Quote To", issueDate: "Issue Date", dueDate: "Due Date",
  expiryDate: "Expiry Date", description: "Description", qty: "Qty", unitPrice: "Unit Price",
  discount: "Disc %", tax: "Tax", amount: "Amount", subtotal: "Subtotal", total: "Total",
  balanceDue: "Balance Due", paid: "Paid", notes: "Notes", terms: "Terms",
  paymentHistory: "Payment History", salesperson: "Salesperson", reference: "Reference",
  currency: "Currency", print: "Print / Save as PDF", close: "Close",
  reason: "Reason", creditApplied: "Credit Applied", account: "Account",  taxInvoice: "TAX INVOICE", bankDetails: "Bank Details", accountName: "Account Name",
  accountNumber: "Account No.", bankName: "Bank", branch: "Branch",
  ifsc: "IFSC", swift: "SWIFT", iban: "IBAN",
};

const ar: PrintLabels = {
  invoice: "فاتورة", quotation: "عرض سعر", creditNote: "إشعار دائن", receipt: "إيصال دفع",
  billTo: "فاتورة إلى", quoteTo: "عرض إلى", issueDate: "تاريخ الإصدار", dueDate: "تاريخ الاستحقاق",
  expiryDate: "تاريخ الانتهاء", description: "الوصف", qty: "الكمية", unitPrice: "سعر الوحدة",
  discount: "خصم %", tax: "ضريبة", amount: "المبلغ", subtotal: "المجموع الفرعي", total: "الإجمالي",
  balanceDue: "الرصيد المستحق", paid: "المدفوع", notes: "ملاحظات", terms: "الشروط والأحكام",
  paymentHistory: "سجل المدفوعات", salesperson: "مندوب المبيعات", reference: "مرجع",
  currency: "العملة", print: "طباعة / حفظ PDF", close: "إغلاق",
  reason: "السبب", creditApplied: "الرصيد المطبق", account: "الحساب",  taxInvoice: "فاتورة ضريبية", bankDetails: "التفاصيل البنكية", accountName: "اسم الحساب",
  accountNumber: "رقم الحساب", bankName: "البنك", branch: "الفرع",
  ifsc: "IFSC", swift: "SWIFT", iban: "IBAN",
};

const fr: PrintLabels = {
  invoice: "FACTURE", quotation: "DEVIS", creditNote: "NOTE DE CRÉDIT", receipt: "REÇU DE PAIEMENT",
  billTo: "Facturer à", quoteTo: "Devis pour", issueDate: "Date d'émission", dueDate: "Date d'échéance",
  expiryDate: "Date d'expiration", description: "Description", qty: "Qté", unitPrice: "Prix unitaire",
  discount: "Remise %", tax: "Taxe", amount: "Montant", subtotal: "Sous-total", total: "Total",
  balanceDue: "Solde dû", paid: "Payé", notes: "Notes", terms: "Conditions",
  paymentHistory: "Historique des paiements", salesperson: "Commercial", reference: "Référence",
  currency: "Devise", print: "Imprimer / Enregistrer PDF", close: "Fermer",
  reason: "Motif", creditApplied: "Crédit appliqué", account: "Compte",  taxInvoice: "FACTURE FISCALE", bankDetails: "Coordonnées bancaires", accountName: "Nom du compte",
  accountNumber: "N° de compte", bankName: "Banque", branch: "Agence",
  ifsc: "IFSC", swift: "SWIFT", iban: "IBAN",
};

const LABELS: Record<string, PrintLabels> = { en, ar, fr };

export function getPrintLabels(locale?: string | null, taxLabel?: string | null): PrintLabels {
  const base = LABELS[locale ?? "en"] ?? en;
  if (taxLabel && taxLabel !== base.tax) {
    return { ...base, tax: taxLabel };
  }
  return base;
}
