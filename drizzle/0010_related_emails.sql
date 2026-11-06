CREATE TABLE "email_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"email_id" text NOT NULL,
	"related_email_id" text NOT NULL,
	"why" text NOT NULL,
	"possibly_same_order" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_links" ADD CONSTRAINT "email_links_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_links" ADD CONSTRAINT "email_links_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_links" ADD CONSTRAINT "email_links_related_email_id_emails_email_id_fk" FOREIGN KEY ("related_email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_links_email_id_idx" ON "email_links" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "email_links_related_email_id_idx" ON "email_links" USING btree ("related_email_id");