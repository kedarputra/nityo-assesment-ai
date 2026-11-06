CREATE TYPE "public"."customer_status" AS ENUM('ACTIVE', 'CREDIT_HOLD');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('ACTIVE', 'DISCONTINUED');--> statement-breakpoint
CREATE TYPE "public"."sales_order_status" AS ENUM('OPEN', 'PARTIALLY_SHIPPED', 'SHIPPED');--> statement-breakpoint
CREATE TYPE "public"."sell_uom" AS ENUM('CS', 'EA');--> statement-breakpoint
CREATE TABLE "customer_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"sku" text NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"customer_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"payment_terms" text NOT NULL,
	"credit_limit_cents" integer NOT NULL,
	"open_balance_cents" integer NOT NULL,
	"status" "customer_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"email_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"from_name" text NOT NULL,
	"from_email" text NOT NULL,
	"to" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incoming_supply" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_po" text NOT NULL,
	"sku" text NOT NULL,
	"qty" integer NOT NULL,
	"expected_date" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"sku" text PRIMARY KEY NOT NULL,
	"on_hand" integer NOT NULL,
	"allocated" integer NOT NULL,
	"available" integer GENERATED ALWAYS AS (on_hand - allocated) STORED NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"sku" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"sell_uom" "sell_uom" NOT NULL,
	"pack" text NOT NULL,
	"list_price_cents" integer NOT NULL,
	"status" "product_status" NOT NULL,
	"replaced_by" text
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"so_number" text NOT NULL,
	"line_no" integer NOT NULL,
	"sku" text NOT NULL,
	"qty_ordered" integer NOT NULL,
	"qty_shipped" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	CONSTRAINT "sales_order_lines_so_number_line_no_pk" PRIMARY KEY("so_number","line_no")
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"so_number" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"ship_to_id" text NOT NULL,
	"customer_po" text,
	"order_date" date NOT NULL,
	"requested_date" date NOT NULL,
	"status" "sales_order_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ship_to_addresses" (
	"ship_to_id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"is_default" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_prices" ADD CONSTRAINT "customer_prices_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_prices" ADD CONSTRAINT "customer_prices_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."products"("sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_supply" ADD CONSTRAINT "incoming_supply_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."products"("sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."products"("sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_replaced_by_products_sku_fk" FOREIGN KEY ("replaced_by") REFERENCES "public"."products"("sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_so_number_sales_orders_so_number_fk" FOREIGN KEY ("so_number") REFERENCES "public"."sales_orders"("so_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."products"("sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_ship_to_id_ship_to_addresses_ship_to_id_fk" FOREIGN KEY ("ship_to_id") REFERENCES "public"."ship_to_addresses"("ship_to_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ship_to_addresses" ADD CONSTRAINT "ship_to_addresses_customer_id_customers_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("customer_id") ON DELETE no action ON UPDATE no action;