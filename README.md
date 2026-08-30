# Sync Draft — server

Realtime collaboration backend for Sync Draft: an Express + Socket.IO service
that syncs documents as Automerge CRDTs, backed by PostgreSQL and Redis.

## How it fits together

| Piece | Role |
|---|---|
| **PostgreSQL** (Prisma) | Durable store: users, documents, share links, merge history |
| **Redis** | Live document CRDT (binary) plus the per-document presence set |
| **Socket.IO** | Authenticated realtime channel running the Automerge sync protocol |
| **Auth0** | Issues the JWTs that guard both the REST API and the socket handshake |

### Document sync

A document is one Automerge doc. Clients hold their own replica and exchange
`generateSyncMessage` / `receiveSyncMessage` payloads with the server over the
`sync` socket event. Because every replica descends from the same history,
concurrent edits merge rather than overwrite.

Edits reach the CRDT as the smallest splice that explains the change
(`applyContentUpdate` in `src/socket/document-sync.ts`), so two people typing in
different paragraphs both keep their work.

Redis holds the authoritative CRDT including history; PostgreSQL keeps the
rendered HTML so document listings and first loads stay cheap.

### Authorization

- REST routes sit behind `express-oauth2-jwt-bearer`.
- The socket handshake is verified separately (`src/socket/auth.ts`) — Socket.IO
  never passes through Express middleware. Identity always comes from the
  verified token, never from a client-supplied payload.
- Reading a document is open to anyone with the link (opening one records the
  share). Editing requires being the owner or a collaborator; **deleting is
  owner-only**.

## Getting started

```bash
yarn install
cp .env.example .env      # then fill in the Auth0 values
docker compose up -d      # PostgreSQL + Redis
npx prisma migrate deploy
yarn dev
```

The server refuses to start without `AUTH0_DOMAIN` and `AUTH0_AUDIENCE`.

## Scripts

| Command | Purpose |
|---|---|
| `yarn dev` | Watch mode via tsx |
| `yarn build` | Type-check and emit to `dist/` |
| `yarn start` | Run the built server |
| `yarn test` | Vitest (needs the Docker services running) |
| `yarn lint` | ESLint |

## Testing

Tests run against the real containers, not mocks: a dedicated `syncdraft_test`
database and Redis logical db 15. Create the test database once with

```bash
docker exec syncdraft_postgres psql -U syncdraft -d syncdraft -c "CREATE DATABASE syncdraft_test;"
DATABASE_URL="postgresql://syncdraft:syncdraft@localhost:5432/syncdraft_test?schema=public" npx prisma migrate deploy
```
