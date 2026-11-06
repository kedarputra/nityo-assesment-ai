ALTER TABLE "proposal_lines" ADD COLUMN "from_sales_order" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "requested_date_words" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "requested_date_alternative" date;