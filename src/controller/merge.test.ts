import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../config/prisma.js';
import { createDocument, getDocumentById } from './document.js';
import { ForbiddenError } from './errors.js';
import { createMerge, getMergesByDocId } from './merge.js';

const OWNER = 'auth0|owner';
const COLLABORATOR = 'auth0|collaborator';
const STRANGER = 'auth0|stranger';

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "merges","document_shares","documents","users" RESTART IDENTITY CASCADE'
  );
  await prisma.user.createMany({
    data: [
      { userId: OWNER, email: 'owner@test.dev' },
      { userId: COLLABORATOR, email: 'collaborator@test.dev' },
      { userId: STRANGER, email: 'stranger@test.dev' },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('createMerge', () => {
  it('attaches the merge to the document it belongs to', async () => {
    const doc = await createDocument(OWNER);

    await createMerge({
      docId: doc.id,
      mergedBy: OWNER,
      before: 'old text',
      after: 'new text',
      description: 'Merged intro rewrite',
    });

    const merges = await getMergesByDocId(doc.id);
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({
      documentId: doc.id,
      mergedById: OWNER,
      description: 'Merged intro rewrite',
    });
  });

  it('lets a collaborator record a merge', async () => {
    const doc = await createDocument(OWNER);
    await getDocumentById(COLLABORATOR, doc.id);

    const merge = await createMerge({
      docId: doc.id,
      mergedBy: COLLABORATOR,
      before: 'a',
      after: 'b',
      description: null,
    });

    expect(merge.mergedById).toBe(COLLABORATOR);
  });

  it('refuses a user with no access to the document', async () => {
    const doc = await createDocument(OWNER);

    await expect(
      createMerge({ docId: doc.id, mergedBy: STRANGER, before: 'a', after: 'b', description: null })
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(await getMergesByDocId(doc.id)).toHaveLength(0);
  });
});
