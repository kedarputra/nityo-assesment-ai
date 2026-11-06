import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// The app's own settings, one value per key. The scaffold's first table: it gives the
// migration harness something real to migrate. The ERP tables arrive with the data load.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A person who signs in (security 1 and 2). Seeded from env vars, never signed up; the hash is
// argon2id, and no plain password is ever stored.
export const userRoles = ["reviewer", "admin"] as const;
export type UserRole = (typeof userRoles)[number];

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: userRoles }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("users_role_check", sql`${table.role} in ('reviewer', 'admin')`)],
);

// A signed-in browser. The cookie carries a random token; only its SHA-256 is stored, so a
// read of this table cannot be replayed as a session.
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

// Failed sign-ins per typed username, known or not, so a lock reveals nothing about which
// accounts exist. Five failures inside one 15-minute window lock the name for 15 minutes.
export const signInThrottle = pgTable("sign_in_throttle", {
  username: text("username").primaryKey(),
  failureCount: integer("failure_count").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});
