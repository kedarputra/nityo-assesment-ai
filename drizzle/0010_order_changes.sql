ALTER TYPE "public"."sales_order_status" ADD VALUE 'CANCELLED';--> statement-breakpoint
ALTER TABLE "proposal_lines" ADD COLUMN "order_line_no" integer;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "kind" text DEFAULT 'new order' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "target_so_number" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "follows_proposal_id" integer;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_target_so_number_sales_orders_so_number_fk" FOREIGN KEY ("target_so_number") REFERENCES "public"."sales_orders"("so_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_follows_proposal_id_proposals_id_fk" FOREIGN KEY ("follows_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_kind_check" CHECK ("proposals"."kind" in ('new order', 'order change', 'cancellation'));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_target_check" CHECK (("proposals"."kind" = 'new order') = ("proposals"."target_so_number" is null));