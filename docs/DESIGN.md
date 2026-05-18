# Design Decisions

A short tour of the non-obvious choices in this codebase and the tradeoffs behind them. Everything in here is the kind of thing I'd want to be able to defend in code review.

## 1. Why two databases?

Different access patterns, different stores:

- **Postgres** holds anything that needs transactional integrity: `events`, `seats`, `bookings`. Row-level locking is the only realistic way to prevent double-booking, and that requires a relational engine with `SELECT ... FOR UPDATE`.
- **Mongo** holds flexible-schema content: event descriptions, categories, reviews, and the booking audit log. Reviews are append-mostly, vary in shape, and never need to be joined transactionally with seat state.

A single Postgres would also work for this scale; using both is a deliberate exercise in cross-store coordination, which is the more interesting engineering problem.

## 2. Why GraphQL field resolvers over hand-shaped JSON?

The first cut of this resolver fanned out from a root resolver — for each event, run a Mongo find and a Postgres count. That's N Mongo queries and N Postgres queries for a list of N events, and it pays the Mongo cost even when the client only asked for the name and date.

The current shape resolves only the PG columns at the root and pushes everything else into field resolvers backed by DataLoader. Two real wins:

- **No N+1.** DataLoader batches every `eventDetailsLoader.load(id)` call inside one request into a single `find({ eventId: { $in: ids } })`. Same for `availableSeatsLoader` — one PG `GROUP BY` query.
- **Pay for what you ask for.** The home page query asks for `name, venue, eventDate, totalSeats, availableSeats, category`. The Mongo loader fires; the reviews loader never does. The detail page asks for reviews; only then does that work happen.

This is the central reason GraphQL beats a hand-rolled REST endpoint here: the schema controls the fetching, not the endpoint shape.

## 3. Cross-database transaction: what we guarantee and what we don't

`bookSeats` is the one place data crosses both stores. The sequence is:

```
PG BEGIN
PG SELECT ... FOR UPDATE on target seats   ← serializes concurrent callers
PG UPDATE seats SET is_booked = TRUE
PG INSERT bookings
Mongo insertOne(booking_audit)
PG COMMIT
```

If any step before COMMIT throws, the PG transaction rolls back. Specifically: if the Mongo audit insert fails, the seats stay free and no booking row exists. That's the property the integration test in `bookingService.integration.test.ts` proves with 10 parallel callers fighting over one seat.

**The remaining failure window** is PG COMMIT failing *after* Mongo audit insert succeeded. Postgres and Mongo can't participate in a real two-phase commit, so this gap is unavoidable in this shape. Mitigation:

1. The audit insert is idempotent on `bookingId` (a Postgres SERIAL), so retries are safe.
2. A reconciliation sweep — find audit docs whose `bookingId` doesn't exist in Postgres — would catch and surface orphans. Not implemented here but the schema supports it.

The right production answer is usually the **outbox pattern**: write the audit intent into a Postgres outbox table inside the same transaction, then have a worker drain the outbox into Mongo. That moves the consistency guarantee back into a single PG transaction at the cost of a queue worker. Out of scope for a coursework demo; called out so the limitation isn't hidden.

## 4. Raw WebSockets over GraphQL Subscriptions

Both work. I picked raw `ws` because:

- The payload is small and structured (`{ type, eventId, seatIds }`), so the GraphQL subscription envelope doesn't earn its weight.
- A separate connection at `/ws?eventId=X` makes the broadcast semantics obvious — connect to one event, receive updates for that event, full stop.
- It keeps the WebSocket implementation cleanly separable from the GraphQL layer, which matters for the resume claim and matters even more for swapping in something like Redis pub/sub later when the server is no longer a single process.

The cost is that there's a second protocol on the wire. For this size of app, fine; at scale, I'd reconsider.

## 5. DataLoader instances are per-request, on purpose

`createLoaders()` runs inside the Apollo context function, so every GraphQL request gets fresh loaders. This is intentional:

- DataLoader memoizes within its lifetime. If we made it process-wide, the cache would never invalidate — two users would see the same stale `availableSeats` count for as long as the server was up.
- Per-request caching is exactly what you want: a single query's resolver tree may ask for `availableSeats` for the same event multiple times, and that should collapse to one DB call. Different requests should not share that cache.

## 6. Why typed errors with stable `code` values?

The resolver and service layers throw `AppError` subclasses with a stable `code` ('SEAT_HELD_BY_OTHER', 'BAD_USER_INPUT', etc.). The Apollo `formatError` hook turns those into `extensions.code` on the response.

This gives the client a machine-readable failure reason — branching on `code === 'SEAT_HELD_BY_OTHER'` is far more robust than regex-matching error messages, especially as messages get localized or rewritten. It also keeps internal errors opaque: anything that isn't an `AppError` becomes a generic `INTERNAL_SERVER_ERROR` in production, with the full stack going to the structured logger.

## 7. Testing strategy

Two suites, two purposes:

- **Unit (`npm test`).** Mocks both databases. Verifies the *logic* of the booking service — that the SQL verb sequence is right, that errors propagate as the right typed classes, that the Mongo write is skipped on early failures. Runs anywhere, ~6s total. This is what CI gates merges on first.
- **Integration (`npm run test:integration`).** Uses real Postgres and Mongo. Verifies properties that depend on database behavior we *can't* mock: that `SELECT FOR UPDATE` actually serializes concurrent bookings, that ROLLBACK actually leaves seats free, that we end up with exactly one audit doc per booking. The concurrent test fires 10 parallel attempts at one seat and asserts exactly one wins.

Both suites run in CI on every push and PR. The integration suite gets real Postgres and Mongo from GitHub Actions service containers.

## 8. What's deliberately out of scope

To keep the project defensible in a 30-minute conversation rather than a 3-hour one:

- **Auth.** The `userId` is passed through from the client as a string. Real auth would terminate JWTs at the Express layer and set the context, but it adds a lot of code that isn't on the resume bullet.
- **Migrations.** The seed script does schema-as-code. A real app would use `node-pg-migrate` or similar so schema changes are versioned and reversible.
- **Caching.** A Redis cache in front of `availableSeatsLoader` would cut PG load further, but invalidation gets complicated quickly and isn't earning anything for this demo.
- **Rate limiting.** Booking is a write endpoint; in production it'd be behind a per-user rate limiter at the API gateway.

Each of these would be the next thing I'd add if the project grew past a class deliverable.
