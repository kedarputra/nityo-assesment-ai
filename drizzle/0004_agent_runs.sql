CREATE TABLE "agent_flags" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"email_id" text NOT NULL,
	"code" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"email_id" text NOT NULL,
	"model_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"gate_verdict" text,
	"error_class" text,
	CONSTRAINT "agent_runs_outcome_check" CHECK ("agent_runs"."outcome" in ('released', 'proposal', 'routed', 'no_action', 'failed')),
	CONSTRAINT "agent_runs_gate_verdict_check" CHECK ("agent_runs"."gate_verdict" in ('released', 'review'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"user_id" integer,
	"action" text NOT NULL,
	"email_id" text,
	"run_id" text,
	"detail" jsonb NOT NULL,
	CONSTRAINT "audit_events_actor_check" CHECK ("audit_events"."actor" in ('agent', 'gate', 'person'))
);
--> statement-breakpoint
CREATE TABLE "draft_replies" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"email_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposal_lines" (
	"proposal_id" integer NOT NULL,
	"line_no" integer NOT NULL,
	"sku" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer,
	"price_source" text,
	"stated_price_cents" integer,
	"customer_words" text,
	CONSTRAINT "proposal_lines_proposal_id_line_no_pk" PRIMARY KEY("proposal_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"email_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"ship_to_id" text NOT NULL,
	"customer_po" text,
	"requested_date" date NOT NULL,
	"total_cents" integer NOT NULL,
	"status" text NOT NULL,
	"checks" jsonb NOT NULL,
	"so_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_status_check" CHECK ("proposals"."status" in ('open', 'released'))
);
--> statement-breakpoint
ALTER TABLE "agent_flags" ADD CONSTRAINT "agent_flags_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_flags" ADD CONSTRAINT "agent_flags_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_replies" ADD CONSTRAINT "draft_replies_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_replies" ADD CONSTRAINT "draft_replies_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_lines" ADD CONSTRAINT "proposal_lines_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_so_number_sales_orders_so_number_fk" FOREIGN KEY ("so_number") REFERENCES "public"."sales_orders"("so_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_email_id_idx" ON "agent_runs" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "audit_events_email_id_idx" ON "audit_events" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "proposals_email_id_idx" ON "proposals" USING btree ("email_id");