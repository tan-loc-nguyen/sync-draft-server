import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { Redis } from 'ioredis';

import socketHandler from './index.js';
import { prisma } from '../config/prisma.js';

// join-doc now enforces access, so these tests need documents that really
// exist and users who are really allowed to edit them.
const seedDocument = async (ownerId: string, collaborators: string[] = []): Promise<string> => {
  await prisma.user.upsert({
    where: { userId: ownerId },
    create: { userId: ownerId, email: `${ownerId}@test.dev` },
    update: {},
  });
  const doc = await prisma.document.create({ data: { ownerId, title: 'Test', content: '' } });

  for (const userId of collaborators) {
    await prisma.user.upsert({
      where: { userId },
      create: { userId, email: `${userId}@test.dev` },
      update: {},
    });
    await prisma.documentShare.create({ data: { documentId: doc.id, userId } });
  }

  return doc.id;
};


const TEST_REDIS_URI = process.env.TEST_REDIS_URI || 'redis://localhost:6379/15';

let httpServer: HttpServer;
let io: SocketIOServer;
let redis: Redis;
let port: number;
const clients: ClientSocket[] = [];

// Stands in for Auth0: "good-token-<user>" verifies as that user, anything else
// is rejected. Keeps the tests off the network while exercising the real gate.
const verifyToken = async (token: string): Promise<string> => {
  if (!token.startsWith('good-token-')) {
    throw new Error('invalid token');
  }
  return token.replace('good-token-', '');
};

beforeAll(async () => {
  redis = new Redis(TEST_REDIS_URI);
  httpServer = createServer();
  io = new SocketIOServer(httpServer);
  await socketHandler(io, redis, verifyToken);
  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await redis.quit();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await redis.flushdb();
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "merges","document_shares","documents","users" RESTART IDENTITY CASCADE'
  );
});

afterEach(() => {
  while (clients.length) clients.pop()?.disconnect();
});

const connect = (auth?: Record<string, string>): Promise<ClientSocket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      auth,
    });
    clients.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('socket authentication', () => {
  it('rejects a connection with no token', async () => {
    await expect(connect()).rejects.toThrow(/auth/i);
  });

  it('rejects a connection whose token does not verify', async () => {
    await expect(connect({ token: 'forged' })).rejects.toThrow(/auth/i);
  });

  it('accepts a connection carrying a valid token', async () => {
    const socket = await connect({ token: 'good-token-auth0|alice' });

    expect(socket.connected).toBe(true);
  });

  // The old handler took `userId` straight from the join payload, so any client
  // could claim to be anyone. Identity must come from the verified token.
  it('ignores a spoofed userId in the join payload', async () => {
    const socket = await connect({ token: 'good-token-auth0|alice' });
    const docId = await seedDocument('auth0|alice');

    socket.emit('join-doc', { docId, userId: 'auth0|victim' });
    await delay(300);

    expect(await redis.smembers(`room_${docId}`)).toEqual(['auth0|alice']);
  });
});
