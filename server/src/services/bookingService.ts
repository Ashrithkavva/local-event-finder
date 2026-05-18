import { pgPool } from '../db/postgres';
import { getMongoDb } from '../db/mongo';
import { PoolClient } from 'pg';
import { logger } from '../logger';
import { ValidationError, ConflictError, SeatHeldByOtherError } from '../errors';

export type BookingInput = {
  eventId: number;
  seatIds: number[];
  userId: string;
};

export type BookingRow = {
  id: number;
  event_id: number;
  seat_ids: number[];
  user_id: string;
  created_at: Date;
};

/**
 * Books one or more seats for a user.
 *
 * Cross-database transaction strategy
 * -----------------------------------
 *
 *  1. BEGIN a Postgres transaction and `SELECT ... FOR UPDATE` on the target
 *     seats. The row-level locks serialize concurrent bookings of the same
 *     seat: the second caller blocks on the lock, then re-reads `is_booked`
 *     and fails the availability check.
 *
 *  2. If every seat is still free, mark them booked and INSERT the booking row.
 *
 *  3. Write an audit document to Mongo. If this throws, ROLLBACK so the two
 *     databases stay consistent — seats stay free and no booking exists.
 *
 *  4. COMMIT Postgres. Only then is the booking durable.
 *
 * Known limitation: Postgres and Mongo can't participate in a true two-phase
 * commit. The remaining failure window is a PG COMMIT failure *after* the
 * Mongo audit insert succeeds — we'd then have an orphan audit doc. Mitigation
 * is to make the audit write idempotent on `bookingId` and reconcile via a
 * background sweep. See docs/DESIGN.md for the full discussion.
 */
export async function bookSeats(input: BookingInput): Promise<BookingRow> {
  if (input.seatIds.length === 0) {
    throw new ValidationError('At least one seat is required');
  }

  const client: PoolClient = await pgPool.connect();
  const log = logger.child({
    eventId: input.eventId,
    seatIds: input.seatIds,
    userId: input.userId,
  });

  try {
    await client.query('BEGIN');

    // ORDER BY id keeps a stable lock order across callers to avoid deadlocks
    // when two callers happen to target overlapping seat sets.
    const lockResult = await client.query<{ id: number; is_booked: boolean }>(
      `SELECT id, is_booked
       FROM seats
       WHERE id = ANY($1::int[]) AND event_id = $2
       ORDER BY id
       FOR UPDATE`,
      [input.seatIds, input.eventId]
    );

    if (lockResult.rowCount !== input.seatIds.length) {
      throw new ValidationError(
        'One or more seats do not belong to this event',
        { eventId: input.eventId, seatIds: input.seatIds }
      );
    }
    const alreadyBooked = lockResult.rows
      .filter((r) => r.is_booked)
      .map((r) => r.id);
    if (alreadyBooked.length > 0) {
      log.info({ alreadyBooked }, 'Booking rejected: seats already booked');
      throw new SeatHeldByOtherError(alreadyBooked);
    }

    await client.query(
      'UPDATE seats SET is_booked = TRUE WHERE id = ANY($1::int[])',
      [input.seatIds]
    );

    const insertResult = await client.query<BookingRow>(
      `INSERT INTO bookings (event_id, seat_ids, user_id)
       VALUES ($1, $2, $3)
       RETURNING id, event_id, seat_ids, user_id, created_at`,
      [input.eventId, input.seatIds, input.userId]
    );
    const booking = insertResult.rows[0];

    // Mongo audit log. If this throws, the catch block below rolls back PG.
    try {
      const mongo = await getMongoDb();
      await mongo.collection('booking_audit').insertOne({
        bookingId: booking.id,
        eventId: booking.event_id,
        seatIds: booking.seat_ids,
        userId: booking.user_id,
        createdAt: booking.created_at,
      });
    } catch (mongoErr) {
      log.error({ err: mongoErr }, 'Mongo audit write failed; rolling back PG');
      throw mongoErr;
    }

    await client.query('COMMIT');
    log.debug({ bookingId: booking.id }, 'Booking committed');
    return booking;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // Already rolled back or connection lost — nothing more to do.
    });
    // Re-throw the original error so callers see the typed AppError where applicable.
    if (
      err instanceof ValidationError ||
      err instanceof ConflictError ||
      err instanceof SeatHeldByOtherError
    ) {
      throw err;
    }
    throw err;
  } finally {
    client.release();
  }
}
