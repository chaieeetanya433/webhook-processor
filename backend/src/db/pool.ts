import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export function createPool(databaseUrl: string, max: number): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}
