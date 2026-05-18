import DataLoader from 'dataloader';
import { pgPool } from './db/postgres';
import { getMongoDb } from './db/mongo';

export type EventDetailsDoc = {
  eventId: number;
  description?: string;
  category?: string;
  reviews?: { author: string; rating: number; comment: string }[];
};

/**
 * Build a fresh set of DataLoaders per GraphQL request. Without these, asking
 * for N events would issue N Mongo queries + N "available seats" PG counts —
 * a classic N+1. With them, the resolver issues exactly two batched queries
 * regardless of how many events were requested.
 */
export function createLoaders() {
  const eventDetailsLoader = new DataLoader<number, EventDetailsDoc | null>(
    async (eventIds) => {
      const mongo = await getMongoDb();
      const docs = await mongo
        .collection<EventDetailsDoc>('event_details')
        .find({ eventId: { $in: eventIds as number[] } })
        .toArray();
      const byId = new Map(docs.map((d) => [d.eventId, d]));
      // DataLoader requires results to match the input order one-to-one.
      return eventIds.map((id) => byId.get(id) ?? null);
    }
  );

  const availableSeatsLoader = new DataLoader<number, number>(
    async (eventIds) => {
      const result = await pgPool.query<{ event_id: number; available: number }>(
        `SELECT event_id, COUNT(*)::int AS available
         FROM seats
         WHERE event_id = ANY($1::int[]) AND is_booked = FALSE
         GROUP BY event_id`,
        [eventIds as number[]]
      );
      const byId = new Map(result.rows.map((r) => [r.event_id, r.available]));
      return eventIds.map((id) => byId.get(id) ?? 0);
    }
  );

  return { eventDetailsLoader, availableSeatsLoader };
}

export type Loaders = ReturnType<typeof createLoaders>;
