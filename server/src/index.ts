import express from 'express';
import http from 'http';
import cors from 'cors';
import bodyParser from 'body-parser';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { WebSocketServer } from 'ws';
import pinoHttp from 'pino-http';
import { ulid } from 'ulid';
import * as dotenv from 'dotenv';

import { typeDefs } from './graphql/typeDefs';
import { resolvers } from './graphql/resolvers';
import { SeatHub } from './websocket/seatHub';
import { logger } from './logger';
import { createLoaders } from './loaders';
import { GraphQLContext } from './context';
import { checkHealth } from './db/health';
import { AppError } from './errors';

dotenv.config();

async function start() {
  const app = express();
  const httpServer = http.createServer(app);

  // Request ID + structured access log. The same ID is attached to the
  // GraphQL context so any log line inside a resolver can be correlated
  // with the inbound request.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req.headers['x-request-id'] as string) ?? ulid(),
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    })
  );

  const apollo = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
    // Translate AppError instances into stable error codes for the client.
    // Stack traces are stripped in production to avoid leaking internals.
    formatError: (formatted, raw) => {
      const original = (raw as { originalError?: unknown })?.originalError;
      if (original instanceof AppError) {
        return {
          message: original.message,
          extensions: {
            code: original.code,
            ...(original.details ? { details: original.details } : {}),
          },
        };
      }
      // Unknown error — log it server-side, return a generic message client-side.
      logger.error({ err: raw }, 'Unhandled GraphQL error');
      if (process.env.NODE_ENV === 'production') {
        return {
          message: 'Internal server error',
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        };
      }
      return formatted;
    },
  });
  await apollo.start();

  app.use(
    '/graphql',
    cors<cors.CorsRequest>(),
    bodyParser.json(),
    expressMiddleware(apollo, {
      context: async ({ req }) => ({
        requestId: String(req.id ?? ulid()),
        loaders: createLoaders(),
      }),
    })
  );

  // Real readiness check that pings both databases.
  app.get('/health', async (_req, res) => {
    const h = await checkHealth();
    res.status(h.ok ? 200 : 503).json(h);
  });
  app.get('/live', (_req, res) => res.json({ ok: true }));

  // WebSocket server shares the HTTP server on /ws
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  SeatHub.attach(wss);

  const port = Number(process.env.PORT) || 4000;
  httpServer.listen(port, () => {
    logger.info({ port }, 'Server listening');
    logger.info(`GraphQL ready at http://localhost:${port}/graphql`);
    logger.info(`WebSocket ready at ws://localhost:${port}/ws`);
  });

  // Graceful shutdown — finish in-flight requests and release DB connections.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    httpServer.close();
    await apollo.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch((err) => {
  logger.fatal({ err }, 'Server failed to start');
  process.exit(1);
});
