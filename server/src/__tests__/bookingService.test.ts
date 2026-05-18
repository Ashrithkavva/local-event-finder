/**
 * Booking service — unit tests
 *
 * These exercise the cross-database transaction logic in isolation by mocking
 * the Postgres pool and Mongo client. They verify:
 *
 *   1. Happy path — PG writes commit AND Mongo audit is inserted.
 *   2. Mongo failure rolls the PG transaction back (no booking, seats stay free).
 *   3. A seat that's already booked is rejected with the typed error code
 *      `SEAT_HELD_BY_OTHER` before any writes happen.
 *   4. Empty seat input fails fast with `BAD_USER_INPUT`.
 *
 * Mocks (not live DBs) so `npm test` runs anywhere without Docker. The
 * integration suite (`npm run test:integration`) exercises the same logic
 * against real Postgres and Mongo to prove concurrency safety.
 */

import { bookSeats } from '../services/bookingService';
import { pgPool } from '../db/postgres';
import { getMongoDb } from '../db/mongo';
import { ValidationError, SeatHeldByOtherError } from '../errors';

jest.mock('../db/postgres', () => ({
  pgPool: { connect: jest.fn() },
}));

jest.mock('../db/mongo', () => ({
  getMongoDb: jest.fn(),
}));

jest.mock('../logger', () => ({
  logger: {
    child: () => ({
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    }),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

type MockClient = {
  query: jest.Mock;
  release: jest.Mock;
};

function makeMockClient(): MockClient {
  return { query: jest.fn(), release: jest.fn() };
}

function recordedSqlVerbs(client: MockClient): string[] {
  return client.query.mock.calls.map((call) => {
    const arg = call[0];
    if (typeof arg !== 'string') return '<param>';
    return arg.trim().split(/\s+/)[0].toUpperCase();
  });
}

describe('bookingService.bookSeats (unit)', () => {
  let client: MockClient;
  let insertOne: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    client = makeMockClient();
    (pgPool.connect as jest.Mock).mockResolvedValue(client);

    insertOne = jest.fn().mockResolvedValue({ insertedId: 'mongoAudit1' });
    (getMongoDb as jest.Mock).mockResolvedValue({
      collection: () => ({ insertOne }),
    });
  });

  test('happy path: commits PG transaction and writes Mongo audit', async () => {
    client.query.mockImplementation((sql: string) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT')) {
        return Promise.resolve({
          rowCount: 2,
          rows: [
            { id: 11, is_booked: false },
            { id: 12, is_booked: false },
          ],
        });
      }
      if (sql.startsWith('UPDATE')) return Promise.resolve({ rowCount: 2 });
      if (sql.startsWith('INSERT')) {
        return Promise.resolve({
          rows: [
            {
              id: 99,
              event_id: 1,
              seat_ids: [11, 12],
              user_id: 'user-a',
              created_at: new Date('2026-05-17T12:00:00Z'),
            },
          ],
        });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      return Promise.resolve();
    });

    const booking = await bookSeats({
      eventId: 1,
      seatIds: [11, 12],
      userId: 'user-a',
    });

    expect(booking.id).toBe(99);
    expect(booking.seat_ids).toEqual([11, 12]);

    // SQL verb sequence proves the transaction was opened, locked, written, and committed
    expect(recordedSqlVerbs(client)).toEqual([
      'BEGIN',
      'SELECT',
      'UPDATE',
      'INSERT',
      'COMMIT',
    ]);

    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(insertOne.mock.calls[0][0]).toMatchObject({
      bookingId: 99,
      eventId: 1,
      seatIds: [11, 12],
      userId: 'user-a',
    });
    expect(client.release).toHaveBeenCalled();
  });

  test('Mongo audit failure rolls the PG transaction back', async () => {
    client.query.mockImplementation((sql: string) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{ id: 21, is_booked: false }],
        });
      }
      if (sql.startsWith('UPDATE')) return Promise.resolve({ rowCount: 1 });
      if (sql.startsWith('INSERT')) {
        return Promise.resolve({
          rows: [
            {
              id: 100,
              event_id: 2,
              seat_ids: [21],
              user_id: 'user-b',
              created_at: new Date(),
            },
          ],
        });
      }
      if (sql.startsWith('ROLLBACK')) return Promise.resolve();
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      return Promise.resolve();
    });

    insertOne.mockRejectedValueOnce(new Error('Mongo write failed'));

    await expect(
      bookSeats({ eventId: 2, seatIds: [21], userId: 'user-b' })
    ).rejects.toThrow('Mongo write failed');

    const verbs = recordedSqlVerbs(client);
    expect(verbs).toContain('ROLLBACK');
    expect(verbs).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  test('rejects already-booked seats with SEAT_HELD_BY_OTHER code, no writes', async () => {
    client.query.mockImplementation((sql: string) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{ id: 31, is_booked: true }],
        });
      }
      if (sql.startsWith('ROLLBACK')) return Promise.resolve();
      return Promise.resolve();
    });

    const promise = bookSeats({ eventId: 3, seatIds: [31], userId: 'user-c' });

    await expect(promise).rejects.toBeInstanceOf(SeatHeldByOtherError);
    await expect(promise).rejects.toMatchObject({ code: 'SEAT_HELD_BY_OTHER' });

    const verbs = recordedSqlVerbs(client);
    expect(verbs).toContain('ROLLBACK');
    expect(verbs).not.toContain('COMMIT');
    expect(verbs).not.toContain('UPDATE');
    expect(insertOne).not.toHaveBeenCalled();
  });

  test('rejects empty seat list with BAD_USER_INPUT before opening a transaction', async () => {
    const promise = bookSeats({ eventId: 1, seatIds: [], userId: 'user-x' });
    await expect(promise).rejects.toBeInstanceOf(ValidationError);
    await expect(promise).rejects.toMatchObject({ code: 'BAD_USER_INPUT' });
    expect(pgPool.connect).not.toHaveBeenCalled();
  });
});
