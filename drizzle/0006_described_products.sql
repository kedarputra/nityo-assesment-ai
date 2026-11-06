CREATE TABLE "product_searches" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"email_id" text NOT NULL,
	"query" jsonb NOT NULL,
	"candidate_skus" jsonb NOT NULL,
	"discontinued_skus" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposal_lines" ADD COLUMN "product_search_id" integer;--> statement-breakpoint
ALTER TABLE "proposal_lines" ADD COLUMN "replaces_sku" text;--> statement-breakpoint
ALTER TABLE "product_searches" ADD CONSTRAINT "product_searches_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_searches" ADD CONSTRAINT "product_searches_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_lines" ADD CONSTRAINT "proposal_lines_product_search_id_product_searches_id_fk" FOREIGN KEY ("product_search_id") REFERENCES "public"."product_searches"("id") ON DELETE no action ON UPDATE no action;