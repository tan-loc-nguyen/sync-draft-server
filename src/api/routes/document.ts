import { Request, Response, Router } from "express";

import { userIdFrom } from '../auth.js';
import { Redis } from "ioredis";

import {
  createDocument,
  deleteDocumentById,
  getDocumentById,
  getDocumentsByOwner,
  getSharedDocuments,
  updateDocumentTitle,
} from "../../controller/document.js";
import { ForbiddenError, NotFoundError } from "../../controller/errors.js";
import { BAD_REQUEST, FORBIDDEN, INTERNAL_SERVER_ERROR, NOT_FOUND, OK } from "../status_code.js";

// Maps a controller failure onto the right status code.
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

export const documentRouter = (router: Router, redis: Redis) => {
  router.route('/documents')
  .get(async (req: Request, res: Response): Promise<Response> => {
    try {
      const { q } = req.query;
      const userId = userIdFrom(req);

      if (q === 'mine') {
        return res.status(OK).json(await getDocumentsByOwner(userId));
      }

      if (q === 'shared') {
        return res.status(OK).json(await getSharedDocuments(userId));
      }

      return res.status(BAD_REQUEST).json({
        error: 'Invalid query params'
      })
    } catch (error) {
      return fail(res, error, `GET | /documents: ${userIdFrom(req)}`);
    }
  })
  .post(async (req: Request, res: Response): Promise<Response> => {
    try {
      const userId = userIdFrom(req);

      const newDoc = await createDocument(userId);

      await redis.set(newDoc.id, '');

      return res.status(OK).json(newDoc);
    } catch (error) {
      return fail(res, error, `POST | /documents: ${userIdFrom(req)}`);
    }
  })

  router.route('/documents/:docId')
  .get(async (req: Request<{ docId: string }>, res: Response): Promise<Response> => {
    try {
      const { docId } = req.params;
      const userId = userIdFrom(req);

      const doc = await getDocumentById(userId, docId);

      if (!doc) {
        return res.status(NOT_FOUND).json(null)
      }

      return res.status(OK).json(doc);
    } catch (error) {
      return fail(res, error, `GET | /documents/:docId: ${req.params.docId}`);
    }
  })
  .put(async (req: Request<{ docId: string }>, res: Response): Promise<Response> => {
    try {
      const { docId } = req.params;
      const { newTitle } = req.body;
      const userId = userIdFrom(req);

      const updatedDocument = await updateDocumentTitle(userId, docId, newTitle);

      return res.status(OK).json(updatedDocument);
    } catch (error) {
      return fail(res, error, `PUT | /documents/:docId: ${req.params.docId}`);
    }
  })
  .delete(async (req: Request<{ docId: string }>, res: Response): Promise<Response> => {
    try {
      const { docId } = req.params;
      const userId = userIdFrom(req);

      await deleteDocumentById(userId, docId);

      await redis.del(`room_${docId}`, docId)

      return res.status(OK).json({ message: "success" });
    } catch (error) {
      return fail(res, error, `DELETE | /documents/:docId: ${req.params.docId}`);
    }
  })
}
