import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import * as A from '@automerge/automerge';

import { assertCanEdit, getDocumentContent, updateDocument } from '../controller/document.js';
import { createAuth0TokenVerifier, TokenVerifier } from './auth.js';
import { createDoc, SyncDoc } from './document-sync.js';

const roomOf = (docId: string) => `room_${docId}`;
const docKey = (docId: string) => `doc:${docId}`;

// Document changes are fanned out to the other server instances here. The
// Socket.IO adapter has its own channels; this one carries CRDT changes.
const CHANGE_CHANNEL = 'syncdraft:doc-changes';

// How long to batch document changes before writing them through to storage.
const PERSIST_DELAY_MS = 500;

// How long to wait before dropping someone from a document's presence list.
// Hosts that recycle connections (Vercel closes a socket when its Function
// reaches maximum duration) would otherwise make every collaborator blink out
// of the list and back on a timer.
const PRESENCE_GRACE_MS = Number(process.env.PRESENCE_GRACE_MS ?? 10_000);

interface ChangeBroadcast {
  docId: string;
  /** The instance that produced these changes, so it can ignore its own echo. */
  origin: string;
  changes: string[];
}

/**
 * Drops a user from a document's presence set, but only once none of their other
 * sockets remain in the room — including sockets held by other server
 * instances, which the Redis adapter makes `fetchSockets` aware of.
 * Returns true only if the user was actually removed.
 */
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
  // Identifies this server instance so it can ignore changes it published.
  const instanceId = randomUUID();

  // Rooms, broadcasts and fetchSockets only reach the sockets held by one
  // process unless every instance shares an adapter.
  //
  // Only subscribers need their own connection: a client in subscriber mode
  // cannot issue ordinary commands, while publishing is an ordinary command. So
  // `redis` doubles as the publisher for both channels and each instance costs
  // three connections rather than five — which matters on a hosted Redis with a
  // low connection ceiling.
  const adapterSub = redis.duplicate();
  const changeSub = redis.duplicate();
  io.adapter(createAdapter(redis, adapterSub));

  // This instance's working copy of each open document, plus one Automerge sync
  // state per connected socket. Sync state is per-peer by design: it records
  // what that particular peer is already known to have. A socket stays pinned
  // to the instance that accepted it, so keeping its state in memory is safe.
  const documents = new Map<string, A.Doc<SyncDoc>>();
  const peers = new Map<string, Map<string, { socket: Socket; state: A.SyncState }>>();
  const pendingSaves = new Map<string, NodeJS.Timeout>();
  const presenceTimers = new Map<string, NodeJS.Timeout>();

  const loadDocument = async (docId: string): Promise<A.Doc<SyncDoc>> => {
    const cached = documents.get(docId);
    if (cached) return cached;

    let saved = await redis.getBuffer(docKey(docId));

    if (!saved) {
      // A document opened for the first time since the CRDT rollout is seeded
      // from the HTML already in Postgres, so nothing written earlier is lost.
      //
      // Exactly one instance may do this. Two instances each calling createDoc
      // would produce documents with no common ancestor, and changes from one
      // could never apply to the other — the very collision this whole design
      // exists to avoid. SET NX picks a single winner; everyone else adopts the
      // winner's document.
      const seeded = createDoc((await getDocumentContent(docId)) ?? '');
      const won = await redis.set(docKey(docId), Buffer.from(A.save(seeded)), 'NX');

      if (won) {
        documents.set(docId, seeded);
        return seeded;
      }

      saved = await redis.getBuffer(docKey(docId));
    }

    const doc = A.load<SyncDoc>(new Uint8Array(saved!));
    documents.set(docId, doc);
    return doc;
  };

  const persist = async (docId: string) => {
    const local = documents.get(docId);
    if (!local) return;

    try {
      // Another instance may have written since this copy was loaded. Merging
      // what is stored into the local copy before saving means a concurrent
      // write adds to the document rather than replacing it.
      const stored = await redis.getBuffer(docKey(docId));
      const merged = stored ? A.merge(A.load<SyncDoc>(new Uint8Array(stored)), local) : local;

      documents.set(docId, merged);

      // Redis holds the full CRDT (history included); Postgres keeps the
      // rendered HTML so listings and first loads stay cheap.
      await redis.set(docKey(docId), Buffer.from(A.save(merged)));
      await updateDocument(docId, merged.content ?? '');
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

  const pushToLocalPeers = (docId: string, exceptSocketId?: string) => {
    peersFor(docId).forEach((peer, id) => {
      if (id !== exceptSocketId) pushTo(docId, peer);
    });
  };

  const publishChanges = (docId: string, changes: A.Change[]) => {
    if (!changes.length) return;

    const payload: ChangeBroadcast = {
      docId,
      origin: instanceId,
      changes: changes.map((change) => Buffer.from(change).toString('base64')),
    };

    redis.publish(CHANGE_CHANNEL, JSON.stringify(payload)).catch((error) => {
      console.error(`[Error] publish changes doc[${docId}]: ${error}`);
    });
  };

  await changeSub.subscribe(CHANGE_CHANNEL);
  changeSub.on('message', (_channel: string, raw: string) => {
    try {
      const payload = JSON.parse(raw) as ChangeBroadcast;

      // Our own changes have already been applied locally.
      if (payload.origin === instanceId) return;

      const current = documents.get(payload.docId);
      // Nobody here is in that document, so there is nothing to update. The
      // changes are still in Redis for whenever it is next opened.
      if (!current) return;

      const [updated] = A.applyChanges(
        current,
        payload.changes.map((change) => new Uint8Array(Buffer.from(change, 'base64')))
      );

      documents.set(payload.docId, updated);
      pushToLocalPeers(payload.docId);
      schedulePersist(payload.docId);
    } catch (error) {
      console.error(`[Error] applying broadcast changes: ${error}`);
    }
  });

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

    socket.on('join-doc', async ({ docId }: { docId: string }) => {
      try {
        // Reading a document is open to anyone with the link, but editing it
        // through the socket is not.
        await assertCanEdit(userId, docId);

        const room = roomOf(docId);
        socket.join(room);
        socket.data.docId = docId;

        // Back from a recycled connection within the grace window: cancel the
        // pending removal so other collaborators never saw them leave.
        const presenceKey = `${room}|${userId}`;
        const pending = presenceTimers.get(presenceKey);
        if (pending) {
          clearTimeout(pending);
          presenceTimers.delete(presenceKey);
        }

        await redis.sadd(room, userId);

        await loadDocument(docId);
        const entry = { socket, state: A.initSyncState() };
        peersFor(docId).set(socket.id, entry);

        // Hand the newcomer the document's history; from here both sides share
        // an ancestor, which is what makes later merges meaningful.
        pushTo(docId, entry);

        const usersInDoc = await redis.smembers(room);
        io.to(room).emit('online-users', usersInDoc);
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
        const entry = peersFor(docId).get(socket.id);
        if (!entry) return;

        const current = await loadDocument(docId);
        const [updated, nextState] = A.receiveSyncMessage(
          current,
          entry.state,
          new Uint8Array(message as ArrayBuffer)
        );

        documents.set(docId, updated);
        entry.state = nextState;

        // Answer the sender, then bring every other peer here up to date.
        pushTo(docId, entry);
        pushToLocalPeers(docId, socket.id);

        // Collaborators are routinely spread across instances, so anything new
        // has to reach the others too.
        publishChanges(docId, A.getChanges(current, updated));

        schedulePersist(docId);
      } catch (error) {
        console.error(`[Error] sync | ${docId}: ${error}`);
      }
    });

    const leave = async (docId: string | undefined) => {
      if (!docId) return;

      const room = roomOf(docId);
      const socketId = socket.id;
      socket.leave(room);
      peers.get(docId)?.delete(socketId);

      if (peers.get(docId)?.size === 0) {
        peers.delete(docId);
        await persist(docId);
        documents.delete(docId);
      }

      // Hold the presence entry briefly: a recycled connection is back within
      // seconds, and evicting immediately would flash them out of everyone's
      // collaborator list on a timer.
      const presenceKey = `${room}|${userId}`;
      clearTimeout(presenceTimers.get(presenceKey));
      presenceTimers.set(
        presenceKey,
        setTimeout(async () => {
          presenceTimers.delete(presenceKey);

          try {
            const removed = await releasePresence(io, redis, room, userId, socketId);

            if (removed) {
              const usersInDoc = await redis.smembers(room);
              io.to(room).emit('online-users', usersInDoc);
            }
          } catch (error) {
            console.error(`[Error] presence release | ${docId}: ${error}`);
          }
        }, PRESENCE_GRACE_MS)
      );
    };

    socket.on('leave-doc', async ({ docId }: { docId: string }) => {
      try {
        await leave(docId);
      } catch (error) {
        console.error(`[Error] leave-doc | ${docId}: ${error}`);
      }
    });

    socket.on('disconnect', async () => {
      try {
        await leave(socket.data.docId as string | undefined);
      } catch (error) {
        console.error(`[Error] disconnect | ${socket.id}: ${error}`);
      }
    });
  });
};
