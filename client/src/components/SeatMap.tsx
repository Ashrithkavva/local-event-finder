import { useMemo } from 'react';

export type Seat = {
  id: string;
  eventId: string;
  rowLabel: string;
  seatNumber: number;
  isBooked: boolean;
};

type Props = {
  seats: Seat[];
  selectedIds: Set<string>;
  onToggle: (seatId: string) => void;
};

export function SeatMap({ seats, selectedIds, onToggle }: Props) {
  // Group seats by row so we render row labels and ordered seat buttons.
  const rows = useMemo(() => {
    const map = new Map<string, Seat[]>();
    for (const s of seats) {
      const arr = map.get(s.rowLabel) ?? [];
      arr.push(s);
      map.set(s.rowLabel, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.seatNumber - b.seatNumber);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [seats]);

  return (
    <>
      <div className="legend">
        <span>
          <span
            className="legend-swatch"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          />
          Available
        </span>
        <span>
          <span
            className="legend-swatch"
            style={{ background: 'var(--accent)' }}
          />
          Selected
        </span>
        <span>
          <span
            className="legend-swatch"
            style={{ background: '#2a1d22', border: '1px solid #4a2630' }}
          />
          Booked
        </span>
      </div>

      <div>
        {rows.map(([rowLabel, rowSeats]) => (
          <div className="seat-grid" key={rowLabel}>
            <div className="seat-row-label">{rowLabel}</div>
            {rowSeats.map((seat) => {
              const selected = selectedIds.has(seat.id);
              const className = `seat ${seat.isBooked ? 'booked' : ''} ${
                selected ? 'selected' : ''
              }`.trim();
              return (
                <button
                  key={seat.id}
                  className={className}
                  disabled={seat.isBooked}
                  onClick={() => onToggle(seat.id)}
                  aria-label={`Seat ${rowLabel}${seat.seatNumber}${
                    seat.isBooked ? ', booked' : ''
                  }`}
                >
                  {seat.seatNumber}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
