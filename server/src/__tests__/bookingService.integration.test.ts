/**
 * Booking service — integration tests
 *
 * Exercises the cross-database transaction against REAL Postgres and Mongo.
 * Required when verifying concurrency guarantees that no amount of mocking
 * can prove: the row-level locks taken by `SELECT ... FOR UPDATE` only
 * behave correctly inside an actual database.
 *
 * How to run locally:
 *   docker compose up -d
 *   npm run test:integration
 *
 * How it runs in CI:
 *   GitHub Actions launches `postgres:16` and `mongo:7` as job services
 *   and points the env vars at localhost — see .github/workflows/ci.yml.
 */

import { bookSeats } from '../services/bookingService';
import { pgPool } from '../db/postgres';
import { getMongoDb, closeMongo } from '../db/mongo';
import { resetSchema, createEventWithSeats } from './setup.integration';
import { SeatHeldByOtherError } from '../errors';

describe('bookingService (integration)', () => {
  beforeAll(async () => {
    await resetSchema();
  });

  afterAll(async () => {
    await pgPool.end();
    await closeMongo();
  });

  beforeEach(async () => {
    // Each test starts with a clean slate so they can run in any order.
    await pgPool.query('TRUNCATE bookings, seats, events RESTART IDENTITY CASCADE');
    const mongo = await getMongoDb();
    await mongo.collection('booking_audit').deleteMany({});
  });

  test('books a free seat end-to-end: PG seat flipped, booking row, mongo audit', async () => {
    const { eventId, seatIds } = await createEventWithSeats(1);

    const booking = await bookSeats({
      eventId,
      seatIds: [seatIds[0]],
      userId: 'alice',
    });
    expect(booking.event_id).toBe(eventId);

    const seatRow = await pgPool.query<{ is_booked: boolean }>(
      'SELECT is_booked FROM seats WHERE id = $1',
      [seatIds[0]]
    );
    expect(seatRow.rows[0].is_booked).toBe(true);

    const audits = await (await getMongoDb())
      .collection('booking_audit')
      .find({ bookingId: booking.id })
      .toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      eventId,
      seatIds: [seatIds[0]],
      userId: 'alice',
    });
  });

  test('concurrent bookings of the same seat: exactly one succeeds', async () => {
    // This is the headline guarantee. Fire many parallel attempts at a single
    // seat and assert exactly one of them wins. The losers must see the
    // SEAT_HELD_BY_OTHER error code — and crucially, the database must end up
    // with a single booking row and a single audit document.
    const { eventId, seatIds } = await createEventWithSeats(1);
    const seatId = seatIds[0];

    const attempts = 10;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_, i) =>
        bookSeats({ eventId, seatIds: [seatId], userId: `user-${i}` })
      )
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(attempts - 1);

    for (const f of failed) {
      // Every loser must be the typed "held by another" error.
      expect(f.reason).toBeInstanceOf(SeatHeldByOtherError);
      expect(f.reason.code).toBe('SEAT_HELD_BY_OTHER');
    }

    // Database state: one booking, one audit, seat is booked.
    const bookings = await pgPool.query<{ id: number; user_id: string }>(
      'SELECT id, user_id FROM bookings WHERE event_id = $1',
      [eventId]
    );
    expect(bookings.rowCount).toBe(1);

    const audits = await (await getMongoDb())
      .collection('booking_audit')
      .find({ eventId })
      .toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(bookings.rows[0].user_id);

    const seatRow = await pgPool.query<{ is_booked: boolean }>(
      'SELECT is_booked FROM seats WHERE id = $1',
      [seatId]
    );
    expect(seatRow.rows[0].is_booked).toBe(true);
  });

  test('partial-overlap concurrent bookings: only the non-overlapping caller succeeds', async () => {
    // Two callers ask for [1,2] and [2,3]. The seat-2 lock guarantees they
    // serialize; whichever loses on seat 2 must not have booked seat 3 either,
    // proving the all-or-nothing property of the transaction.
    const { eventId, seatIds } = await createEventWithSeats(3);
    const [s1, s2, s3] = seatIds;

    const [r1, r2] = await Promise.allSettled([
      bookSeats({ eventId, seatIds: [s1, s2], userId: 'alice' }),
      bookSeats({ eventId, seatIds: [s2, s3], userId: 'bob' }),
    ]);

    const succeeded = [r1, r2].filter((r) => r.status === 'fulfilled');
    const failed = [r1, r2].filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // Whichever caller failed must have booked zero seats — not the one that
    // wasn't contended.
    const seats = await pgPool.query<{ id: number; is_booked: boolean }>(
      'SELECT id, is_booked FROM seats WHERE event_id = $1 ORDER BY id',
      [eventId]
    );
    const bookedCount = seats.rows.filter((r) => r.is_booked).length;
    expect(bookedCount).toBe(2);
  });
});
