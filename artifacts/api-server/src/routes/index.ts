import { Router, type IRouter } from "express";
import healthRouter from "./health";
import repositoriesRouter from "./repositories";
import repositoryExplanationsRouter from "./repository-explanations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(repositoriesRouter);
router.use(repositoryExplanationsRouter);

export default router;
