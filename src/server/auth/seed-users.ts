import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/database";
import { userRoles, users } from "@/db/schema";
import { hashPassword } from "./password";
import { normalizeUsername } from "./sessions";

const REVIEWER_USERNAME = "ops.reviewer";
const ADMIN_USERNAME = "admin";
const MIN_PASSWORD_LENGTH = 12;

const password = z.string().min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`);

// The seeded logins come only from env vars at seed time (security 1); no credential is in
// the repository. The assessors' role defaults to reviewer and can be raised to admin.
const seedEnvSchema = z.object({
  SEED_REVIEWER_PASSWORD: password,
  SEED_ADMIN_PASSWORD: password,
  SEED_ASSESSOR_USERNAME: z
    .string()
    .transform(normalizeUsername)
    .pipe(
      z
        .string()
        .min(1, "must be set")
        .refine((name) => name !== REVIEWER_USERNAME && name !== ADMIN_USERNAME, {
          message: `must differ from ${REVIEWER_USERNAME} and ${ADMIN_USERNAME}`,
        }),
    ),
  SEED_ASSESSOR_PASSWORD: password,
  // An empty value, as `.env.example` leaves it, means the default.
  SEED_ASSESSOR_ROLE: z.preprocess((role) => (role === "" ? undefined : role), z.enum(userRoles).default("reviewer")),
});

export type SeedEnv = Record<string, string | undefined>;

// Creates the three users, or updates their password and role when they exist, so rerunning
// the seed rotates a password. Every env var is checked before anything is written.
export async function seedUsers(db: Database, env: SeedEnv): Promise<void> {
  const parsed = seedEnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
    throw new Error(`Cannot seed users: ${problems.join("; ")}. See .env.example.`);
  }
  const config = parsed.data;

  const accounts = [
    { username: REVIEWER_USERNAME, password: config.SEED_REVIEWER_PASSWORD, role: "reviewer" as const },
    { username: ADMIN_USERNAME, password: config.SEED_ADMIN_PASSWORD, role: "admin" as const },
    { username: config.SEED_ASSESSOR_USERNAME, password: config.SEED_ASSESSOR_PASSWORD, role: config.SEED_ASSESSOR_ROLE },
  ];
  const rows = await Promise.all(
    accounts.map(async (account) => ({
      username: account.username,
      passwordHash: await hashPassword(account.password),
      role: account.role,
    })),
  );

  await db
    .insert(users)
    .values(rows)
    .onConflictDoUpdate({
      target: users.username,
      set: { passwordHash: sql`excluded.password_hash`, role: sql`excluded.role` },
    });
}
