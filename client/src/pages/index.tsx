import { gql, useQuery } from '@apollo/client';
import Link from 'next/link';

const EVENTS_QUERY = gql`
  query Events {
    events {
      id
      name
      venue
      eventDate
      totalSeats
      availableSeats
      category
    }
  }
`;

type EventSummary = {
  id: string;
  name: string;
  venue: string;
  eventDate: string;
  totalSeats: number;
  availableSeats: number;
  category: string | null;
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export default function Home() {
  const { data, loading, error } = useQuery<{ events: EventSummary[] }>(
    EVENTS_QUERY
  );

  return (
    <main className="container">
      <header className="header">
        <h1 className="title">Local Event Finder</h1>
        <span className="subtitle">Live seat availability · GraphQL</span>
      </header>

      {loading && <p className="subtitle">Loading events…</p>}
      {error && (
        <div className="error">Could not load events: {error.message}</div>
      )}

      <div className="grid">
        {data?.events.map((ev) => (
          <Link
            key={ev.id}
            href={`/events/${ev.id}`}
            style={{ color: 'inherit' }}
          >
            <article className="card">
              <h2 className="card-title">{ev.name}</h2>
              <div className="card-meta">{ev.venue}</div>
              <div className="card-meta">{formatDate(ev.eventDate)}</div>
              <div className="card-meta" style={{ marginTop: 8 }}>
                {ev.availableSeats} of {ev.totalSeats} seats available
              </div>
              {ev.category && <span className="tag">{ev.category}</span>}
            </article>
          </Link>
        ))}
      </div>
    </main>
  );
}
