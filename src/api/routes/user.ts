import { Request, Response, Router } from "express";

import { userIdFrom } from '../auth.js';

import { INTERNAL_SERVER_ERROR, NOT_FOUND, OK } from "../status_code.js";
import { createUser, getUserById } from "../../controller/user.js";

export const userRouter = (router: Router) => {
  router.route('/users')
  .get(async (req: Request, res: Response): Promise<Response> => {
    try {
      const userId = userIdFrom(req);

      const user = await getUserById(userId);

      if (!user) {
        return res.status(NOT_FOUND).json(null);
      }

      return res.status(OK).json(user);
    } catch (error) {
      console.error(`[Error] GET | /users: ${userIdFrom(req)}: ${error}`);

      return res.status(INTERNAL_SERVER_ERROR).json({
        error: 'Internal Server Error'
      });
    }
  })
  .post(async (req: Request, res: Response): Promise<Response> => {
    try {
      const { email } = req.body;
      // Trust the token for identity, never the request body.
      const userId = userIdFrom(req);

      const newUser = await createUser(email, userId);

      return res.status(OK).json(newUser);
    } catch (error) {
      console.error(`[Error] POST | /users: ${userIdFrom(req)}: ${error}`);

      return res.status(INTERNAL_SERVER_ERROR).json({
        error: 'Internal Server Error'
      });
    }
  })
}
