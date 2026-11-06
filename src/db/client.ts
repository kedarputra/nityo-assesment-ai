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
