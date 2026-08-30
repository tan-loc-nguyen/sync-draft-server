/**
 * Vercel entrypoint.
 *
 * Vercel imports the HTTP server and owns the listening socket itself, so this
 * builds the app and exports it rather than calling listen(). Local development
 * still goes through src/index.ts, which binds a port.
 *
 * A catch-all rewrite in vercel.json sends every request here, so Express and
 * Socket.IO both see the paths they expect (/api/... and /socket.io/...).
 */
import { SyncServer } from '../src/server.js';

const syncServer = new SyncServer();

export default await syncServer.build();
