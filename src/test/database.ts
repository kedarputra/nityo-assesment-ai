import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Database } from "@/db/database";
import * as schema from "@/db/schema";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface TestDatabase {
  db: Database;
  close: () => Promise<void>;
}

// A fresh in-process Postgres with every migration applied, so no test needs a database
// server or Docker. Each call is its own database; close it when the test is done.
export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return { db, close: () => client.close() };
}
