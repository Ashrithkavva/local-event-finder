import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { logger } from '../logger';

type SeatMessage =
  | { type: 'SEATS_BOOKED'; eventId: string; seatIds: string[] }
  | { type: 'SUBSCRIBED'; eventId: string };

class SeatHubImpl {
  // Map of eventId -> set of subscribed sockets
  private subscribers = new Map<string, Set<WebSocket>>();

  attach(wss: WebSocketServer) {
    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      // Clients connect to e.g. ws://host/ws?eventId=3
      const url = new URL(req.url ?? '', 'http://localhost');
      const eventId = url.searchParams.get('eventId');
      if (!eventId) {
        ws.close(1008, 'eventId query param required');
        return;
      }

      this.addSubscriber(eventId, ws);
      logger.debug(
        { eventId, subscribers: this.subscribers.get(eventId)?.size ?? 0 },
        'WS client subscribed'
      );

      const ack: SeatMessage = { type: 'SUBSCRIBED', eventId };
      ws.send(JSON.stringify(ack));

      ws.on('close', () => this.removeSubscriber(eventId, ws));
      ws.on('error', (err) => {
        logger.warn({ err, eventId }, 'WS client error');
        this.removeSubscriber(eventId, ws);
      });
    });
  }

  private addSubscriber(eventId: string, ws: WebSocket) {
    let set = this.subscribers.get(eventId);
    if (!set) {
      set = new Set();
      this.subscribers.set(eventId, set);
    }
    set.add(ws);
  }

  private removeSubscriber(eventId: string, ws: WebSocket) {
    const set = this.subscribers.get(eventId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.subscribers.delete(eventId);
  }

  broadcast(eventId: string, msg: SeatMessage) {
    const set = this.subscribers.get(eventId);
    if (!set) {
      logger.debug({ eventId }, 'Broadcast skipped: no subscribers');
      return;
    }
    const payload = JSON.stringify(msg);
    let delivered = 0;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        delivered++;
      }
    }
    logger.debug({ eventId, delivered, type: msg.type }, 'Broadcast delivered');
  }
}

export const SeatHub = new SeatHubImpl();
