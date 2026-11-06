// Creates or updates the seeded logins from the SEED_* env vars: `npm run db:seed-users`.
// Rerun it to rotate a password; the deploy's `db:prepare` seeds users only into an empty
// database. See .env.example for the variables.
import { getDatabase } from "@/db/client";
import { seedUsers } from "@/server/auth/seed-users";

async function main(): Promise<void> {
  await seedUsers(getDatabase(), process.env);
  console.log("Seeded ops.reviewer, admin and the assessor login.");
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
