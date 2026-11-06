ALTER TABLE "proposals" DROP CONSTRAINT "proposals_status_check";--> statement-breakpoint
ALTER TABLE "draft_replies" ADD COLUMN "ready_by" integer;--> statement-breakpoint
ALTER TABLE "draft_replies" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "decided_by" integer;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "decision_reason" text;--> statement-breakpoint
ALTER TABLE "draft_replies" ADD CONSTRAINT "draft_replies_ready_by_users_id_fk" FOREIGN KEY ("ready_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_status_check" CHECK ("proposals"."status" in ('open', 'released', 'rejected', 'held'));