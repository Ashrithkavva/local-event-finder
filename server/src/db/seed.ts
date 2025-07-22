/* eslint-disable no-console -- this is a CLI script; console output is intentional */
import { pgPool } from './postgres';
import { getMongoDb, closeMongo } from './mongo';

async function seed() {
  console.log('Seeding Postgres...');
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

    CREATE INDEX idx_seats_event ON seats(event_id);
  `);

  const events = [
    {
      name: 'Atlanta Jazz Night',
      venue: 'Symphony Hall',
      date: '2026-06-12T20:00:00Z',
      description:
        'A laid-back evening of modern jazz featuring three local trios. Doors open at 7pm; drinks available at the upstairs bar.',
      category: 'Music',
      reviews: [
        { author: 'Maya', rating: 5, comment: 'Best Friday night out in a while.' },
        { author: 'Devon', rating: 4, comment: 'Great vibes, sound mix was a little off.' },
      ],
    },
    {
      name: 'Indie Film Festival: Opening Night',
      venue: 'Plaza Theatre',
      date: '2026-07-03T19:30:00Z',
      description:
        'Six short films from regional filmmakers, followed by a Q&A. Concessions and a curated trailer reel before the show.',
      category: 'Film',
      reviews: [
        { author: 'Sam', rating: 5, comment: 'Discovered three filmmakers to follow.' },
      ],
    },
    {
      name: 'Beltline 5K Charity Run',
      venue: 'Piedmont Park',
      date: '2026-08-20T07:00:00Z',
      description:
        'Untimed community 5K supporting local food banks. Registration includes a t-shirt and post-run breakfast.',
      category: 'Sports',
      reviews: [],
    },
  ];

  const rowsPerEvent = ['A', 'B', 'C', 'D'];
  const seatsPerRow = 8;

  for (const ev of events) {
    const result = await pgPool.query(
      'INSERT INTO events (name, venue, event_date, total_seats) VALUES ($1, $2, $3, $4) RETURNING id',
      [ev.name, ev.venue, ev.date, rowsPerEvent.length * seatsPerRow]
    );
    const eventId = result.rows[0].id;

    const seatValues: string[] = [];
    const seatParams: (string | number)[] = [];
    let p = 1;
    for (const row of rowsPerEvent) {
      for (let n = 1; n <= seatsPerRow; n++) {
        seatValues.push(`($${p++}, $${p++}, $${p++})`);
        seatParams.push(eventId, row, n);
      }
    }
    await pgPool.query(
      `INSERT INTO seats (event_id, row_label, seat_number) VALUES ${seatValues.join(', ')}`,
      seatParams
    );

    const mongo = await getMongoDb();
    await mongo.collection('event_details').updateOne(
      { eventId },
      {
        $set: {
          eventId,
          description: ev.description,
          category: ev.category,
          reviews: ev.reviews,
        },
      },
      { upsert: true }
    );
  }

  console.log('Seed complete.');
}

seed()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await pgPool.end();
    await closeMongo();
  });
