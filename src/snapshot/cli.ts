import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import { ingestSnapshot, resetToSnapshot } from "./snapshot";

// `npm run db:ingest` loads the Snapshot into a freshly migrated, empty database;
// `npm run db:reset` returns a loaded one to it. Both go around Neon's pooler on
// DATABASE_URL_UNPOOLED, falling back to DATABASE_URL for a local Postgres, which has no pooler.
async function main(command: string | undefined): Promise<void> {
  if (command !== "ingest" && command !== "reset") {
    throw new Error("usage: cli.ts ingest|reset");
  }
  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set; see .env.example.");

  const pool = new Pool({ connectionString });
  try {
    const db = drizzle({ client: pool, schema });
    if (command === "ingest") {
      await ingestSnapshot(db);
    } else {
      await resetToSnapshot(db);
    }
    console.log(`snapshot ${command}: done`);
  } finally {
    await pool.end();
  }
}

main(process.argv[2]).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
