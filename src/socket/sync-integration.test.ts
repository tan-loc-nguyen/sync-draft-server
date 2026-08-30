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

let httpServer: HttpServer;
let io: SocketIOServer;
let redis: Redis;
let port: number;

beforeAll(async () => {
  redis = new Redis(TEST_REDIS_URI);
  httpServer = createServer();
  io = new SocketIOServer(httpServer, { maxHttpBufferSize: 1e8 });
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

const openClients: TestClient[] = [];

afterEach(() => {
  while (openClients.length) openClients.pop()?.close();
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

/**
 * A minimal client-side peer: holds an Automerge document and speaks the same
 * sync protocol the browser does. Exercising the server through this proves the
 * whole exchange, not just the pure merge helpers.
 */
class TestClient {
  socket: ClientSocket;
  doc: A.Doc<SyncDoc> = A.init<SyncDoc>();
  state: A.SyncState = A.initSyncState();

  constructor(userId: string) {
    this.socket = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      auth: { token: `good-token-${userId}` },
    });
    openClients.push(this);

    this.socket.on('sync', (message: ArrayBuffer) => {
      const [doc, state] = A.receiveSyncMessage(this.doc, this.state, new Uint8Array(message));
      this.doc = doc;
      this.state = state;
      this.flush();
    });
  }

  async connected(): Promise<void> {
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

const waitUntil = async (predicate: () => boolean, ms = 4000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('document sync over sockets', () => {
  it('gives a joining client the document content that already exists', async () => {
    const docId = await seedDocument('auth0|alice', ['auth0|bob']);

    const alice = new TestClient('auth0|alice');
    await alice.connected();
    alice.join(docId);
    await new Promise((resolve) => setTimeout(resolve, 200));

    alice.edit('<p>first draft</p>');
    await waitUntil(() => alice.content === '<p>first draft</p>');

    // Bob arrives afterwards and must receive the text purely through sync.
    const bob = new TestClient('auth0|bob');
    await bob.connected();
    bob.join(docId);

    await waitUntil(() => bob.content === '<p>first draft</p>');
    expect(bob.content).toBe('<p>first draft</p>');
  });

  it('propagates one client\'s edit to another in the same document', async () => {
    const docId = await seedDocument('auth0|alice', ['auth0|bob']);

    const alice = new TestClient('auth0|alice');
    const bob = new TestClient('auth0|bob');
    await Promise.all([alice.connected(), bob.connected()]);

    alice.join(docId);
    bob.join(docId);
    await new Promise((resolve) => setTimeout(resolve, 300));

    alice.edit('<p>hello from alice</p>');

    await waitUntil(() => bob.content === '<p>hello from alice</p>');
    expect(bob.content).toBe('<p>hello from alice</p>');
  });

  // The behaviour the original implementation got wrong: it rebuilt both
  // documents from scratch on every keystroke, so one edit overwrote the other.
  it('keeps both edits when two clients type at the same time', async () => {
    const docId = await seedDocument('auth0|alice', ['auth0|bob']);

    const alice = new TestClient('auth0|alice');
    const bob = new TestClient('auth0|bob');
    await Promise.all([alice.connected(), bob.connected()]);

    alice.join(docId);
    bob.join(docId);
    await new Promise((resolve) => setTimeout(resolve, 300));

    alice.edit('<p>intro</p><p>conclusion</p>');
    await waitUntil(() => bob.content === '<p>intro</p><p>conclusion</p>');

    // Both edit their own paragraph before either has heard from the other.
    alice.edit('<p>intro by alice</p><p>conclusion</p>');
    bob.edit('<p>intro</p><p>conclusion by bob</p>');

    await waitUntil(
      () =>
        alice.content.includes('by alice') &&
        alice.content.includes('by bob') &&
        alice.content === bob.content
    );

    expect(alice.content).toBe(bob.content);
    expect(alice.content).toContain('by alice');
    expect(alice.content).toContain('by bob');
  });

  it('refuses to sync a document the user has no access to', async () => {
    const docId = await seedDocument('auth0|alice');
    await prisma.user.create({ data: { userId: 'auth0|stranger', email: 's@test.dev' } });

    const stranger = new TestClient('auth0|stranger');
    await stranger.connected();

    const refused = new Promise<string>((resolve) => {
      stranger.socket.once('doc-error', (payload: { message: string }) => resolve(payload.message));
    });
    stranger.join(docId);

    await expect(refused).resolves.toMatch(/do not have access/i);
    expect(await redis.smembers(`room_${docId}`)).not.toContain('auth0|stranger');
  });
});
