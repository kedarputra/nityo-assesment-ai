// The deploy's database step, run by the Vercel build before `next build` (vercel.json):
// `npm run db:prepare`. It migrates over the unpooled URL, then seeds the Snapshot and the
// users only into an empty database. See docs/deployment.md.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import * as schema from "@/db/schema";
import { prepareDatabase } from "@/db/prepare-database";

async function main(): Promise<void> {
  // Migrations go around Neon's pooler (PgBouncer in transaction mode); a local Postgres has
  // no pooler, so there the one DATABASE_URL serves both.
  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set; see .env.example.");
  }

  // One connection, so the advisory lock that serialises concurrent builds covers all the work.
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const db = drizzle({ client, schema });
    const result = await prepareDatabase(db, {
      migrate: () => migrate(db, { migrationsFolder: "./drizzle" }),
      seedEnv: process.env,
    });
    console.log(
      `db:prepare: migrated; Snapshot ${result.snapshotSeeded ? "seeded" : "already present"}; ` +
        `users ${result.usersSeeded ? "seeded" : "already present"}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
