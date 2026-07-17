import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import serversRouter from "./servers";
import channelsRouter from "./channels";
import messagesRouter from "./messages";
import dmsRouter from "./dms";
import usersRouter from "./users";
import adminRouter from "./admin";
import rolesRouter from "./roles";
import voiceRouter from "./voice";
import storiesRouter from "./stories";
import clipsRouter from "./clips";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(serversRouter);
router.use(channelsRouter);
router.use(messagesRouter);
router.use(dmsRouter);
router.use(usersRouter);
router.use(adminRouter);
router.use(rolesRouter);
router.use(voiceRouter);
router.use(storiesRouter);
router.use(clipsRouter);

export default router;
