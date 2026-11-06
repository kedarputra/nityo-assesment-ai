import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// The app's own settings, one value per key. The scaffold's first table: it gives the
// migration harness something real to migrate. The ERP tables arrive with the data load.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
