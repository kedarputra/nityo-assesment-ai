CREATE TABLE "email_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"email_id" text NOT NULL,
	"source_email_id" text NOT NULL,
	"run_id" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routed_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"email_id" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routed_requests_kind_check" CHECK ("routed_requests"."kind" in ('new order', 'order change', 'cancellation', 'return', 'billing dispute', 'quote request', 'order inquiry')),
	CONSTRAINT "routed_requests_reason_check" CHECK ("routed_requests"."reason" in ('quote', 'return', 'billing', 'inquiry', 'prospect', 'no-quantities', 'missing-attachment'))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "request_kinds" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "no_action_reason" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "no_action_note" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "duplicate_of_email_id" text;--> statement-breakpoint
ALTER TABLE "email_notes" ADD CONSTRAINT "email_notes_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_notes" ADD CONSTRAINT "email_notes_source_email_id_emails_email_id_fk" FOREIGN KEY ("source_email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_notes" ADD CONSTRAINT "email_notes_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routed_requests" ADD CONSTRAINT "routed_requests_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routed_requests" ADD CONSTRAINT "routed_requests_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_notes_email_id_idx" ON "email_notes" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "routed_requests_email_id_idx" ON "routed_requests" USING btree ("email_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_duplicate_of_email_id_emails_email_id_fk" FOREIGN KEY ("duplicate_of_email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_request_kinds_check" CHECK ("agent_runs"."request_kinds" <@ array['new order', 'order change', 'cancellation', 'return', 'billing dispute', 'quote request', 'order inquiry', 'no action']::text[]);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_no_action_reason_check" CHECK ("agent_runs"."no_action_reason" in ('spam', 'auto-reply', 'duplicate'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_duplicate_of_check" CHECK (("agent_runs"."no_action_reason" is not distinct from 'duplicate') = ("agent_runs"."duplicate_of_email_id" is not null));