import { sql } from "drizzle-orm";
import type { Database } from "@/db/database";
import { customers, users } from "@/db/schema";
import { seedUsers, type SeedEnv } from "@/server/auth/seed-users";
import { readDataPack, type Snapshot } from "@/snapshot/data-pack";
import { ingestSnapshot } from "@/snapshot/snapshot";

// Any fixed number: it names the lock that keeps two builds sharing one database (every
// preview shares the `preview` branch) from migrating or seeding it at the same time.
const PREPARE_LOCK_ID = 70_001;

export interface PrepareOptions {
  migrate: () => Promise<void>;
  seedEnv: SeedEnv;
  snapshot?: Snapshot;
}

export interface PreparedDatabase {
  snapshotSeeded: boolean;
  usersSeeded: boolean;
}

// What every deploy runs before `next build`: the migrations, then the seeds, each only into
// empty tables, so a deploy never overwrites what the agent or a reviewer has done. Both seeds
// share one transaction: a missing SEED_* variable fails the build with nothing written.
// `db` must hold one connection, so the session lock and the work are on the same one.
export async function prepareDatabase(db: Database, options: PrepareOptions): Promise<PreparedDatabase> {
  await db.execute(sql`select pg_advisory_lock(${PREPARE_LOCK_ID})`);
  try {
    await options.migrate();
    return await db.transaction(async (tx) => {
      const snapshotSeeded = (await tx.$count(customers)) === 0;
      const usersSeeded = (await tx.$count(users)) === 0;
      if (snapshotSeeded) await ingestSnapshot(tx, options.snapshot ?? readDataPack());
      if (usersSeeded) await seedUsers(tx, options.seedEnv);
      return { snapshotSeeded, usersSeeded };
    });
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${PREPARE_LOCK_ID})`);
  }
}
