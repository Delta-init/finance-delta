import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { search } from "./search.controller";

const router = Router();
router.use(authenticate);
router.get("/", search);

export default router;
