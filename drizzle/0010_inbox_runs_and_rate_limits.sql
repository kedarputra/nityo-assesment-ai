CREATE TABLE "inbox_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_by" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_step_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "inbox_runs_end_reason_check" CHECK ("inbox_runs"."end_reason" in ('finished', 'stopped', 'spend-limit', 'abandoned')),
	CONSTRAINT "inbox_runs_ended_check" CHECK (("inbox_runs"."ended_at" is null) = ("inbox_runs"."end_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "rate_limit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"action" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_events_action_check" CHECK ("rate_limit_events"."action" in ('agent-run', 'reset'))
);
--> statement-breakpoint
ALTER TABLE "proposals" DROP CONSTRAINT "proposals_status_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "inbox_run_id" integer;--> statement-breakpoint
ALTER TABLE "inbox_runs" ADD CONSTRAINT "inbox_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_events" ADD CONSTRAINT "rate_limit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_limit_events_user_action_at_idx" ON "rate_limit_events" USING btree ("user_id","action","at");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_inbox_run_id_inbox_runs_id_fk" FOREIGN KEY ("inbox_run_id") REFERENCES "public"."inbox_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_so_number_idx" ON "proposals" USING btree ("so_number");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_status_check" CHECK ("proposals"."status" in ('open', 'released', 'rejected', 'held', 'superseded'));