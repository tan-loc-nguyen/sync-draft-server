import { Request, Response, Router } from "express";

import { userIdFrom } from '../auth.js';

import { createMerge, getMergesByDocId } from "../../controller/merge.js";
import { ForbiddenError, NotFoundError } from "../../controller/errors.js";
import { FORBIDDEN, INTERNAL_SERVER_ERROR, NOT_FOUND, OK } from "../status_code.js";

const fail = (res: Response, error: unknown, context: string) => {
  if (error instanceof ForbiddenError) {
    return res.status(FORBIDDEN).json({ error: error.message });
  }

  if (error instanceof NotFoundError) {
    return res.status(NOT_FOUND).json({ error: error.message });
  }

  console.error(`[Error] ${context}: ${error}`);

  return res.status(INTERNAL_SERVER_ERROR).json({ error: 'Internal Server Error' });
};

export const mergeRouter = (router: Router) => {
  router.route('/merges/:docId')
  .get(async (req: Request<{ docId: string }>, res: Response): Promise<Response> => {
    try {
      const { docId } = req.params;

      return res.status(OK).json(await getMergesByDocId(docId));
    } catch (error) {
      return fail(res, error, `GET | /merges/:docId: ${req.params.docId}`);
    }
  })
  .post(async (req: Request<{ docId: string }>, res: Response): Promise<Response> => {
    try {
      const { docId } = req.params;
      const { before, after, description } = req.body
      const userId = userIdFrom(req);

      // The merge row itself carries the document link; there is no array to update.
      const newMerge = await createMerge({
        docId,
        mergedBy: userId,
        before,
        after,
        description
      })

      return res.status(OK).json(newMerge);
    } catch (error) {
      return fail(res, error, `POST | /merges/:docId: ${req.params.docId}`);
    }
  })
}
