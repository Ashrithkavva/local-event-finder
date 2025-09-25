import { useEffect, useRef, useState } from 'react';

export type SeatBookedMessage = {
  type: 'SEATS_BOOKED';
  eventId: string;
  seatIds: string[];
};
export type SubscribedMessage = { type: 'SUBSCRIBED'; eventId: string };
export type SeatMessage = SeatBookedMessage | SubscribedMessage;

type Status = 'connecting' | 'open' | 'closed';

/**
 * Subscribes to the seat-update WebSocket for a given event.
 * Reconnects on close with simple linear backoff so a brief drop doesn't
 * leave the seat map stale.
 */
export function useSeatSocket(
  eventId: string | null,
  onMessage: (msg: SeatBookedMessage) => void
) {
  const [status, setStatus] = useState<Status>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const cancelledRef = useRef(false);

  // Keep latest handler in a ref so reconnects don't churn on every render
  const handlerRef = useRef(onMessage);
  useEffect(() => {
    handlerRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!eventId) return;
    cancelledRef.current = false;
    let attempt = 0;

    const baseUrl =
      process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws';

    const connect = () => {
      if (cancelledRef.current) return;
      setStatus('connecting');
      const ws = new WebSocket(`${baseUrl}?eventId=${encodeURIComponent(eventId)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setStatus('open');
      };
      ws.onmessage = (event) => {
        try {
          const parsed: SeatMessage = JSON.parse(event.data);
          if (parsed.type === 'SEATS_BOOKED') handlerRef.current(parsed);
        } catch {
          // Ignore malformed payloads
        }
      };
      ws.onclose = () => {
        setStatus('closed');
        if (cancelledRef.current) return;
        attempt += 1;
        const delay = Math.min(1000 * attempt, 5000);
        setTimeout(connect, delay);
      };
      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      cancelledRef.current = true;
      wsRef.current?.close();
    };
  }, [eventId]);

  return status;
}
