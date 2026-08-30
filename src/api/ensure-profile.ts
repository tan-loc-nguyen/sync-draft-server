import { NextFunction, Request, Response } from 'express';

import { prisma } from '../config/prisma.js';
import { userIdFrom } from './auth.js';

/**
 * Guarantees the signed-in user has a profile row.
 *
 * There is no anonymous mode: every request past the JWT middleware belongs to
 * a real account. Without this, someone who followed a share link before ever
 * visiting the document list would have no row for a share to reference, and
 * the document would silently fail to appear under "Shared with me".
 *
 * Concurrent calls are safe — the unique constraint on userId makes the upsert
 * idempotent.
 */
export const ensureProfile = async (userId: string, email: string | undefined): Promise<void> => {
  await prisma.user.upsert({
    where: { userId },
    // An access token only carries an email when that scope was granted; the
    // client fills it in later via POST /users.
    create: { userId, email: email ?? '' },
    // Never overwrite a profile that already exists.
    update: {},
  });
};

export const ensureProfileMiddleware = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const payload = req.auth?.payload as { email?: string } | undefined;
    await ensureProfile(userIdFrom(req), payload?.email);
    next();
  } catch (error) {
    next(error);
  }
};
