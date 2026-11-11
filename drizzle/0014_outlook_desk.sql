CREATE TABLE "agent_schedule" (
	"id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"interval_minutes" integer DEFAULT 15 NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_tick_at" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	CONSTRAINT "agent_schedule_single_row" CHECK ("agent_schedule"."id" = 1),
	CONSTRAINT "agent_schedule_interval_check" CHECK ("agent_schedule"."interval_minutes" between 5 and 60)
);
--> statement-breakpoint
CREATE TABLE "email_embeddings" (
	"email_id" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"vector" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_labels" (
	"email_id" text NOT NULL,
	"label_id" integer NOT NULL,
	"added_by" integer,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_labels_email_id_label_id_pk" PRIMARY KEY("email_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "email_triage" (
	"email_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"flag" text DEFAULT 'none' NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_triage_status_check" CHECK ("email_triage"."status" in ('new', 'in-progress', 'waiting', 'done')),
	CONSTRAINT "email_triage_flag_check" CHECK ("email_triage"."flag" in ('none', 'follow-up', 'complete'))
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_color_check" CHECK ("labels"."color" in ('dusk', 'apricot', 'sandy', 'pumpkin', 'green', 'red', 'grey'))
);
--> statement-breakpoint
CREATE TABLE "reply_compositions" (
	"email_id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"state" text NOT NULL,
	"updated_by" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reply_compositions_state_check" CHECK ("reply_compositions"."state" in ('draft', 'ready'))
);
--> statement-breakpoint
ALTER TABLE "inbox_runs" ADD COLUMN "email_ids" jsonb;--> statement-breakpoint
ALTER TABLE "inbox_runs" ADD COLUMN "trigger" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedule" ADD CONSTRAINT "agent_schedule_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_embeddings" ADD CONSTRAINT "email_embeddings_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_labels" ADD CONSTRAINT "email_labels_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_labels" ADD CONSTRAINT "email_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_labels" ADD CONSTRAINT "email_labels_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_triage" ADD CONSTRAINT "email_triage_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_triage" ADD CONSTRAINT "email_triage_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_compositions" ADD CONSTRAINT "reply_compositions_email_id_emails_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("email_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_compositions" ADD CONSTRAINT "reply_compositions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_labels_label_idx" ON "email_labels" USING btree ("label_id");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_name_idx" ON "labels" USING btree (lower("name"));