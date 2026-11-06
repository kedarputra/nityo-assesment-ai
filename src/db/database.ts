import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

// The one database type the app codes against. Production hands it a `pg` pool and tests a
// PGlite instance; both are Drizzle Postgres databases over the same schema.
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
