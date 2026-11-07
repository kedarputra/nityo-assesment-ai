import { and, eq, inArray, isNull, sql, sum } from "drizzle-orm";
import type { Database } from "@/db/database";
import {
  agentFlags,
  auditEvents,
  customerContacts,
  customerPrices,
  customers,
  emails,
  incomingSupply,
  inventory,
  productSearches,
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
import { sellingUnitFits, skuCodesIn } from "./product-search";
import { releaseChecks, type ReleaseCheck } from "./release-checks";
import { normaliseAddress } from "./sender";
import { ToolError } from "./tool-error";

// The release gate (ADR 0001): code, not the model, decides whether a proposed new order is a
// Clean order. It prices every line itself, so a price the model or the email names is only ever
// compared, never used.

export interface ProposedLine {
  sku: string;
  quantity: number;
  // A price the email or the model named, per selling unit; compared with the system's price.
  statedUnitPriceCents: number | null;
  customerWords: string | null;
  // The earlier sales order this line repeats, for "same as last time" and "the usual".
  fromSalesOrder: string | null;
  // The `search_products` call the SKU was chosen from, when the customer described it in words.
  productSearchId: number | null;
  // The unit and amount the customer wrote, when they differ from whole selling units (U1).
  unitAsWritten: string | null;
  quantityAsWritten: number | null;
  // The DISCONTINUED SKU the customer asked for, when this line is its replacement (policy 3).
  replacesSku: string | null;
}

export interface ProposedNewOrder {
  customerId: string;
  shipToId: string;
  // The model's reading of the date; the customer's words, when given, are read by code instead.
  requestedDate: string;
  requestedDateWords: string | null;
  customerPo: string | null;
  // U2: the earlier email's Proposal, still waiting for a person, that this order adds to.
  followsProposalId: number | null;
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

type Product = typeof products.$inferSelect;

export interface PricedLine extends ProposedLine {
  product: Product | null;
  price: Price | null;
  sellable: boolean;
  // Null when the SKU is not in the catalog.
  stock: Stock | null;
  // The product this line replaces, with its system price, when it is a substitution.
  replaced: { product: Product; price: Price } | null;
}

export interface CitedSearch {
  runId: string;
  candidateSkus: string[];
  discontinuedSkus: string[];
}

const RELEASE_LOCK = 0x48500601;

// The audit actions that name a released sales order: the gate's own and a person's approval.
export const RELEASE_ACTIONS = ["order.released", "proposal.approved"];

// Records the Proposal, runs every check, and releases it when all pass, all in the caller's
// transaction, so a failure part-way leaves no Proposal, order, allocation or audit event behind.
export async function proposeNewOrder(tx: Database, context: GateContext, order: ProposedNewOrder): Promise<GateResult> {
  await lockReleases(tx);

  const { lines, requested, totalCents, checks } = await checkOrder(tx, {
    runId: context.runId,
    emailId: context.emailId,
    senderEmail: context.senderEmail,
    orderDate: context.orderDate,
    customerId: order.customerId,
    shipToId: order.shipToId,
    requestedDate: order.requestedDate,
    requestedDateWords: order.requestedDateWords,
    lines: order.lines,
  });
  await confirmHistory(tx, order);
  await confirmFollowUp(tx, context, order);
  const verdict: GateVerdict = checks.every((result) => result.passes) ? "released" : "review";

  const [proposal] = await tx
    .insert(proposals)
    .values({
      runId: context.runId,
      emailId: context.emailId,
      customerId: order.customerId,
      shipToId: order.shipToId,
      customerPo: order.customerPo,
      followsProposalId: order.followsProposalId,
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
      productSearchId: line.productSearchId,
      replacesSku: line.replacesSku,
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

  const soNumber = await releaseOrder(tx, {
    proposalId: proposal.id,
    customerId: order.customerId,
    shipToId: order.shipToId,
    customerPo: order.customerPo,
    requestedDate: requested.date,
    orderDate: context.orderDate,
    lines: sellableLines(lines),
  });
  await recordAudit(tx, {
    ...audit,
    actor: "gate",
    action: "order.released",
    detail: {
      proposalId: proposal.id,
      soNumber,
      customerId: order.customerId,
      shipToId: order.shipToId,
      totalCents,
      allocated: lines.map((line) => ({ sku: line.sku, quantity: line.quantity })),
    },
  });
  return { proposalId: proposal.id, verdict, soNumber, ...dates, totalCents, checks };
}

// Releases are serialised, so two runs or two people never allocate the same stock or take the
// same SO number. Every caller that checks and then releases or withdraws takes it first.
export async function lockReleases(tx: Database): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${RELEASE_LOCK})`);
}

// An order as the gate checks it, whether the agent just proposed it or a person edited it.
export interface OrderToCheck {
  // The run's flags count against the order (the no-flags check).
  runId: string;
  // The email's own SKU codes count for the confident-skus and no-substitution checks.
  emailId: string;
  senderEmail: string;
  orderDate: string;
  customerId: string;
  shipToId: string;
  requestedDate: string;
  // The email's own words for the date, which win over the model's reading of them.
  requestedDateWords: string | null;
  lines: ProposedLine[];
}

export interface CheckedOrder {
  lines: PricedLine[];
  requested: ReadDate;
  totalCents: number;
  checks: RecordedCheck[];
}

// Prices every line at the system's price and runs every release check against the ERP as it
// stands now.
export async function checkOrder(tx: Database, order: OrderToCheck): Promise<CheckedOrder> {
  const [customer] = await tx.select().from(customers).where(eq(customers.customerId, order.customerId));
  if (!customer) throw new ToolError(`There is no customer ${order.customerId}.`);

  const [email] = await tx.select({ body: emails.body }).from(emails).where(eq(emails.emailId, order.emailId));
  const codesInEmail = skuCodesIn(email?.body ?? "");
  const lines = await priceLines(tx, order);
  const requested = readRequestedDate(order, order.orderDate);
  const pricedLines = sellableLines(lines);
  const totalCents = pricedLines.length > 0 ? orderValue({ lines: pricedLines }).totalCents : 0;

  const contacts = await tx
    .select({ email: customerContacts.email })
    .from(customerContacts)
    .where(eq(customerContacts.customerId, customer.customerId));
  const shipTos = await tx
    .select({ shipToId: shipToAddresses.shipToId, name: shipToAddresses.name })
    .from(shipToAddresses)
    .where(eq(shipToAddresses.customerId, customer.customerId));
  const runProposals = await tx
    .select({ shipToId: proposals.shipToId })
    .from(proposals)
    .where(eq(proposals.runId, order.runId));
  const flags = await tx.select({ code: agentFlags.code }).from(agentFlags).where(eq(agentFlags.runId, order.runId));
  const releasedTodayCents = await releasedTodayFor(tx, customer.customerId);
  const searches = await citedSearches(tx, lines);
  const catalogCodes =
    codesInEmail.length === 0
      ? []
      : await tx
          .select({ sku: products.sku, status: products.status })
          .from(products)
          .where(inArray(products.sku, codesInEmail));

  const credit = creditCheck({ customer, releasedTodayCents, orderValueCents: totalCents });
  const sender = normaliseAddress(order.senderEmail);
  const checks = evaluate({
    knownContact: contacts.some((contact) => normaliseAddress(contact.email) === sender),
    lines,
    requested,
    credit,
    shipToIsTheCustomers: shipTos.some((shipTo) => shipTo.shipToId === order.shipToId),
    shipTosOfTheEmail: shipTosOfTheEmail({
      shipToId: order.shipToId,
      named: shipTosNamedIn(email?.body ?? "", shipTos),
      proposed: runProposals.map((proposal) => proposal.shipToId),
    }),
    flagCodes: flags.map((flag) => flag.code),
    runId: order.runId,
    codesInEmail,
    catalogCodes,
    searches,
  });
  return { lines, requested, totalCents, checks };
}

// The lines a release can carry: every one has a system price once the skus-sellable check passes.
export function sellableLines(lines: PricedLine[]): ReleasedLine[] {
  return lines.flatMap((line) => (line.price ? [{ sku: line.sku, quantity: line.quantity, unitPriceCents: line.price.unitPriceCents }] : []));
}

export async function priceLines(
  tx: Database,
  order: Pick<OrderToCheck, "customerId" | "orderDate" | "lines">,
): Promise<PricedLine[]> {
  const skus = [...new Set(order.lines.flatMap((line) => (line.replacesSku ? [line.sku, line.replacesSku] : [line.sku])))];
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
    const { orderDate } = order;
    const replacedProduct = productRows.find((row) => row.sku === line.replacesSku);
    const replaced = replacedProduct
      ? { product: replacedProduct, price: priceFor({ customerId: order.customerId, orderDate, product: replacedProduct, contracts }) }
      : null;
    if (!product) return { ...line, product: null, price: null, sellable: false, stock: null, replaced };
    const price = priceFor({ customerId: order.customerId, orderDate, product, contracts });
    return {
      ...line,
      product,
      replaced,
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

// Policy 9 and U2: an order that follows up a pending Proposal is linked to it, never merged
// into it. A follow-up to an order already in the ERP is a change to that order instead.
async function confirmFollowUp(tx: Database, context: GateContext, order: ProposedNewOrder): Promise<void> {
  if (order.followsProposalId === null) return;
  const [earlier] = await tx.select().from(proposals).where(eq(proposals.id, order.followsProposalId));
  if (!earlier || earlier.customerId !== order.customerId) {
    throw new ToolError(`Proposal ${order.followsProposalId} is not one of ${order.customerId}'s Proposals.`);
  }
  if (earlier.emailId === context.emailId) {
    throw new ToolError(`Proposal ${earlier.id} is this email's own; follow up another email's Proposal.`);
  }
  if (earlier.kind !== "new order") {
    throw new ToolError(`Proposal ${earlier.id} is a ${earlier.kind} of ${earlier.targetSoNumber}, not a new order to add to.`);
  }
  if (earlier.status === "released" && earlier.soNumber !== null) {
    throw new ToolError(
      `Proposal ${earlier.id} is already in the ERP as ${earlier.soNumber}; propose_order_change to ${earlier.soNumber} instead (policy 9).`,
    );
  }
  if (earlier.status !== "open" && earlier.status !== "held") {
    throw new ToolError(`Proposal ${earlier.id} was ${earlier.status}; there is no pending order to follow up.`);
  }
}

export interface ReadDate {
  date: string;
  alternative: string | null;
  // The date the customer asked for, when they named one; only that date can be missed.
  customerDate: string | null;
  result: Omit<RecordedCheck, "check">;
}

// The customer's words win over the model's reading of them (U11); a past date (policy 12) or
// words that could mean two days go to a person.
function readRequestedDate(
  order: Pick<OrderToCheck, "requestedDate" | "requestedDateWords">,
  orderDate: string,
): ReadDate {
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
// credit is open_balance + same-day releases + this order). An approved change adds its increase;
// a decrease or a cancellation is not taken off, so the exposure is never understated.
export async function releasedTodayFor(tx: Database, customerId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sum(sql`greatest(${proposals.totalCents}, 0)`).mapWith(Number) })
    .from(proposals)
    .where(and(eq(proposals.customerId, customerId), eq(proposals.status, "released")));
  return row?.total ?? 0;
}

export async function citedSearches(tx: Database, lines: PricedLine[]): Promise<Map<number, CitedSearch>> {
  const ids = [...new Set(lines.flatMap((line) => (line.productSearchId === null ? [] : [line.productSearchId])))];
  if (ids.length === 0) return new Map();
  const rows = await tx.select().from(productSearches).where(inArray(productSearches.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

interface GateFacts {
  knownContact: boolean;
  lines: PricedLine[];
  requested: ReadDate;
  credit: ReturnType<typeof creditCheck>;
  shipToIsTheCustomers: boolean;
  // Every ship-to this email asks for: the order's own, those its body names, and those of the
  // run's other orders.
  shipTosOfTheEmail: string[];
  flagCodes: string[];
  runId: string;
  codesInEmail: string[];
  catalogCodes: { sku: string; status: Product["status"] }[];
  searches: Map<number, CitedSearch>;
}

function evaluate(facts: GateFacts): RecordedCheck[] {
  const { lines, credit } = facts;
  const notSellable = lines.filter((line) => !line.sellable).map((line) => line.sku);
  const priceMismatches = lines.filter(
    (line) => line.statedUnitPriceCents !== null && line.statedUnitPriceCents !== line.price?.unitPriceCents,
  );
  const repeated = [...new Set(lines.flatMap((line) => (line.fromSalesOrder ? [line.fromSalesOrder] : [])))];
  const substitutions = substitutionProblems(facts);
  const unconfident = unconfidentLines(facts);
  const oddUnits = unitProblems(lines);

  const results: Record<ReleaseCheck, Omit<RecordedCheck, "check">> = {
    "known-contact": facts.knownContact
      ? { passes: true, detail: "The sender is a known contact of this customer." }
      : {
          passes: false,
          detail: "P5-unverified-contact: the sender is not a known contact of this customer; verify them with a known contact.",
          flags: ["P5-unverified-contact"],
        },
    "skus-sellable":
      notSellable.length === 0
        ? { passes: true, detail: "Every SKU is in the catalog and active." }
        : { passes: false, detail: `Not in the catalog or discontinued: ${notSellable.join(", ")}.` },
    "no-substitution":
      substitutions.length === 0
        ? { passes: true, detail: "No discontinued product was asked for." }
        : { passes: false, detail: `P3-discontinued: ${substitutions.join(" ")}` },
    "confident-skus":
      unconfident.length === 0
        ? { passes: true, detail: "Every line is a SKU the email names, or the one product its description fits." }
        : { passes: false, detail: `LOW-CONF-sku: ${unconfident.join(" ")}` },
    "selling-units":
      oddUnits.length === 0
        ? { passes: true, detail: "Every quantity is in whole selling units." }
        : { passes: false, detail: `UNIT-ambiguous: ${oddUnits.join(" ")}` },
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
    "single-ship-to":
      facts.shipTosOfTheEmail.length === 1
        ? { passes: true, detail: "The email asks for one delivery address." }
        : {
            passes: false,
            detail: `P7-multi-ship-to: the email asks for ${facts.shipTosOfTheEmail.length} ship-tos (${facts.shipTosOfTheEmail.join(", ")}), one order each; confirm the split.`,
            flags: ["P7-multi-ship-to"],
          },
    "no-flags":
      facts.flagCodes.length === 0
        ? { passes: true, detail: "The agent raised no flags." }
        : { passes: false, detail: `The agent raised: ${facts.flagCodes.join(", ")}.` },
  };
  return releaseChecks.map((check) => ({ check, ...results[check] }));
}

// Policy 7: one email naming several ship-tos is split into one order per ship-to, and each one
// waits for a person (U8). The code reads the ship-tos the body names as well as the orders the run
// proposed, so the first order of a split cannot be released before the model proposes the next.
function shipTosOfTheEmail(found: { shipToId: string; named: string[]; proposed: string[] }): string[] {
  return [...new Set([found.shipToId, ...found.named, ...found.proposed])].sort();
}

// A customer's ship-to is named by what tells it apart: "Metro Fitness - Northgate" by
// "Northgate"; a name with no such part only by the whole name.
export function shipTosNamedIn(body: string, shipTos: readonly { shipToId: string; name: string }[]): string[] {
  if (shipTos.length < 2) return [];
  const text = body.toLowerCase();
  return shipTos
    .filter((shipTo) => {
      const separator = shipTo.name.lastIndexOf(" - ");
      const distinct = separator === -1 ? shipTo.name : shipTo.name.slice(separator + 3);
      return new RegExp(`\\b${escapeRegExp(distinct.toLowerCase())}\\b`).test(text);
    })
    .map((shipTo) => shipTo.shipToId);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Policy 3: a DISCONTINUED product is never swapped on the agent's own authority. A line that
// replaces one waits for a person, and so does any email naming one, in case the model swapped it
// without saying so.
function substitutionProblems({ lines, codesInEmail, catalogCodes }: GateFacts): string[] {
  const problems = lines.flatMap((line) => {
    if (line.replacesSku === null) return [];
    const replaced = line.replaced;
    if (!replaced || replaced.product.status !== "DISCONTINUED" || replaced.product.replacedBy !== line.sku) {
      return [`${line.sku} is not the replacement for ${line.replacesSku}.`];
    }
    const now = line.product && line.price ? `${line.product.pack} at ${formatUsd(line.price.unitPriceCents)}` : "no price";
    return [
      `${line.replacesSku} (${replaced.product.pack} at ${formatUsd(replaced.price.unitPriceCents)}) is discontinued; ${line.sku} (${now}) is swapped in for a person to accept.`,
    ];
  });
  const replacedOnALine = new Set(lines.map((line) => line.replacesSku));
  const discontinuedNamed = catalogCodes
    .filter((product) => product.status === "DISCONTINUED" && !replacedOnALine.has(product.sku))
    .map((product) => product.sku);
  const unsaid = codesInEmail.filter((code) => discontinuedNamed.includes(code));
  if (unsaid.length > 0) problems.push(`The email names discontinued ${unsaid.join(", ")}.`);
  return problems;
}

// U18: a line is confident when the email names its SKU, when it repeats an earlier order that has
// the SKU (confirmHistory; the from-history check asks the customer), or when it cites a search
// this run made that left it as the only ACTIVE candidate and fitted no discontinued product. A
// SKU code in the email that is not in the catalog means some line is a guess.
function unconfidentLines({ lines, runId, codesInEmail, catalogCodes, searches }: GateFacts): string[] {
  const unknownCodes = codesInEmail.filter((code) => !catalogCodes.some((product) => product.sku === code));
  const problems = unknownCodes.map((code) => `The email names ${code}, which is not in the catalog.`);
  for (const line of lines) {
    const asked = line.replacesSku ?? line.sku;
    if (line.productSearchId === null) {
      if (!codesInEmail.includes(asked) && line.fromSalesOrder === null) problems.push(`${asked} is not written in the email and cites no search.`);
      continue;
    }
    const search = searches.get(line.productSearchId);
    if (!search || search.runId !== runId) {
      problems.push(`${line.sku} cites search ${line.productSearchId}, which this run did not make.`);
    } else if (line.replacesSku !== null) {
      if (!sameSkus(search.discontinuedSkus, [line.replacesSku])) {
        problems.push(`The search does not single out ${line.replacesSku}.`);
      }
    } else if (!sameSkus(search.candidateSkus, [line.sku]) || search.discontinuedSkus.length > 0) {
      problems.push(`${line.sku} is not the only product its description fits (${describeSearch(search)}).`);
    }
  }
  return problems;
}

function sameSkus(found: string[], expected: string[]): boolean {
  return found.length === expected.length && found.every((sku, index) => sku === expected[index]);
}

function describeSearch(search: CitedSearch): string {
  const candidates = search.candidateSkus.length > 0 ? search.candidateSkus.join(", ") : "no candidates";
  if (search.discontinuedSkus.length === 0) return candidates;
  return `${candidates}; also fits discontinued ${search.discontinuedSkus.join(", ")}`;
}

// U1: a quantity the customer wrote in another unit, or not in whole selling units, is the
// model's reading, so the customer is asked to confirm it.
export function unitProblems(lines: PricedLine[]): string[] {
  return lines.flatMap((line) => {
    const problems: string[] = [];
    if (line.product && line.unitAsWritten !== null && !sellingUnitFits(line.product, line.unitAsWritten)) {
      problems.push(
        `${line.sku} is sold per ${line.product.sellUom === "CS" ? "case" : "each"} (${line.product.pack}), and the customer wrote "${line.unitAsWritten}"; read as ${line.quantity}.`,
      );
    }
    if (line.quantityAsWritten !== null && line.quantityAsWritten !== line.quantity) {
      problems.push(`${line.sku}: the customer wrote ${line.quantityAsWritten}, read as ${line.quantity}.`);
    }
    return problems;
  });
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
export function stockResult(lines: PricedLine[], customerDate: string | null): Omit<RecordedCheck, "check"> {
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
  if (line.fullBy === null) return `${text}; what is due in never covers all ${line.wanted}, so ${day(customerDate)} cannot be met`;
  return `${text}; the full ${line.wanted} can arrive ${day(line.fullBy)} at the earliest, after the requested ${day(customerDate)}`;
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

export interface ReleasedLine {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Release {
  proposalId: number;
  customerId: string;
  shipToId: string;
  customerPo: string | null;
  requestedDate: string;
  orderDate: string;
  lines: ReleasedLine[];
}

// Creates the sales order and its lines and allocates the stock, which reduces `available`. The
// caller holds the release lock and writes the audit event.
export async function releaseOrder(tx: Database, release: Release): Promise<string> {
  // Claimed first, so a Proposal that already has its order is never released a second time.
  const claimed = await tx
    .update(proposals)
    .set({ status: "released" })
    .where(
      and(
        eq(proposals.id, release.proposalId),
        inArray(proposals.status, ["open", "held"]),
        isNull(proposals.soNumber),
      ),
    )
    .returning({ id: proposals.id });
  if (claimed.length === 0) throw new Error(`Proposal ${release.proposalId} is already released or decided.`);
  const soNumber = await nextSoNumber(tx);
  await tx.insert(salesOrders).values({
    soNumber,
    customerId: release.customerId,
    shipToId: release.shipToId,
    customerPo: release.customerPo,
    orderDate: release.orderDate,
    requestedDate: release.requestedDate,
    status: "OPEN",
  });
  await tx.insert(salesOrderLines).values(
    release.lines.map((line, index) => ({
      soNumber,
      lineNo: index + 1,
      sku: line.sku,
      qtyOrdered: line.quantity,
      qtyShipped: 0,
      unitPriceCents: line.unitPriceCents,
    })),
  );
  for (const line of release.lines) {
    await tx
      .update(inventory)
      .set({ allocated: sql`${inventory.allocated} + ${line.quantity}` })
      .where(eq(inventory.sku, line.sku));
  }
  await tx.update(proposals).set({ soNumber }).where(eq(proposals.id, release.proposalId));
  return soNumber;
}

// Undoes a release: the sales order and its lines go, and their stock is returned. The caller
// holds the release lock, reopens the Proposal and writes the audit event.
export async function withdrawOrder(tx: Database, soNumber: string): Promise<{ sku: string; quantity: number }[]> {
  const lines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.soNumber, soNumber));
  for (const line of lines) {
    await tx
      .update(inventory)
      .set({ allocated: sql`${inventory.allocated} - ${line.qtyOrdered}` })
      .where(eq(inventory.sku, line.sku));
  }
  await tx.update(proposals).set({ soNumber: null }).where(eq(proposals.soNumber, soNumber));
  await tx.delete(salesOrderLines).where(eq(salesOrderLines.soNumber, soNumber));
  await tx.delete(salesOrders).where(eq(salesOrders.soNumber, soNumber));
  return lines.map((line) => ({ sku: line.sku, quantity: line.qtyOrdered }));
}

// A withdrawn order's number is never reused, so the audit log's "Released SO-…" events each name
// one order; the log is append-only, so it still holds every number ever released.
async function nextSoNumber(tx: Database): Promise<string> {
  const rows = await tx.select({ soNumber: salesOrders.soNumber }).from(salesOrders);
  const released = await tx
    .select({ soNumber: sql<string | null>`${auditEvents.detail} ->> 'soNumber'` })
    .from(auditEvents)
    .where(inArray(auditEvents.action, RELEASE_ACTIONS));
  const numbers = [...rows.map((row) => row.soNumber), ...released.flatMap((row) => (row.soNumber ? [row.soNumber] : []))];
  const highest = numbers.reduce((max, soNumber) => {
    const match = /^SO-(\d+)$/.exec(soNumber);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `SO-${highest + 1}`;
}
