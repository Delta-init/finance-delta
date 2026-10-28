import { Router } from "express";
import { serviceAuth } from "../../middleware/service-auth";
import * as c from "./integrations.controller";

const router = Router();

// Signed machine calls only. No `authenticate`, and therefore no session and no
// organization — every handler takes the organization as an explicit header,
// checked against the database before anything is written.
router.use(serviceAuth);

router.get("/ping", c.ping);

// The catalogue, so a calling system can map its own courses onto it.
router.get("/items", c.listItems);

// A lead closed in the CRM is an enrolment here. Idempotent on the caller's own
// id, because the case this is built for is a retry after a timeout.
router.post("/enrolments", c.takeEnrolment);

// What became of them. POST because the caller sends a list of its own ids, and
// a list of ids is not a thing to put in a query string.
router.post("/enrolments/status", c.enrolmentStatuses);

// The sales note changed in the CRM after the close (2026-10-17) — only the
// note, never the approval or the bill.
router.post("/enrolments/sales-note", c.updateEnrolmentSalesNote);

// The next payment of a part-paid enrolment, recorded in the CRM that closed it
// (2026-10-13), for accounts to approve. Idempotent on the CRM's own id; where
// it stands comes back with the enrolment's status.
router.post("/enrolments/balance-payments", c.takeBalancePayment);

// Media ERP asking for money out of Marketing's allocation. Lands as a
// drawdown waiting for review; idempotent on the caller's own id, like the
// enrolments above.
router.post("/funding-requests", c.takeFundingRequest);

// What became of them, by the caller's own ids.
router.post("/funding-requests/status", c.fundingRequestStatuses);

// CS Portal handing over a deposit request for the accountants to
// approve. Idempotent on its own id; the decision is sent back to it.
router.post("/tetra-deposits", c.takeTetraDeposit);

// A sales CRM's My Pay asking where finance stands on its people's commission for a month (2026-10-21).
router.get("/crm-commission/payouts", c.crmCommissionPayouts);

export default router;
