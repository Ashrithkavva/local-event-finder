import { useRouter } from 'next/router';
import { gql, useMutation, useQuery, useApolloClient } from '@apollo/client';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { SeatMap, Seat } from '@/components/SeatMap';
import { useSeatSocket, SeatBookedMessage } from '@/lib/useSeatSocket';

const EVENT_QUERY = gql`
  query EventDetail($id: ID!) {
    event(id: $id) {
      id
      name
      venue
      eventDate
      totalSeats
      availableSeats
      description
      category
      reviews {
        author
        rating
        comment
      }
    }
    seats(eventId: $id) {
      id
      eventId
      rowLabel
      seatNumber
      isBooked
    }
  }
`;

const BOOK_MUTATION = gql`
  mutation BookSeats($eventId: ID!, $seatIds: [ID!]!, $userId: String!) {
    bookSeats(eventId: $eventId, seatIds: $seatIds, userId: $userId) {
      id
      createdAt
    }
  }
`;

type EventDetail = {
  id: string;
  name: string;
  venue: string;
  eventDate: string;
  totalSeats: number;
  availableSeats: number;
  description: string | null;
  category: string | null;
  reviews: { author: string; rating: number; comment: string }[];
};

export default function EventDetailPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const client = useApolloClient();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bookingError, setBookingError] = useState<string | null>(null);

  const { data, loading, error } = useQuery<{
    event: EventDetail | null;
    seats: Seat[];
  }>(EVENT_QUERY, { variables: { id }, skip: !id });

  const [bookSeats, { loading: booking }] = useMutation(BOOK_MUTATION);

  /**
   * When another client books seats, the server pushes a SEATS_BOOKED message.
   * We patch the Apollo cache so the SeatMap re-renders the affected seats as
   * booked, and we drop any of those seats from the local selection.
   */
  const handleSeatMessage = useCallback(
    (msg: SeatBookedMessage) => {
      if (!id || msg.eventId !== id) return;
      const bookedIds = new Set(msg.seatIds);

      // Patch each seat in the normalized cache to is_booked = true
      for (const seatId of msg.seatIds) {
        client.cache.modify({
          id: client.cache.identify({ __typename: 'Seat', id: seatId }),
          fields: {
            isBooked: () => true,
          },
        });
      }

      // Also nudge availableSeats down on the Event entity for an accurate count
      client.cache.modify({
        id: client.cache.identify({ __typename: 'Event', id }),
        fields: {
          availableSeats: (current: number) =>
            Math.max(0, current - msg.seatIds.length),
        },
      });

      setSelected((prev) => {
        const next = new Set(prev);
        for (const s of bookedIds) next.delete(s);
        return next;
      });
    },
    [client, id]
  );

  const wsStatus = useSeatSocket(id, handleSeatMessage);

  const toggleSeat = useCallback((seatId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seatId)) next.delete(seatId);
      else next.add(seatId);
      return next;
    });
  }, []);

  const onBook = useCallback(async () => {
    if (!id || selected.size === 0) return;
    setBookingError(null);
    try {
      const seatIds = Array.from(selected);
      await bookSeats({
        variables: {
          eventId: id,
          seatIds,
          userId: 'demo-user',
        },
      });
      // Optimistically mark these as booked locally as well — the WS broadcast
      // will reach other clients; this client doesn't need to wait for its own.
      for (const seatId of seatIds) {
        client.cache.modify({
          id: client.cache.identify({ __typename: 'Seat', id: seatId }),
          fields: { isBooked: () => true },
        });
      }
      client.cache.modify({
        id: client.cache.identify({ __typename: 'Event', id }),
        fields: {
          availableSeats: (current: number) =>
            Math.max(0, current - seatIds.length),
        },
      });
      setSelected(new Set());
    } catch (e) {
      setBookingError(e instanceof Error ? e.message : 'Booking failed');
    }
  }, [bookSeats, client, id, selected]);

  const seatsBySelection = useMemo(() => Array.from(selected).length, [selected]);

  if (!id) return null;
  if (loading) return <main className="container"><p className="subtitle">Loading…</p></main>;
  if (error) return <main className="container"><div className="error">{error.message}</div></main>;
  if (!data?.event) return <main className="container"><p>Event not found.</p></main>;

  const { event } = data;

  return (
    <main className="container">
      <header className="header">
        <div>
          <Link href="/" className="subtitle">← All events</Link>
          <h1 className="title" style={{ marginTop: 6 }}>{event.name}</h1>
          <div className="subtitle">
            {event.venue} ·{' '}
            {new Date(event.eventDate).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </div>
        </div>
        <span className={`status-pill ${wsStatus}`}>Live: {wsStatus}</span>
      </header>

      {event.description && <p>{event.description}</p>}

      <h3 style={{ marginTop: 32 }}>Pick your seats</h3>
      <SeatMap
        seats={data.seats}
        selectedIds={selected}
        onToggle={toggleSeat}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <button
          className="button"
          disabled={booking || seatsBySelection === 0}
          onClick={onBook}
        >
          {booking
            ? 'Booking…'
            : seatsBySelection === 0
            ? 'Select seats to book'
            : `Book ${seatsBySelection} seat${seatsBySelection === 1 ? '' : 's'}`}
        </button>
        <span className="subtitle">
          {event.availableSeats} of {event.totalSeats} seats available
        </span>
      </div>
      {bookingError && <div className="error">{bookingError}</div>}

      {event.reviews.length > 0 && (
        <>
          <h3 style={{ marginTop: 40 }}>Reviews</h3>
          {event.reviews.map((r, i) => (
            <div className="review" key={i}>
              <div>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} — {r.comment}</div>
              <div className="review-meta">— {r.author}</div>
            </div>
          ))}
        </>
      )}
    </main>
  );
}
