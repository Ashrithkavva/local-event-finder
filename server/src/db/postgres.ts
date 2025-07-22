import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { logger } from '../logger';

dotenv.config();

export const pgPool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT) || 5432,
  user: process.env.PG_USER || 'lef',
  password: process.env.PG_PASSWORD || 'lef',
  database: process.env.PG_DATABASE || 'lef',
  max: 10,
});

pgPool.on('error', (err) => {
  // Surface unexpected idle-client errors so they don't silently kill the process
  logger.error({ err }, 'Unexpected PG pool error');
});
