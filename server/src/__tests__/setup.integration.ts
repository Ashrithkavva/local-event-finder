import { pgPool } from '../db/postgres';
import { getMongoDb } from '../db/mongo';

export async function resetSchema() {
  await pgPool.query(`
    DROP TABLE IF EXISTS bookings CASCADE;
    DROP TABLE IF EXISTS seats CASCADE;
    DROP TABLE IF EXISTS events CASCADE;

    CREATE TABLE events (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      venue TEXT NOT NULL,
      event_date TIMESTAMPTZ NOT NULL,
      total_seats INT NOT NULL
    );
    CREATE TABLE seats (
      id SERIAL PRIMARY KEY,
      event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      row_label TEXT NOT NULL,
      seat_number INT NOT NULL,
      is_booked BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE (event_id, row_label, seat_number)
    );
    CREATE TABLE bookings (
      id SERIAL PRIMARY KEY,
      event_id INT NOT NULL REFERENCES events(id),
      seat_ids INT[] NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const mongo = await getMongoDb();
  await mongo.collection('booking_audit').deleteMany({});
  await mongo.collection('event_details').deleteMany({});
}

export async function createEventWithSeats(seatCount: number): Promise<{
  eventId: number;
  seatIds: number[];
}> {
  const evRes = await pgPool.query<{ id: number }>(
    `INSERT INTO events (name, venue, event_date, total_seats)
     VALUES ('Test Event', 'Test Venue', NOW(), $1)
     RETURNING id`,
    [seatCount]
  );
  const eventId = evRes.rows[0].id;

  const values: string[] = [];
  const params: (string | number)[] = [];
  let p = 1;
  for (let i = 1; i <= seatCount; i++) {
    values.push(`($${p++}, $${p++}, $${p++})`);
    params.push(eventId, 'A', i);
  }
  const seatRes = await pgPool.query<{ id: number }>(
    `INSERT INTO seats (event_id, row_label, seat_number)
     VALUES ${values.join(', ')}
     RETURNING id`,
    params
  );
  return { eventId, seatIds: seatRes.rows.map((r) => r.id) };
}
