// Creates or updates the seeded logins from the SEED_* env vars: `npm run db:seed-users`.
// The deploy runs it after the migrations; see .env.example for the variables.
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
