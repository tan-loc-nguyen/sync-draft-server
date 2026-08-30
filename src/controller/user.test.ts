import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../config/prisma.js';
import { createUser, getUserById } from './user.js';

const USER = 'auth0|someone';

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "merges","document_shares","documents","users" RESTART IDENTITY CASCADE'
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('getUserById', () => {
  it('returns null for a user that has no profile', async () => {
    expect(await getUserById(USER)).toBeNull();
  });
});

describe('createUser', () => {
  it('creates a profile for a new user', async () => {
    const user = await createUser('someone@test.dev', USER);

    expect(user).toMatchObject({ userId: USER, email: 'someone@test.dev' });
    expect(await getUserById(USER)).not.toBeNull();
  });

  // The client posts a profile whenever it fails to read one, so two tabs
  // signing in at once must not produce an error or a duplicate row.
  it('is idempotent when the profile already exists', async () => {
    const first = await createUser('someone@test.dev', USER);
    const second = await createUser('someone@test.dev', USER);

    expect(second.id).toBe(first.id);
    expect(await prisma.user.count({ where: { userId: USER } })).toBe(1);
  });
});
