import { prisma } from '../config/prisma.js';
import { UserModel } from '../generated/prisma/models.js';

export const getUserById = async (userId: string): Promise<UserModel | null> =>
  prisma.user.findUnique({ where: { userId } });

// Idempotent: the client posts a profile whenever it fails to read one, so a
// repeat call must return the existing profile rather than fail.
export const createUser = async (email: string, userId: string): Promise<UserModel> =>
  prisma.user.upsert({
    where: { userId },
    create: { userId, email },
    update: {},
  });
