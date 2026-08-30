import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../config/prisma.js';
import { ForbiddenError } from './errors.js';
import {
  createDocument,
  deleteDocumentById,
  getDocumentById,
  getDocumentsByOwner,
  getSharedDocuments,
  updateDocumentTitle,
} from './document.js';

const OWNER = 'auth0|owner';
const STRANGER = 'auth0|stranger';

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "merges","document_shares","documents","users" RESTART IDENTITY CASCADE'
  );
  await prisma.user.createMany({
    data: [
      { userId: OWNER, email: 'owner@test.dev' },
      { userId: STRANGER, email: 'stranger@test.dev' },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('getDocumentById', () => {
  it('returns the document to its owner', async () => {
    const doc = await createDocument(OWNER);

    expect(await getDocumentById(OWNER, doc.id)).toMatchObject({ id: doc.id, ownerId: OWNER });
  });

  it('returns null when the document does not exist', async () => {
    expect(await getDocumentById(OWNER, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  // Sync Draft shares by link: opening someone else's document grants access
  // and records the share so it appears under "Shared with me".
  it('records a share when a non-owner opens the document', async () => {
    const doc = await createDocument(OWNER);

    await getDocumentById(STRANGER, doc.id);

    const shares = await prisma.documentShare.findMany({ where: { documentId: doc.id } });
    expect(shares).toHaveLength(1);
    expect(shares[0].userId).toBe(STRANGER);
  });

  it('does not record the owner as a share of their own document', async () => {
    const doc = await createDocument(OWNER);

    await getDocumentById(OWNER, doc.id);

    expect(await prisma.documentShare.count({ where: { documentId: doc.id } })).toBe(0);
  });
});

describe('updateDocumentTitle', () => {
  it('lets the owner rename their document', async () => {
    const doc = await createDocument(OWNER);

    const updated = await updateDocumentTitle(OWNER, doc.id, 'Thesis draft');

    expect(updated.title).toBe('Thesis draft');
  });

  it('refuses a user the document has never been shared with', async () => {
    const doc = await createDocument(OWNER);

    await expect(updateDocumentTitle(STRANGER, doc.id, 'Hijacked')).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });
});

describe('deleteDocumentById', () => {
  it('lets the owner delete their document', async () => {
    const doc = await createDocument(OWNER);

    await deleteDocumentById(OWNER, doc.id);

    expect(await prisma.document.findUnique({ where: { id: doc.id } })).toBeNull();
  });

  it('refuses to delete a document the user does not own', async () => {
    const doc = await createDocument(OWNER);

    await expect(deleteDocumentById(STRANGER, doc.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.document.findUnique({ where: { id: doc.id } })).not.toBeNull();
  });

  it('removes the shares and merges belonging to a deleted document', async () => {
    const doc = await createDocument(OWNER);
    await getDocumentById(STRANGER, doc.id);
    await prisma.merge.create({
      data: { documentId: doc.id, mergedById: OWNER, before: 'a', after: 'b' },
    });

    await deleteDocumentById(OWNER, doc.id);

    expect(await prisma.documentShare.count()).toBe(0);
    expect(await prisma.merge.count()).toBe(0);
  });
});

describe('document listings', () => {
  it('separates documents a user owns from documents shared with them', async () => {
    const mine = await createDocument(OWNER);
    const theirs = await createDocument(STRANGER);
    await getDocumentById(OWNER, theirs.id);

    expect((await getDocumentsByOwner(OWNER)).map((d) => d.id)).toEqual([mine.id]);
    expect((await getSharedDocuments(OWNER)).map((d) => d.id)).toEqual([theirs.id]);
  });
});
