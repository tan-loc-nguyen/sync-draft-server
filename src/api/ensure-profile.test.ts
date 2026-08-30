import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../config/prisma.js';
import { ensureProfile } from './ensure-profile.js';

const USER = 'auth0|newcomer';

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "merges","document_shares","documents","users" RESTART IDENTITY CASCADE'
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('ensureProfile', () => {
  // Every route behind the JWT middleware belongs to a signed-in person, so a
  // request must never proceed with no profile row: the share a link grants
  // could not be recorded against them.
  it('creates a profile for a token that has none yet', async () => {
    await ensureProfile(USER, 'newcomer@test.dev');

    expect(await prisma.user.findUnique({ where: { userId: USER } })).toMatchObject({
      userId: USER,
      email: 'newcomer@test.dev',
    });
  });

  it('leaves an existing profile untouched', async () => {
    await prisma.user.create({ data: { userId: USER, email: 'original@test.dev' } });

    await ensureProfile(USER, 'different@test.dev');

    const user = await prisma.user.findUnique({ where: { userId: USER } });
    expect(user?.email).toBe('original@test.dev');
    expect(await prisma.user.count({ where: { userId: USER } })).toBe(1);
  });

  // Auth0 access tokens only carry an email when the right scope was granted.
  it('still creates a profile when the token carries no email', async () => {
    await ensureProfile(USER, undefined);

    expect(await prisma.user.findUnique({ where: { userId: USER } })).not.toBeNull();
  });

  it('is safe to call concurrently for the same user', async () => {
    await Promise.all([
      ensureProfile(USER, 'a@test.dev'),
      ensureProfile(USER, 'a@test.dev'),
      ensureProfile(USER, 'a@test.dev'),
    ]);

    expect(await prisma.user.count({ where: { userId: USER } })).toBe(1);
  });
});
