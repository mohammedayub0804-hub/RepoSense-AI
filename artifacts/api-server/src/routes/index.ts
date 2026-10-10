import { Router, type IRouter } from "express";
import healthRouter from "./health";
import repositoriesRouter from "./repositories";

const router: IRouter = Router();

router.use(healthRouter);
router.use(repositoriesRouter);

export default router;
