import { and, eq, inArray, sql, sum } from "drizzle-orm";
import type { Database } from "@/db/database";
import {
  agentFlags,
  customerContacts,
  customerPrices,
  customers,
  incomingSupply,
  inventory,
  products,
  proposalLines,
  proposals,
  salesOrderLines,
  salesOrders,
  shipToAddresses,
  type GateVerdict,
  type RecordedCheck,
} from "@/db/schema";
import { formatBusinessDay } from "@/lib/business-clock";
import { formatUsd } from "@/lib/money";
import { creditCheck, orderValue, priceFor, sellability, stockFor, type Price, type Stock } from "@/rules/business-rules";
import { resolveRequestedDate } from "@/rules/requested-date";
import { shortStock, type ShortStock, type ShortStockChoice } from "@/rules/short-stock";
import { recordAudit } from "./audit";
import { ToolError } from "./tool-error";

// The release gate (ADR 0001): code, not the model, decides whether a proposed new order is a
// Clean order. It prices every line itself, so a price the model or the email names is only ever
// compared, never used.

// Every release check, in the order a person reads them.
export const releaseChecks = [
  "known-contact",
  "skus-sellable",
  "system-price",
  "full-stock",
  "requested-date",
  "from-history",
  "credit-hold",
  "credit-limit",
  "ship-to",
  "no-flags",
] as const;
export type ReleaseCheck = (typeof releaseChecks)[number];

export interface ProposedLine {
  sku: string;
  quantity: number;
  // A price the email or the model named, per selling unit; compared with the system's price.
  statedUnitPriceCents: number | null;
  customerWords: string | null;
  // The earlier sales order this line repeats, for "same as last time" and "the usual".
  fromSalesOrder: string | null;
}

export interface ProposedNewOrder {
  customerId: string;
  shipToId: string;
  // The model's reading of the date; the customer's words, when given, are read by code instead.
  requestedDate: string;
  requestedDateWords: string | null;
  customerPo: string | null;
  lines: ProposedLine[];
}

export interface GateContext {
  runId: string;
  emailId: string;
  senderEmail: string;
  orderDate: string;
  at: Date;
}

export interface GateResult {
  proposalId: number;
  verdict: GateVerdict;
  soNumber: string | null;
  requestedDate: string;
  requestedDateAlternative: string | null;
  totalCents: number;
  checks: RecordedCheck[];
}

interface PricedLine extends ProposedLine {
  price: Price | null;
  sellable: boolean;
  // Null when the SKU is not in the catalog.
  stock: Stock | null;
}

// Releases are serialised, so two runs never allocate the same stock or take the same SO number.
const RELEASE_LOCK = 0x48500601;

// Records the Proposal, runs every check, and releases it when all pass, all in the caller's
// transaction, so a failure part-way leaves no Proposal, order, allocation or audit event behind.
export async function proposeNewOrder(tx: Database, context: GateContext, order: ProposedNewOrder): Promise<GateResult> {
  await tx.execute(sql`select pg_advisory_xact_lock(${RELEASE_LOCK})`);

  const [customer] = await tx.select().from(customers).where(eq(customers.customerId, order.customerId));
  if (!customer) throw new ToolError(`There is no customer ${order.customerId}.`);

  const lines = await priceLines(tx, order, context.orderDate);
  await confirmHistory(tx, order);
  const requested = readRequestedDate(order, context.orderDate);
  const pricedLines = lines.flatMap((line) =>
    line.price ? [{ sku: line.sku, quantity: line.quantity, unitPriceCents: line.price.unitPriceCents }] : [],
  );
  const totalCents = pricedLines.length > 0 ? orderValue({ lines: pricedLines }).totalCents : 0;

  const contacts = await tx
    .select({ email: customerContacts.email })
    .from(customerContacts)
    .where(eq(customerContacts.customerId, customer.customerId));
  const [shipTo] = await tx
    .select({ shipToId: shipToAddresses.shipToId })
    .from(shipToAddresses)
    .where(and(eq(shipToAddresses.shipToId, order.shipToId), eq(shipToAddresses.customerId, customer.customerId)));
  const flags = await tx.select({ code: agentFlags.code }).from(agentFlags).where(eq(agentFlags.runId, context.runId));
  const releasedTodayCents = await releasedTodayFor(tx, customer.customerId);

  const credit = creditCheck({ customer, releasedTodayCents, orderValueCents: totalCents });
  const sender = normaliseAddress(context.senderEmail);
  const checks = evaluate({
    knownContact: contacts.some((contact) => normaliseAddress(contact.email) === sender),
    lines,
    requested,
    credit,
    shipToIsTheCustomers: shipTo !== undefined,
    flagCodes: flags.map((flag) => flag.code),
  });
  const verdict: GateVerdict = checks.every((result) => result.passes) ? "released" : "review";

  const [proposal] = await tx
    .insert(proposals)
    .values({
      runId: context.runId,
      emailId: context.emailId,
      customerId: customer.customerId,
      shipToId: order.shipToId,
      customerPo: order.customerPo,
      requestedDate: requested.date,
      requestedDateWords: order.requestedDateWords,
      requestedDateAlternative: requested.alternative,
      totalCents,
      status: "open",
      checks,
    })
    .returning({ id: proposals.id });
  if (!proposal) throw new Error("The Proposal was not stored.");
  await tx.insert(proposalLines).values(
    lines.map((line, index) => ({
      proposalId: proposal.id,
      lineNo: index + 1,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceCents: line.price?.unitPriceCents ?? null,
      priceSource: line.price?.source ?? null,
      statedPriceCents: line.statedUnitPriceCents,
      customerWords: line.customerWords,
      fromSalesOrder: line.fromSalesOrder,
    })),
  );

  const audit = { at: context.at, emailId: context.emailId, runId: context.runId };
  await recordAudit(tx, {
    ...audit,
    actor: "gate",
    action: "gate.verdict",
    detail: { proposalId: proposal.id, verdict, totalCents, failing: checks.filter((result) => !result.passes) },
  });

  const dates = { requestedDate: requested.date, requestedDateAlternative: requested.alternative };
  if (verdict === "review") {
    return { proposalId: proposal.id, verdict, soNumber: null, ...dates, totalCents, checks };
  }

  const soNumber = await release(tx, {
    proposalId: proposal.id,
    order: { ...order, requestedDate: requested.date },
    orderDate: context.orderDate,
    lines: lines.flatMap((line) => (line.price ? [{ ...line, unitPriceCents: line.price.unitPriceCents }] : [])),
  });
  await recordAudit(tx, {
    ...audit,
    actor: "gate",
    action: "order.released",
    detail: {
      proposalId: proposal.id,
      soNumber,
      customerId: customer.customerId,
      shipToId: order.shipToId,
      totalCents,
      allocated: lines.map((line) => ({ sku: line.sku, quantity: line.quantity })),
    },
  });
  return { proposalId: proposal.id, verdict, soNumber, ...dates, totalCents, checks };
}

async function priceLines(tx: Database, order: ProposedNewOrder, orderDate: string): Promise<PricedLine[]> {
  const skus = [...new Set(order.lines.map((line) => line.sku))];
  const productRows = await tx.select().from(products).where(inArray(products.sku, skus));
  const contracts = await tx
    .select()
    .from(customerPrices)
    .where(and(eq(customerPrices.customerId, order.customerId), inArray(customerPrices.sku, skus)));
  const stockRows = await tx
    .select({ sku: inventory.sku, available: inventory.available })
    .from(inventory)
    .where(inArray(inventory.sku, skus));
  const incoming = await tx.select().from(incomingSupply).where(inArray(incomingSupply.sku, skus));

  return order.lines.map((line) => {
    const product = productRows.find((row) => row.sku === line.sku);
    if (!product) return { ...line, price: null, sellable: false, stock: null };
    const price = priceFor({ customerId: order.customerId, orderDate, product, contracts });
    return {
      ...line,
      price,
      sellable: sellability({ product }).sellable,
      stock: stockFor({
        sku: line.sku,
        available: stockRows.find((row) => row.sku === line.sku)?.available ?? 0,
        incoming,
      }),
    };
  });
}

// A line that says it repeats an earlier order must name one of this customer's orders that has
// the SKU; anything else is the model's mistake to correct, not a Proposal to store.
async function confirmHistory(tx: Database, order: ProposedNewOrder): Promise<void> {
  const cited = [...new Set(order.lines.flatMap((line) => (line.fromSalesOrder ? [line.fromSalesOrder] : [])))];
  if (cited.length === 0) return;
  const history = await tx
    .select({ soNumber: salesOrders.soNumber, sku: salesOrderLines.sku })
    .from(salesOrders)
    .innerJoin(salesOrderLines, eq(salesOrderLines.soNumber, salesOrders.soNumber))
    .where(and(eq(salesOrders.customerId, order.customerId), inArray(salesOrders.soNumber, cited)));
  for (const line of order.lines) {
    if (line.fromSalesOrder === null) continue;
    if (!history.some((row) => row.soNumber === line.fromSalesOrder && row.sku === line.sku)) {
      throw new ToolError(`${line.fromSalesOrder} is not one of ${order.customerId}'s orders with ${line.sku}.`);
    }
  }
}

interface ReadDate {
  date: string;
  alternative: string | null;
  // The date the customer asked for, when they named one; only that date can be missed.
  customerDate: string | null;
  result: Omit<RecordedCheck, "check">;
}

// The customer's words win over the model's reading of them (U11); a past date (policy 12) or
// words that could mean two days go to a person.
function readRequestedDate(order: ProposedNewOrder, orderDate: string): ReadDate {
  const words = order.requestedDateWords;
  if (words === null) {
    const past = order.requestedDate < orderDate;
    return {
      date: order.requestedDate,
      alternative: null,
      customerDate: null,
      result: past
        ? { passes: false, detail: `${day(order.requestedDate)} has already passed.`, flags: ["P12-past-date"] }
        : { passes: true, detail: `Wanted ${day(order.requestedDate)}; the email names no date.` },
    };
  }

  const resolved = resolveRequestedDate(words, orderDate);
  switch (resolved.kind) {
    case "on":
      return {
        date: resolved.date,
        alternative: null,
        customerDate: resolved.date,
        result: resolved.past
          ? {
              passes: false,
              detail: `“${words}” is ${day(resolved.date)}, which has already passed; ask for a new date.`,
              flags: ["P12-past-date"],
            }
          : { passes: true, detail: `“${words}” is ${day(resolved.date)}.` },
      };
    case "ambiguous": {
      const [first, second] = resolved.dates;
      const date = order.requestedDate === second ? second : first;
      return {
        date,
        alternative: date === first ? second : first,
        customerDate: date,
        result: { passes: false, detail: `${resolved.reason}; ask the customer which.`, flags: ["DATE-ambiguous"] },
      };
    }
    case "unreadable":
      return {
        date: order.requestedDate,
        alternative: null,
        customerDate: order.requestedDate,
        result: {
          passes: false,
          detail: `“${words}” is not a date the system can read; the agent took it as ${day(order.requestedDate)}. Confirm it with the customer.`,
          flags: ["DATE-ambiguous"],
        },
      };
  }
}

// What this customer's orders released earlier today add to their exposure (ticket 09 of the map:
// credit is open_balance + same-day releases + this order).
export async function releasedTodayFor(tx: Database, customerId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sum(proposals.totalCents).mapWith(Number) })
    .from(proposals)
    .where(and(eq(proposals.customerId, customerId), eq(proposals.status, "released")));
  return row?.total ?? 0;
}

interface GateFacts {
  knownContact: boolean;
  lines: PricedLine[];
  requested: ReadDate;
  credit: ReturnType<typeof creditCheck>;
  shipToIsTheCustomers: boolean;
  flagCodes: string[];
}

function evaluate(facts: GateFacts): RecordedCheck[] {
  const { lines, credit } = facts;
  const notSellable = lines.filter((line) => !line.sellable).map((line) => line.sku);
  const priceMismatches = lines.filter(
    (line) => line.statedUnitPriceCents !== null && line.statedUnitPriceCents !== line.price?.unitPriceCents,
  );
  const repeated = [...new Set(lines.flatMap((line) => (line.fromSalesOrder ? [line.fromSalesOrder] : [])))];

  const results: Record<ReleaseCheck, Omit<RecordedCheck, "check">> = {
    "known-contact": facts.knownContact
      ? { passes: true, detail: "The sender is a known contact of this customer." }
      : { passes: false, detail: "The sender is not a known contact of this customer." },
    "skus-sellable":
      notSellable.length === 0
        ? { passes: true, detail: "Every SKU is in the catalog and active." }
        : { passes: false, detail: `Not in the catalog or discontinued: ${notSellable.join(", ")}.` },
    "system-price":
      priceMismatches.length === 0
        ? { passes: true, detail: "Every line is at the system's price." }
        : {
            passes: false,
            detail: `The order keeps the system's price; the email's differs: ${priceMismatches.map(describePriceDifference).join("; ")}.`,
            flags: ["P4-price-differs"],
          },
    "full-stock": stockResult(lines, facts.requested.customerDate),
    "requested-date": facts.requested.result,
    "from-history":
      repeated.length === 0
        ? { passes: true, detail: "Every line is one the customer wrote out." }
        : {
            passes: false,
            detail: `Lines rebuilt from ${repeated.join(", ")}; the customer confirms them.`,
            flags: ["P8-from-history"],
          },
    "credit-hold": credit.status.passes
      ? { passes: true, detail: "The customer is not on credit hold." }
      : { passes: false, detail: "The customer is on CREDIT_HOLD." },
    "credit-limit": credit.limit.passes
      ? {
          passes: true,
          detail: `Exposure ${formatUsd(credit.limit.exposureCents)} is within the ${formatUsd(credit.limit.creditLimitCents)} limit.`,
        }
      : {
          passes: false,
          detail: `Exposure ${formatUsd(credit.limit.exposureCents)} exceeds the ${formatUsd(credit.limit.creditLimitCents)} limit by ${formatUsd(credit.limit.exceedsByCents)}.`,
        },
    "ship-to": facts.shipToIsTheCustomers
      ? { passes: true, detail: "The ship-to is one of this customer's addresses." }
      : { passes: false, detail: "The ship-to is not one of this customer's addresses." },
    "no-flags":
      facts.flagCodes.length === 0
        ? { passes: true, detail: "The agent raised no flags." }
        : { passes: false, detail: `The agent raised: ${facts.flagCodes.join(", ")}.` },
  };
  return releaseChecks.map((check) => ({ check, ...results[check] }));
}

function describePriceDifference(line: PricedLine): string {
  const stated = `${line.sku} stated ${formatUsd(line.statedUnitPriceCents ?? 0)}`;
  if (!line.price) return `${stated}, but it has no system price`;
  const system = `${stated}, system ${formatUsd(line.price.unitPriceCents)} (${line.price.source})`;
  const lapsed = line.price.source === "list" ? line.price.expiredContract : null;
  // E024: the customer remembers a contract that has since ended.
  return lapsed ? `${system}; the ${formatUsd(lapsed.unitPriceCents)} contract ended ${day(lapsed.validTo)}` : system;
}

// Short stock is never released (policy 2): the check shows what is available and due in, and
// what a person can choose. A date the stock cannot meet is flagged and adds declining (U10).
function stockResult(lines: PricedLine[], customerDate: string | null): Omit<RecordedCheck, "check"> {
  const notInCatalog: string[] = [];
  const short: ShortStock[] = [];
  for (const [sku, wanted] of wantedBySku(lines)) {
    const stock = lines.find((line) => line.sku === sku)?.stock ?? null;
    if (stock === null) notInCatalog.push(sku);
    else if (wanted > stock.available) short.push(shortStock({ wanted, stock, requestedDate: customerDate }));
  }
  if (notInCatalog.length === 0 && short.length === 0) return { passes: true, detail: "Every line is fully in stock." };

  const details = [
    ...short.map((line) => describeShortStock(line, customerDate)),
    ...notInCatalog.map((sku) => `${sku} is not in the catalog, so it has no stock`),
  ];
  const flags = short.length > 0 ? ["P2-short-stock"] : [];
  if (short.some((line) => line.dateUnmeetable)) flags.push("DATE-unmeetable");
  const choices = short.flatMap((line) =>
    line.choices.filter((choice) => choice.kind !== "decline").map((choice) => `${line.sku}: ${describeChoice(choice, line)}`),
  );
  if (short.some((line) => line.choices.some((choice) => choice.kind === "decline"))) choices.push("Decline the order");
  return { passes: false, detail: `Not enough available: ${details.join("; ")}.`, flags, choices };
}

// A SKU on several lines needs all of them covered.
function wantedBySku(lines: PricedLine[]): Map<string, number> {
  const wanted = new Map<string, number>();
  for (const line of lines) wanted.set(line.sku, (wanted.get(line.sku) ?? 0) + line.quantity);
  return wanted;
}

function describeShortStock(line: ShortStock, customerDate: string | null): string {
  const incoming =
    line.incoming.length === 0
      ? "none due in"
      : line.incoming.map((delivery) => `${delivery.qty} due ${day(delivery.expectedDate)} (${delivery.supplierPo})`).join(", ");
  const text = `${line.sku} wants ${line.wanted}, ${line.available} available, ${incoming}`;
  if (!line.dateUnmeetable || customerDate === null) return text;
  const earliest = line.fullBy ? `not before ${day(line.fullBy)}` : "not with what is due in";
  return `${text}; all ${line.wanted} can arrive ${earliest}, after the requested ${day(customerDate)}`;
}

function describeChoice(choice: Exclude<ShortStockChoice, { kind: "decline" }>, line: ShortStock): string {
  switch (choice.kind) {
    case "partial":
      return choice.laterBy
        ? `ship ${choice.now} now and the other ${choice.later} from ${day(choice.laterBy)}`
        : `ship ${choice.now} now; nothing due in covers the other ${choice.later}`;
    case "backorder":
      return `backorder all ${line.wanted} for ${day(choice.by)}`;
  }
}

// "Fri 6 Nov"; a calendar day read at noon at Harbor Point stays on that day.
function day(isoDate: string): string {
  return formatBusinessDay(new Date(`${isoDate}T12:00:00-05:00`));
}

interface Release {
  proposalId: number;
  order: ProposedNewOrder;
  orderDate: string;
  lines: (PricedLine & { unitPriceCents: number })[];
}

// Creates the sales order and its lines and allocates the stock, which reduces `available`.
async function release(tx: Database, { proposalId, order, orderDate, lines }: Release): Promise<string> {
  const soNumber = await nextSoNumber(tx);
  await tx.insert(salesOrders).values({
    soNumber,
    customerId: order.customerId,
    shipToId: order.shipToId,
    customerPo: order.customerPo,
    orderDate,
    requestedDate: order.requestedDate,
    status: "OPEN",
  });
  await tx.insert(salesOrderLines).values(
    lines.map((line, index) => ({
      soNumber,
      lineNo: index + 1,
      sku: line.sku,
      qtyOrdered: line.quantity,
      qtyShipped: 0,
      unitPriceCents: line.unitPriceCents,
    })),
  );
  for (const line of lines) {
    await tx
      .update(inventory)
      .set({ allocated: sql`${inventory.allocated} + ${line.quantity}` })
      .where(eq(inventory.sku, line.sku));
  }
  await tx.update(proposals).set({ status: "released", soNumber }).where(eq(proposals.id, proposalId));
  return soNumber;
}

async function nextSoNumber(tx: Database): Promise<string> {
  const rows = await tx.select({ soNumber: salesOrders.soNumber }).from(salesOrders);
  const highest = rows.reduce((max, row) => {
    const match = /^SO-(\d+)$/.exec(row.soNumber);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `SO-${highest + 1}`;
}

function normaliseAddress(address: string): string {
  return address.trim().toLowerCase();
}
