import { pgPool } from '../db/postgres';
import { bookSeats } from '../services/bookingService';
import { SeatHub } from '../websocket/seatHub';
import { GraphQLContext } from '../context';
import { NotFoundError } from '../errors';
import {
  parseInput,
  bookSeatsInput,
  eventIdInput,
  seatsInput,
} from '../validation';
import { logger } from '../logger';

type EventRow = {
  id: number;
  name: string;
  venue: string;
  event_date: Date;
  total_seats: number;
};

/**
 * Resolver design notes
 *
 *  - `events` and `event` resolve only the columns that live on the `events`
 *    table. Fields backed by Mongo (`description`, `category`, `reviews`) and
 *    fields requiring an aggregate (`availableSeats`) are resolved on the
 *    `Event` type via field resolvers. Those field resolvers go through
 *    DataLoaders so the work is batched into one Mongo `find` and one PG
 *    `GROUP BY` per request, regardless of how many events are returned —
 *    no N+1.
 *
 *  - Field resolvers also mean we don't pay the cost of joining Mongo data
 *    when a client only asks for the PG-backed columns (e.g. the list page).
 *    This is a core advantage of letting the GraphQL schema drive fetching
 *    rather than hand-shaping JSON in the root resolver.
 */
export const resolvers = {
  Query: {
    events: async (): Promise<EventRow[]> => {
      const result = await pgPool.query<EventRow>(
        `SELECT id, name, venue, event_date, total_seats
         FROM events
         ORDER BY event_date ASC`
      );
      return result.rows;
    },

    event: async (
      _: unknown,
      rawArgs: unknown
    ): Promise<EventRow | null> => {
      const { id } = parseInput(eventIdInput, rawArgs);
      const result = await pgPool.query<EventRow>(
        `SELECT id, name, venue, event_date, total_seats
         FROM events WHERE id = $1`,
        [id]
      );
      return result.rows[0] ?? null;
    },

    seats: async (_: unknown, rawArgs: unknown) => {
      const { eventId } = parseInput(seatsInput, rawArgs);
      const result = await pgPool.query(
        `SELECT id, event_id, row_label, seat_number, is_booked
         FROM seats WHERE event_id = $1
         ORDER BY row_label ASC, seat_number ASC`,
        [eventId]
      );
      return result.rows.map((r) => ({
        id: String(r.id),
        eventId: String(r.event_id),
        rowLabel: r.row_label,
        seatNumber: r.seat_number,
        isBooked: r.is_booked,
      }));
    },
  },

  Event: {
    id: (parent: EventRow) => String(parent.id),
    name: (parent: EventRow) => parent.name,
    venue: (parent: EventRow) => parent.venue,
    eventDate: (parent: EventRow) => parent.event_date.toISOString(),
    totalSeats: (parent: EventRow) => parent.total_seats,

    availableSeats: (
      parent: EventRow,
      _: unknown,
      ctx: GraphQLContext
    ) => ctx.loaders.availableSeatsLoader.load(parent.id),

    description: async (
      parent: EventRow,
      _: unknown,
      ctx: GraphQLContext
    ) => (await ctx.loaders.eventDetailsLoader.load(parent.id))?.description ?? null,

    category: async (
      parent: EventRow,
      _: unknown,
      ctx: GraphQLContext
    ) => (await ctx.loaders.eventDetailsLoader.load(parent.id))?.category ?? null,

    reviews: async (
      parent: EventRow,
      _: unknown,
      ctx: GraphQLContext
    ) => (await ctx.loaders.eventDetailsLoader.load(parent.id))?.reviews ?? [],
  },

  Mutation: {
    bookSeats: async (
      _: unknown,
      rawArgs: unknown,
      ctx: GraphQLContext
    ) => {
      const input = parseInput(bookSeatsInput, rawArgs);

      // Verify the event exists up front so the client gets NOT_FOUND rather
      // than a vague "seats don't belong to this event" further down.
      const eventCheck = await pgPool.query(
        'SELECT 1 FROM events WHERE id = $1',
        [input.eventId]
      );
      if (eventCheck.rowCount === 0) {
        throw new NotFoundError('Event', input.eventId);
      }

      const booking = await bookSeats({
        eventId: input.eventId,
        seatIds: input.seatIds,
        userId: input.userId,
      });

      logger.info(
        { requestId: ctx.requestId, bookingId: booking.id, eventId: input.eventId },
        'Booking confirmed'
      );

      // Notify everyone watching this event so their seat map updates instantly.
      SeatHub.broadcast(String(input.eventId), {
        type: 'SEATS_BOOKED',
        eventId: String(input.eventId),
        seatIds: input.seatIds.map((s) => String(s)),
      });

      return {
        id: String(booking.id),
        eventId: String(booking.event_id),
        seatIds: booking.seat_ids.map((n: number) => String(n)),
        userId: booking.user_id,
        createdAt: booking.created_at.toISOString(),
      };
    },
  },
};
