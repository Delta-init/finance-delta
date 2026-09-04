import { Router } from "express";
import { serviceAuth } from "../../middleware/service-auth";
import * as c from "./integrations.controller";

const router = Router();

// Signed machine calls only. No `authenticate`, and therefore no session and no
// organization — every handler takes the organization as an explicit header,
// checked against the database before anything is written.
router.use(serviceAuth);

router.get("/ping", c.ping);

// A lead closed in the CRM is an enrolment here. Idempotent on the caller's own
// id, because the case this is built for is a retry after a timeout.
router.post("/enrolments", c.takeEnrolment);

export default router;
