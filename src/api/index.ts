import { Application, Request, Response, Router } from "express";
import { Redis } from "ioredis";

import { userRouter } from "./routes/user.js";
import { documentRouter } from "./routes/document.js";
import { mergeRouter } from "./routes/merge.js";
import { jwtMiddleware } from "../middleware/jwt.js";
import { ensureProfileMiddleware } from "./ensure-profile.js";


export default async (app: Application, redis: Redis) => {
  const router = Router();
  
  app.get('/health', (req: Request, res: Response) => {
    res.send('👍 Sync Server is running...')
  })

  app.use('/api', router);

  router.use(jwtMiddleware);
  // There is no anonymous mode: everyone past the gate gets a profile row.
  router.use(ensureProfileMiddleware);
  
  userRouter(router);
  documentRouter(router, redis);
  mergeRouter(router);
}