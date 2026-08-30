import { prisma } from '../config/prisma.js';
import { DocumentModel } from '../generated/prisma/models.js';
import { ForbiddenError, NotFoundError } from './errors.js';

// A document may be edited by its owner and by anyone it has been shared with.
// Deleting is owner-only and checked separately.
export const assertCanEdit = async (userId: string, docId: string): Promise<void> => {
  const document = await prisma.document.findUnique({
    where: { id: docId },
    include: { shares: { where: { userId } } },
  });

  if (!document) {
    throw new NotFoundError('Document not found!');
  }

  if (document.ownerId !== userId && document.shares.length === 0) {
    throw new ForbiddenError('You do not have access to this document');
  }
};

export const getDocumentsByOwner = async (userId: string): Promise<DocumentModel[]> =>
  prisma.document.findMany({
    where: { ownerId: userId },
    orderBy: { updatedAt: 'desc' },
  });

export const getSharedDocuments = async (userId: string): Promise<DocumentModel[]> =>
  prisma.document.findMany({
    where: { shares: { some: { userId } } },
    orderBy: { updatedAt: 'desc' },
  });

export const getDocumentById = async (userId: string, docId: string): Promise<DocumentModel | null> => {
  const document = await prisma.document.findUnique({ where: { id: docId } });

  if (!document) {
    return null;
  }

  // Sync Draft shares by link: opening someone else's document grants access and
  // records the share so it shows up under "Shared with me".
  if (document.ownerId !== userId) {
    // A viewer who has not created their profile yet cannot be recorded as a
    // share; they still get to read the document.
    const viewer = await prisma.user.findUnique({ where: { userId } });

    if (viewer) {
      await prisma.documentShare.upsert({
        where: { documentId_userId: { documentId: docId, userId } },
        create: { documentId: docId, userId },
        update: {},
      });
    }
  }

  return document;
};

export const createDocument = async (userId: string): Promise<DocumentModel> =>
  prisma.document.create({
    data: { ownerId: userId, title: 'Untitled', content: null },
  });

export const updateDocumentTitle = async (
  userId: string,
  docId: string,
  newTitle: string
): Promise<DocumentModel> => {
  await assertCanEdit(userId, docId);

  return prisma.document.update({
    where: { id: docId },
    data: { title: newTitle },
  });
};

export const updateDocument = async (docId: string, content: string): Promise<DocumentModel> =>
  prisma.document.update({
    where: { id: docId },
    data: { content },
  });

export const deleteDocumentById = async (userId: string, docId: string): Promise<void> => {
  const document = await prisma.document.findUnique({ where: { id: docId } });

  if (!document) {
    throw new NotFoundError('Document not found!');
  }

  if (document.ownerId !== userId) {
    throw new ForbiddenError('Only the owner can delete this document');
  }

  // Shares and merges cascade away with the row.
  await prisma.document.delete({ where: { id: docId } });
};

// Server-internal read used by the sync layer to seed a document's CRDT from
// whatever HTML was stored before. Access is already checked when the socket
// joins the room.
export const getDocumentContent = async (docId: string): Promise<string | null> => {
  const document = await prisma.document.findUnique({
    where: { id: docId },
    select: { content: true },
  });

  return document?.content ?? null;
};
