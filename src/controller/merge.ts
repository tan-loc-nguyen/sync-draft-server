import { prisma } from '../config/prisma.js';
import { MergeModel } from '../generated/prisma/models.js';
import { assertCanEdit } from './document.js';

export interface CreateMergeInput {
  docId: string;
  mergedBy: string;
  before: string | null;
  after: string | null;
  description: string | null;
}

export const getMergesByDocId = async (docId: string): Promise<MergeModel[]> =>
  prisma.merge.findMany({
    where: { documentId: docId },
    orderBy: { mergedAt: 'desc' },
  });

export const createMerge = async (data: CreateMergeInput): Promise<MergeModel> => {
  await assertCanEdit(data.mergedBy, data.docId);

  return prisma.merge.create({
    data: {
      documentId: data.docId,
      mergedById: data.mergedBy,
      before: data.before,
      after: data.after,
      description: data.description,
    },
  });
};
