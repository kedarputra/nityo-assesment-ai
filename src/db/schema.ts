import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// The app's own settings, one value per key.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The ERP and the inbox as the data pack delivers them. The pack stores every column as TEXT;
// here money is integer cents, dates are dates, quantities are integers and statuses are the
// pack's own values, constrained. Column names follow the pack, with `_cents` on money.

export const customerStatus = pgEnum("customer_status", ["ACTIVE", "CREDIT_HOLD"]);
export const sellUom = pgEnum("sell_uom", ["CS", "EA"]);
export const productStatus = pgEnum("product_status", ["ACTIVE", "DISCONTINUED"]);
export const salesOrderStatus = pgEnum("sales_order_status", [
  "OPEN",
  "PARTIALLY_SHIPPED",
  "SHIPPED",
]);

export const customers = pgTable("customers", {
  customerId: text("customer_id").primaryKey(),
  name: text("name").notNull(),
  paymentTerms: text("payment_terms").notNull(),
  creditLimitCents: integer("credit_limit_cents").notNull(),
  openBalanceCents: integer("open_balance_cents").notNull(),
  status: customerStatus("status").notNull(),
});

// The pack gives contacts no id of their own.
export const customerContacts = pgTable("customer_contacts", {
  id: serial("id").primaryKey(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.customerId),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull(),
});

export const shipToAddresses = pgTable("ship_to_addresses", {
  shipToId: text("ship_to_id").primaryKey(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.customerId),
  name: text("name").notNull(),
  address: text("address").notNull(),
  isDefault: boolean("is_default").notNull(),
});

export const products = pgTable("products", {
  sku: text("sku").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  sellUom: sellUom("sell_uom").notNull(),
  pack: text("pack").notNull(),
  listPriceCents: integer("list_price_cents").notNull(),
  status: productStatus("status").notNull(),
  replacedBy: text("replaced_by").references((): AnyPgColumn => products.sku),
});

export const customerPrices = pgTable("customer_prices", {
  id: serial("id").primaryKey(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.customerId),
  sku: text("sku")
    .notNull()
    .references(() => products.sku),
  unitPriceCents: integer("unit_price_cents").notNull(),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to").notNull(),
});

// `available` is derived by the database, so it cannot drift from on_hand and allocated.
export const inventory = pgTable("inventory", {
  sku: text("sku")
    .primaryKey()
    .references(() => products.sku),
  onHand: integer("on_hand").notNull(),
  allocated: integer("allocated").notNull(),
  available: integer("available")
    .notNull()
    .generatedAlwaysAs(sql`on_hand - allocated`),
});

export const incomingSupply = pgTable("incoming_supply", {
  id: serial("id").primaryKey(),
  supplierPo: text("supplier_po").notNull(),
  sku: text("sku")
    .notNull()
    .references(() => products.sku),
  qty: integer("qty").notNull(),
  expectedDate: date("expected_date").notNull(),
});

export const salesOrders = pgTable("sales_orders", {
  soNumber: text("so_number").primaryKey(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.customerId),
  shipToId: text("ship_to_id")
    .notNull()
    .references(() => shipToAddresses.shipToId),
  customerPo: text("customer_po"),
  orderDate: date("order_date").notNull(),
  requestedDate: date("requested_date").notNull(),
  status: salesOrderStatus("status").notNull(),
});

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    soNumber: text("so_number")
      .notNull()
      .references(() => salesOrders.soNumber),
    lineNo: integer("line_no").notNull(),
    sku: text("sku")
      .notNull()
      .references(() => products.sku),
    qtyOrdered: integer("qty_ordered").notNull(),
    qtyShipped: integer("qty_shipped").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
  },
  (table) => [primaryKey({ columns: [table.soNumber, table.lineNo] })],
);

// No email in the pack has an attachment, so there is no column for them; the ingest refuses
// an email that has one rather than drop it.
export const emails = pgTable("emails", {
  emailId: text("email_id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  fromName: text("from_name").notNull(),
  fromEmail: text("from_email").notNull(),
  to: text("to").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
});

// A person who signs in (security 1 and 2). Seeded from env vars, never signed up; the hash is
// argon2id, and no plain password is ever stored.
export const userRoles = ["reviewer", "admin"] as const;
export type UserRole = (typeof userRoles)[number];

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: userRoles }).notNull(),
    // When the person dismissed the inbox's tip card; it stays dismissed on every device.
    tipDismissedAt: timestamp("tip_dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("users_role_check", sql`${table.role} in ('reviewer', 'admin')`)],
);

// A signed-in browser. The cookie carries a random token; only its SHA-256 is stored, so a
// read of this table cannot be replayed as a session.
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

// Failed sign-ins per typed username, known or not, so a lock reveals nothing about which
// accounts exist. Five failures inside one 15-minute window lock the name for 15 minutes.
export const signInThrottle = pgTable("sign_in_throttle", {
  username: text("username").primaryKey(),
  failureCount: integer("failure_count").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

// ---- The agent's work -----------------------------------------------------------------------------

// `routed`: the agent flagged the email for a person without proposing an ERP change.
export const agentRunOutcomes = ["released", "proposal", "routed", "no_action", "failed"] as const;
export type AgentRunOutcome = (typeof agentRunOutcomes)[number];

export const gateVerdicts = ["released", "review"] as const;
export type GateVerdict = (typeof gateVerdicts)[number];

// One Agent run over one Email (speed and observability: the Agent run record). A run with no
// `ended_at` is still reading. Cost is integer micro-dollars, so it is never a float.
export const agentRuns = pgTable(
  "agent_runs",
  {
    runId: text("run_id").primaryKey(),
    emailId: text("email_id")
      .notNull()
      .references(() => emails.emailId),
    modelId: text("model_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    modelCalls: integer("model_calls").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    estimatedCostMicroUsd: integer("estimated_cost_micro_usd").notNull().default(0),
    outcome: text("outcome", { enum: agentRunOutcomes }),
    gateVerdict: text("gate_verdict", { enum: gateVerdicts }),
    errorClass: text("error_class"),
  },
  (table) => [
    index("agent_runs_email_id_idx").on(table.emailId),
    check("agent_runs_outcome_check", sql`${table.outcome} in ('released', 'proposal', 'routed', 'no_action', 'failed')`),
    check("agent_runs_gate_verdict_check", sql`${table.gateVerdict} in ('released', 'review')`),
  ],
);

export const proposalStatuses = ["open", "released"] as const;
export type ProposalStatus = (typeof proposalStatuses)[number];

// One release check's result, as the gate recorded it.
export interface RecordedCheck {
  check: string;
  passes: boolean;
  detail: string;
}

// A new order the agent proposed. The gate either released it (`so_number` set) or left it open
// in the review queue with its failing checks. Ship-to and SKUs are the model's words until the
// gate checks them, so they carry no foreign key.
export const proposals = pgTable(
  "proposals",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.runId),
    emailId: text("email_id")
      .notNull()
      .references(() => emails.emailId),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.customerId),
    shipToId: text("ship_to_id").notNull(),
    customerPo: text("customer_po"),
    requestedDate: date("requested_date").notNull(),
    totalCents: integer("total_cents").notNull(),
    status: text("status", { enum: proposalStatuses }).notNull(),
    checks: jsonb("checks").$type<RecordedCheck[]>().notNull(),
    soNumber: text("so_number").references(() => salesOrders.soNumber),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("proposals_email_id_idx").on(table.emailId),
    check("proposals_status_check", sql`${table.status} in ('open', 'released')`),
  ],
);

// The price is always the system's; what the email or the model said is kept beside it.
export const proposalLines = pgTable(
  "proposal_lines",
  {
    proposalId: integer("proposal_id")
      .notNull()
      .references(() => proposals.id),
    lineNo: integer("line_no").notNull(),
    sku: text("sku").notNull(),
    quantity: integer("quantity").notNull(),
    // Null when the SKU is not in the catalog, so there is no system price.
    unitPriceCents: integer("unit_price_cents"),
    priceSource: text("price_source", { enum: ["contract", "list"] }),
    statedPriceCents: integer("stated_price_cents"),
    customerWords: text("customer_words"),
    // The search this line was chosen from, when the customer described the product in words.
    productSearchId: integer("product_search_id").references(() => productSearches.id),
    // The DISCONTINUED SKU the customer asked for, when this line is its replacement (policy 3).
    replacesSku: text("replaces_sku"),
  },
  (table) => [primaryKey({ columns: [table.proposalId, table.lineNo] })],
);

// A `search_products` call and what it found, so the gate can check that a described line cites a
// search that left exactly one ACTIVE candidate (U18), rather than take the model's word for it.
export const productSearches = pgTable("product_searches", {
  id: serial("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.runId),
  emailId: text("email_id")
    .notNull()
    .references(() => emails.emailId),
  query: jsonb("query").$type<Record<string, string>>().notNull(),
  candidateSkus: jsonb("candidate_skus").$type<string[]>().notNull(),
  discontinuedSkus: jsonb("discontinued_skus").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentFlags = pgTable("agent_flags", {
  id: serial("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.runId),
  emailId: text("email_id")
    .notNull()
    .references(() => emails.emailId),
  code: text("code").notNull(),
  note: text("note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A reply the agent wrote for a person to edit and approve. It is never sent.
export const draftReplies = pgTable("draft_replies", {
  id: serial("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.runId),
  emailId: text("email_id")
    .notNull()
    .references(() => emails.emailId),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Who acted: the agent, the release gate, or a named person.
export const auditActors = ["agent", "gate", "person"] as const;
export type AuditActor = (typeof auditActors)[number];

// The append-only event log. Every agent step and gate verdict lands here in the same
// transaction as the change it records.
export const auditEvents = pgTable(
  "audit_events",
  {
    id: serial("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    actor: text("actor", { enum: auditActors }).notNull(),
    userId: integer("user_id").references(() => users.id),
    action: text("action").notNull(),
    emailId: text("email_id").references(() => emails.emailId),
    runId: text("run_id").references(() => agentRuns.runId),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    index("audit_events_email_id_idx").on(table.emailId),
    check("audit_events_actor_check", sql`${table.actor} in ('agent', 'gate', 'person')`),
  ],
);
