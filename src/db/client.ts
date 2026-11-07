import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Database } from "./database";
import * as schema from "./schema";

// One pool per function instance, at module scope, so warm invocations reuse connections.
// It is created on first use rather than at import, so `next build` needs no DATABASE_URL.
let database: Database | undefined;

export function getDatabase(): Database {
  if (database) return database;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set; see .env.example.");
  }

  const pool = new Pool({ connectionString });
  // Lets Vercel close idle connections before a function instance is suspended.
  attachDatabasePool(pool);
  database = drizzle({ client: pool, schema });
  return database;
}

// The tables' owner on the direct connection (docs/deployment.md, "The app's database role"): the
// one role that may empty the audit log, so only the Reset uses it. A pool of its own, opened for
// the one Reset and closed after it; a local Postgres has no pooler, so DATABASE_URL serves there.
export async function withOwnerDatabase<T>(work: (db: Database) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL_UNPOOLED is not set; see .env.example.");
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    return await work(drizzle({ client: pool, schema }));
  } finally {
    await pool.end();
  }
}
