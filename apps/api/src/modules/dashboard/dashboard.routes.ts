import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import * as c from "./dashboard.controller";

const router = Router();
router.use(authenticate);
router.get("/", c.getStats);
export default router;
