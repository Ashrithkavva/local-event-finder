import { pgPool } from './postgres';
import { getMongoDb } from './mongo';
import { logger } from '../logger';

type CheckResult = { ok: boolean; latencyMs: number; error?: string };

async function timed<T>(fn: () => Promise<T>): Promise<CheckResult> {
  const start = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkHealth() {
  const [postgres, mongo] = await Promise.all([
    timed(async () => {
      await pgPool.query('SELECT 1');
    }),
    timed(async () => {
      const db = await getMongoDb();
      await db.command({ ping: 1 });
    }),
  ]);

  const ok = postgres.ok && mongo.ok;
  if (!ok) {
    logger.warn({ postgres, mongo }, 'Health check failed');
  }
  return { ok, postgres, mongo, timestamp: new Date().toISOString() };
}
