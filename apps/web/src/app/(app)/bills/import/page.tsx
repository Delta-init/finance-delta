"use client";

import { ImportWizard } from "@/features/imports/ImportWizard";
import { BILL_IMPORT } from "@/features/imports/kinds";

/** Bills from a spreadsheet (2026-11-11). */
export default function ImportBillsPage() {
  return <ImportWizard kind={BILL_IMPORT} />;
}
