import { PrismaPg } from '@prisma/adapter-pg';
import './env.js';

import { PrismaClient } from '../generated/prisma/client.js';

// Prisma 7 requires a driver adapter rather than a connection string on the client.
export const createPrismaClient = (connectionString: string = process.env.DATABASE_URL || '') =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

export const prisma = createPrismaClient();

async function connectPrisma(): Promise<PrismaClient> {
  try {
    await prisma.$connect();
    console.log('[DB] Connected to PostgreSQL');
    return prisma;
  } catch (error) {
    console.error('[DB] Error connecting to PostgreSQL:', error);
    process.exit();
  }
}

export default connectPrisma;
