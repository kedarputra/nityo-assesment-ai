-- Security 6: the audit log is append-only in the database. The app connects as a login role
-- that is a member of harbor_point_app (docs/deployment.md, "The app's database role"), which may
-- add to and read the audit log but never change or delete it. The migrations, the seeds and the
-- Reset run as the role that owns the tables, which keeps every privilege.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'harbor_point_app') THEN
    CREATE ROLE harbor_point_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO harbor_point_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO harbor_point_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO harbor_point_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM harbor_point_app;
--> statement-breakpoint
-- A table a later migration adds is the app's to use, unless that migration says otherwise.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO harbor_point_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO harbor_point_app;
