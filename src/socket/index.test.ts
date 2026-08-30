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


// Stands in for Auth0 so these tests stay off the network. Identity is taken
// from the token, exactly as in production.
const verifyToken = async (token: string): Promise<string> => {
  if (!token.startsWith('good-token-')) throw new Error('invalid token');
  return token.replace('good-token-', '');
};

// Dedicated Redis logical db so tests can flush freely without touching dev data.
const TEST_REDIS_URI = process.env.TEST_REDIS_URI || 'redis://localhost:6379/15';

let httpServer: HttpServer;
let io: SocketIOServer;
let redis: Redis;
let port: number;

const clients: ClientSocket[] = [];

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

afterEach(async () => {
  while (clients.length) {
    clients.pop()?.disconnect();
  }
  await delay(100);
});

async function connect(userId: string): Promise<ClientSocket> {
  const socket = ioClient(`http://localhost:${port}`, {
    transports: ['websocket'],
    forceNew: true,
    auth: { token: `good-token-${userId}` },
  });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}

function waitFor<T>(socket: ClientSocket, event: string, ms = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function receivedWithin(socket: ClientSocket, event: string, ms = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.once(event, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('leave-doc', () => {
  it('stops delivering room broadcasts to a client after it leaves the document', async () => {
    const docId = await seedDocument('user-alice', ['user-bob', 'user-carol']);

    const alice = await connect('user-alice');
    alice.emit('join-doc', { docId });
    await waitFor(alice, 'online-users');

    const bob = await connect('user-bob');
    bob.emit('join-doc', { docId });
    await waitFor(bob, 'online-users');

    bob.emit('leave-doc', { docId });
    await delay(250);

    // A third user joining triggers io.to(room).emit('online-users'), which
    // reaches every socket still in the room. Bob has left, so it must not reach him.
    const bobStillReceivesRoomTraffic = receivedWithin(bob, 'online-users');

    const carol = await connect('user-carol');
    carol.emit('join-doc', { docId });
    await waitFor(carol, 'online-users');

    expect(await bobStillReceivesRoomTraffic).toBe(false);
  });
});

describe('presence', () => {
  it('keeps a user present while they still have another socket in the document', async () => {
    const docId = await seedDocument('user-alice');

    const tabOne = await connect('user-alice');
    tabOne.emit('join-doc', { docId });
    await waitFor(tabOne, 'online-users');

    const tabTwo = await connect('user-alice');
    tabTwo.emit('join-doc', { docId });
    await waitFor(tabTwo, 'online-users');

    // Closing one tab must not evict Alice: she is still reading in the other.
    tabOne.disconnect();
    await delay(350);

    expect(await redis.smembers(`room_${docId}`)).toContain('user-alice');
  });

  it('removes a user once their last socket in the document disconnects', async () => {
    const docId = await seedDocument('user-alice');

    const tabOne = await connect('user-alice');
    tabOne.emit('join-doc', { docId });
    await waitFor(tabOne, 'online-users');

    const tabTwo = await connect('user-alice');
    tabTwo.emit('join-doc', { docId });
    await waitFor(tabTwo, 'online-users');

    tabOne.disconnect();
    await delay(250);
    tabTwo.disconnect();
    await delay(350);

    expect(await redis.smembers(`room_${docId}`)).not.toContain('user-alice');
  });
});
