import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { suggest } from "./suggestions.controller";

const router = Router();
router.use(authenticate);
router.get("/", suggest);

export default router;
