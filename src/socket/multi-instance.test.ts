import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { Redis } from 'ioredis';
import * as A from '@automerge/automerge';

import socketHandler from './index.js';
import { applyContentUpdate, SyncDoc } from './document-sync.js';
import { prisma } from '../config/prisma.js';

const TEST_REDIS_URI = process.env.TEST_REDIS_URI || 'redis://localhost:6379/15';

const verifyToken = async (token: string): Promise<string> => {
  if (!token.startsWith('good-token-')) throw new Error('invalid token');
  return token.replace('good-token-', '');
};

/**
 * One server process. On Vercel each Function instance is one of these, and a
 * client's connection is pinned to whichever instance accepted it — so two
 * collaborators routinely land on different ones.
 */
class Instance {
  http: HttpServer;
  io: SocketIOServer;
  redis: Redis;
  port = 0;

  constructor() {
    this.redis = new Redis(TEST_REDIS_URI);
    this.http = createServer();
    this.io = new SocketIOServer(this.http);
  }

  async start() {
    await socketHandler(this.io, this.redis, verifyToken);
    await new Promise<void>((resolve) => this.http.listen(0, () => resolve()));
    this.port = (this.http.address() as AddressInfo).port;
  }

  async stop() {
    this.io.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    await this.redis.quit();
  }
}

const instances: Instance[] = [];
const clients: Peer[] = [];

class Peer {
  socket: ClientSocket;
  doc: A.Doc<SyncDoc> = A.init<SyncDoc>();
  state: A.SyncState = A.initSyncState();

  constructor(userId: string, port: number) {
    this.socket = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      auth: { token: `good-token-${userId}` },
    });
    clients.push(this);

    this.socket.on('sync', (message: ArrayBuffer) => {
      const [doc, state] = A.receiveSyncMessage(this.doc, this.state, new Uint8Array(message));
      this.doc = doc;
      this.state = state;
      this.flush();
    });
  }

  async connected() {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', reject);
    });
  }

  join(docId: string) {
    this.socket.emit('join-doc', { docId });
  }

  flush() {
    const [state, message] = A.generateSyncMessage(this.doc, this.state);
    this.state = state;
    if (message) this.socket.emit('sync', message);
  }

  edit(content: string) {
    this.doc = applyContentUpdate(this.doc, content);
    this.flush();
  }

  get content() {
    return this.doc.content ?? '';
  }

  close() {
    this.socket.disconnect();
  }
}

let one: Instance;
let two: Instance;
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(TEST_REDIS_URI);
  one = new Instance();
  two = new Instance();
  instances.push(one, two);
  await one.start();
  await two.start();
});

afterAll(async () => {
  for (const instance of instances) await instance.stop();
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
  while (clients.length) clients.pop()?.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
});

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

const waitUntil = async (predicate: () => boolean, ms = 6000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('collaborators split across server instances', () => {
  it('delivers an edit made on one instance to a client on another', async () => {
    const docId = await seedDocument('auth0|alice', ['auth0|bob']);

    const alice = new Peer('auth0|alice', one.port);
    const bob = new Peer('auth0|bob', two.port);
    await Promise.all([alice.connected(), bob.connected()]);

    alice.join(docId);
    bob.join(docId);
    await new Promise((resolve) => setTimeout(resolve, 400));

    alice.edit('<p>written on instance one</p>');

    await waitUntil(() => bob.content === '<p>written on instance one</p>');
    expect(bob.content).toBe('<p>written on instance one</p>');
  });

  it('merges concurrent edits made on different instances', async () => {
    const docId = await seedDocument('auth0|alice', ['auth0|bob']);

    const alice = new Peer('auth0|alice', one.port);
    const bob = new Peer('auth0|bob', two.port);
    await Promise.all([alice.connected(), bob.connected()]);

    alice.join(docId);
    bob.join(docId);
    await new Promise((resolve) => setTimeout(resolve, 400));

    alice.edit('<p>intro</p><p>outro</p>');
    await waitUntil(() => bob.content === '<p>intro</p><p>outro</p>');

    alice.edit('<p>intro by alice</p><p>outro</p>');
    bob.edit('<p>intro</p><p>outro by bob</p>');

    await waitUntil(
      () =>
        alice.content.includes('by alice') &&
        alice.content.includes('by bob') &&
        alice.content === bob.content
    );

    expect(alice.content).toBe(bob.content);
  });

  it('shows a collaborator on one instance in the presence list of another', async () => {
    const docId = await seedDocument('auth0|alice', ['auth0|bob']);

    const alice = new Peer('auth0|alice', one.port);
    await alice.connected();
    const seen: string[][] = [];
    alice.socket.on('online-users', (users: string[]) => seen.push(users));
    alice.join(docId);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const bob = new Peer('auth0|bob', two.port);
    await bob.connected();
    bob.join(docId);

    await waitUntil(() => seen.some((users) => users.includes('auth0|bob')));
    expect(seen.at(-1)).toContain('auth0|bob');
  });
});
