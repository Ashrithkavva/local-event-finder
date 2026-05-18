# Local Event Finder

Full-stack event discovery and booking app with real-time seat availability across clients.

> Two browser windows on the same event. Click a seat in one — it locks in the other instantly. That's the demo.

[![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF?logo=github-actions&logoColor=white)](.github/workflows/ci.yml) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white) ![Node](https://img.shields.io/badge/Node-20-339933?logo=node.js&logoColor=white) ![Postgres](https://img.shields.io/badge/Postgres-16-4169E1?logo=postgresql&logoColor=white) ![Mongo](https://img.shields.io/badge/MongoDB-7-47A248?logo=mongodb&logoColor=white) ![GraphQL](https://img.shields.io/badge/GraphQL-Apollo-E10098?logo=graphql&logoColor=white)

---

## Tech stack

| Layer | Tech |
| --- | --- |
| Frontend | Next.js · React · TypeScript · Apollo Client |
| Realtime | Native WebSocket (`ws`) — separate channel from GraphQL |
| API | Express · Apollo Server v4 · GraphQL · DataLoader |
| Validation | zod schemas at every resolver edge |
| Stores | Postgres (transactional) · MongoDB (content + audit) |
| Logging | pino with per-request IDs |
| Tests | Jest — unit suite (mocks) + integration suite (real PG + Mongo) |
| CI | GitHub Actions running lint, typecheck, unit, and integration on every push |
| Deploy | Multi-stage Dockerfile, non-root runtime, health check |

## Architecture

```
┌──────────────────┐    GraphQL / HTTP    ┌────────────────────────┐
│  Next.js Client  │ ───────────────────► │  Express + Apollo      │
│  (React + TS)    │                      │  GraphQL Server        │
│                  │ ◄──── WebSocket ─────│  + ws Seat Hub         │
└──────────────────┘   seat updates (/ws) └────────────┬───────────┘
                                                       │
                                         ┌─────────────┴────────────┐
                                         ▼                          ▼
                                ┌──────────────────┐      ┌──────────────────┐
                                │   PostgreSQL     │      │     MongoDB      │
                                │ events / seats / │      │ event details,   │
                                │ bookings         │      │ reviews, audit   │
                                └──────────────────┘      └──────────────────┘
```

A single booking traverses both stores inside one logical transaction. See [docs/DESIGN.md §3](docs/DESIGN.md#3-cross-database-transaction-what-we-guarantee-and-what-we-dont) for the guarantees and the known failure window.

## Highlights

- **Real concurrent-booking safety.** The integration test fires 10 parallel `bookSeats` calls at one seat and asserts exactly one succeeds — proven against actual Postgres, not mocks.
- **No N+1.** Per-request DataLoaders collapse the event list into one Mongo `find` and one Postgres `GROUP BY`, regardless of event count.
- **Pay-for-what-you-ask-for fetching.** Mongo isn't touched when the client only requests PG-backed columns. Reviews aren't fetched when the client only wants the count. The schema controls the work.
- **Stable error codes.** Typed `AppError` subclasses surface as `extensions.code = 'SEAT_HELD_BY_OTHER' | 'BAD_USER_INPUT' | ...` on every failed mutation, so the client can branch on machine-readable values.
- **Per-request log correlation.** Every HTTP request gets a ULID; the same ID is on every log line emitted while handling that request, including booking events.

## Repository layout

```
local-event-finder/
├── .github/workflows/ci.yml          # lint · typecheck · unit · integration on every push
├── docker-compose.yml                # Postgres + Mongo for local dev
├── docs/DESIGN.md                    # tradeoffs and decisions
├── server/
│   ├── Dockerfile                    # multi-stage prod image, non-root user
│   ├── src/
│   │   ├── index.ts                  # Express + Apollo + WebSocket + pino bootstrap
│   │   ├── logger.ts                 # pino instance
│   │   ├── errors.ts                 # AppError class hierarchy with stable codes
│   │   ├── validation.ts             # zod schemas at the resolver edge
│   │   ├── context.ts                # GraphQL context shape
│   │   ├── loaders.ts                # per-request DataLoaders
│   │   ├── db/{postgres,mongo,health,seed}.ts
│   │   ├── graphql/{typeDefs,resolvers}.ts
│   │   ├── services/bookingService.ts  # cross-DB transaction
│   │   ├── websocket/seatHub.ts        # per-event broadcast hub
│   │   └── __tests__/
│   │       ├── bookingService.test.ts              # unit (mocked DBs)
│   │       └── bookingService.integration.test.ts  # real PG + Mongo
└── client/
    └── src/
        ├── pages/index.tsx           # event list
        ├── pages/events/[id].tsx     # detail + seat picker + live updates
        ├── components/SeatMap.tsx    # seat grid
        ├── components/ErrorBoundary.tsx
        ├── lib/apollo.ts             # Apollo Client
        └── lib/useSeatSocket.ts      # WS hook with auto-reconnect
```

## Run it locally

Prerequisites: Node 20+ and Docker.

```bash
# 1. Databases
docker compose up -d

# 2. Server
cd server
cp .env.example .env
npm install
npm run seed                 # creates schema + sample events
npm run dev                  # http://localhost:4000/graphql

# 3. Client (new terminal)
cd client
cp .env.local.example .env.local
npm install
npm run dev                  # http://localhost:3000
```

Open the same event in two browser windows. Click a seat, book it, and the other window updates without a refresh.

## Tests

```bash
cd server

npm test                     # unit suite — 4 tests, ~6s, mocks both DBs
npm run test:integration     # real PG + Mongo, includes the 10-way concurrent booking test
npm run test:all             # both
```

The integration suite is the headline. From `bookingService.integration.test.ts`:

```ts
test('concurrent bookings of the same seat: exactly one succeeds', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      bookSeats({ eventId, seatIds: [seatId], userId: `user-${i}` })
    )
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  // ...losers must all be SEAT_HELD_BY_OTHER, DB ends up with one booking + one audit doc
});
```

## CI

`.github/workflows/ci.yml` runs on every push and PR:

| Job | Steps |
| --- | --- |
| **server** | `npm ci` · `lint` · `typecheck` · `test` · `test:integration` against `postgres:16` and `mongo:7` service containers |
| **client** | `npm ci` · `lint` · `typecheck` · `build` |

A failing test or a type error blocks the merge.

## Deploy

### Docker (server)

```bash
cd server
docker build -t local-event-finder-server .
docker run --rm -p 4000:4000 --env-file .env local-event-finder-server
```

Multi-stage build: TypeScript compiles in a builder image; only `dist/` and prod deps ship in the runtime image. Runs as a non-root user with a `HEALTHCHECK` against `/health`.

### Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/local-event-finder.git
git push -u origin main
```

CI runs automatically once it's pushed. The badge at the top of this README links to the workflow.

## Design

For the tradeoffs behind these choices — two databases vs one, DataLoader vs hand-shaped JSON, raw WebSockets vs GraphQL Subscriptions, the cross-DB consistency limitations — see [docs/DESIGN.md](docs/DESIGN.md).
