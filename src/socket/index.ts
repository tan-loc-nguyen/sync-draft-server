import { Redis } from 'ioredis';
import { Server, Socket } from 'socket.io';
import * as A from '@automerge/automerge';

import { assertCanEdit, getDocumentContent, updateDocument } from '../controller/document.js';
import { createAuth0TokenVerifier, TokenVerifier } from './auth.js';
import { createDoc, SyncDoc } from './document-sync.js';

const roomOf = (docId: string) => `room_${docId}`;
const docKey = (docId: string) => `doc:${docId}`;

// How long to batch document changes before writing them through to storage.
const PERSIST_DELAY_MS = 500;

// Drops a user from a document's presence set, but only once none of their other
// sockets remain in the room. A user can hold several sockets at once (multiple
// tabs), and closing one must not evict them from the document.
// Returns true only if the user was actually removed.
const releasePresence = async (
  io: Server,
  redis: Redis,
  room: string,
  userId: string,
  leavingSocketId: string
): Promise<boolean> => {
  const socketsInRoom = await io.in(room).fetchSockets();
  const stillConnectedElsewhere = socketsInRoom.some(
    (s) => s.id !== leavingSocketId && s.data.userId === userId
  );

  if (stillConnectedElsewhere) {
    return false;
  }

  return (await redis.srem(room, userId)) > 0;
};

export default async (
  io: Server,
  redis: Redis,
  verifyToken: TokenVerifier = createAuth0TokenVerifier()
) => {
  // Working copy of every open document, plus one Automerge sync state per
  // connected socket. Sync state is per-peer by design: it records what that
  // particular peer is already known to have.
  const documents = new Map<string, A.Doc<SyncDoc>>();
  const peers = new Map<string, Map<string, { socket: Socket; state: A.SyncState }>>();
  const pendingSaves = new Map<string, NodeJS.Timeout>();

  const loadDocument = async (docId: string): Promise<A.Doc<SyncDoc>> => {
    const cached = documents.get(docId);
    if (cached) return cached;

    const saved = await redis.getBuffer(docKey(docId));

    // A document opened for the first time since the CRDT rollout is seeded
    // from the HTML already in Postgres, so nothing written earlier is lost.
    const doc = saved
      ? A.load<SyncDoc>(new Uint8Array(saved))
      : createDoc((await getDocumentContent(docId)) ?? '');

    documents.set(docId, doc);
    return doc;
  };

  const persist = async (docId: string) => {
    const doc = documents.get(docId);
    if (!doc) return;

    try {
      // Redis holds the full CRDT (history included); Postgres keeps the
      // rendered HTML so listings and first loads stay cheap.
      await redis.set(docKey(docId), Buffer.from(A.save(doc)));
      await updateDocument(docId, doc.content ?? '');
    } catch (error) {
      console.error(`[Error] persist doc[${docId}]: ${error}`);
    }
  };

  const schedulePersist = (docId: string) => {
    if (pendingSaves.has(docId)) return;

    pendingSaves.set(
      docId,
      setTimeout(async () => {
        pendingSaves.delete(docId);
        await persist(docId);
      }, PERSIST_DELAY_MS)
    );
  };

  const peersFor = (docId: string) => {
    let group = peers.get(docId);
    if (!group) {
      group = new Map();
      peers.set(docId, group);
    }
    return group;
  };

  // Pushes whatever `entry.socket` is still missing of the document. Does
  // nothing when that peer is already up to date.
  const pushTo = (docId: string, entry: { socket: Socket; state: A.SyncState }) => {
    const doc = documents.get(docId);
    if (!doc) return;

    const [nextState, message] = A.generateSyncMessage(doc, entry.state);
    entry.state = nextState;

    if (message) {
      entry.socket.emit('sync', message);
    }
  };

  // Socket.IO never runs Express middleware, so the handshake is authenticated
  // here. Identity comes from the verified token and is never taken from a
  // client-supplied payload.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication required'));
    }

    try {
      socket.data.userId = await verifyToken(token);
      next();
    } catch (error) {
      console.error(`[Socket] Authentication failed for ${socket.id}: ${error}`);
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.data.userId as string;
    console.log(`[Socket] ${socket.id} connected as ${userId}`);

    socket.on('join-doc', async ({ docId }: { docId: string }) => {
      try {
        // Reading a document is open to anyone with the link, but editing it
        // through the socket is not.
        await assertCanEdit(userId, docId);

        const room = roomOf(docId);
        socket.join(room);
        socket.data.docId = docId;

        await redis.sadd(room, userId);

        await loadDocument(docId);
        const entry = { socket, state: A.initSyncState() };
        peersFor(docId).set(socket.id, entry);

        // Hand the newcomer the document's history; from here both sides share
        // an ancestor, which is what makes later merges meaningful.
        pushTo(docId, entry);

        const usersInDoc = await redis.smembers(room);
        io.to(room).emit('online-users', usersInDoc);

        console.log(`[Socket] ${userId} joined ${room} (${usersInDoc.length} online)`);
      } catch (error) {
        console.error(`[Error] join-doc | ${docId}: ${error}`);
        socket.emit('doc-error', { message: 'You do not have access to this document' });
      }
    });

    // One step of the Automerge sync protocol. Replaces the old "broadcast the
    // whole document as a string" approach, which could not merge concurrent
    // edits because each side rebuilt its document from scratch.
    socket.on('sync', async (message: ArrayBuffer | Uint8Array) => {
      const docId = socket.data.docId as string | undefined;
      if (!docId) return;

      try {
        const group = peersFor(docId);
        const entry = group.get(socket.id);
        if (!entry) return;

        const current = await loadDocument(docId);
        const [updated, nextState] = A.receiveSyncMessage(
          current,
          entry.state,
          new Uint8Array(message as ArrayBuffer)
        );

        documents.set(docId, updated);
        entry.state = nextState;

        // Answer the sender, then bring every other peer in the room up to date.
        pushTo(docId, entry);
        group.forEach((peer, id) => {
          if (id !== socket.id) pushTo(docId, peer);
        });

        schedulePersist(docId);
      } catch (error) {
        console.error(`[Error] sync | ${docId}: ${error}`);
      }
    });

    const leave = async (docId: string | undefined) => {
      if (!docId) return;

      const room = roomOf(docId);
      socket.leave(room);
      peers.get(docId)?.delete(socket.id);

      const removed = await releasePresence(io, redis, room, userId, socket.id);

      if (removed) {
        const usersInDoc = await redis.smembers(room);
        socket.broadcast.to(room).emit('online-users', usersInDoc);
      }

      // Nobody left in the room: flush and drop the working copy.
      if (peers.get(docId)?.size === 0) {
        peers.delete(docId);
        await persist(docId);
        documents.delete(docId);
      }
    };

    socket.on('leave-doc', async ({ docId }: { docId: string }) => {
      try {
        await leave(docId);
        console.log(`[Socket] ${userId} left ${roomOf(docId)}`);
      } catch (error) {
        console.error(`[Error] leave-doc | ${docId}: ${error}`);
      }
    });

    socket.on('disconnect', async () => {
      try {
        await leave(socket.data.docId as string | undefined);
        console.log(`[Socket] ${socket.id} disconnected`);
      } catch (error) {
        console.error(`[Error] disconnect | ${socket.id}: ${error}`);
      }
    });
  });
};
