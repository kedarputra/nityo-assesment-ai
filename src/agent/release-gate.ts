import { and, eq, inArray, sql, sum } from "drizzle-orm";
import type { Database } from "@/db/database";
import {
  agentFlags,
  auditEvents,
  customerContacts,
  customerPrices,
  customers,
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
import { formatUsd } from "@/lib/money";
import { creditCheck, orderValue, priceFor, sellability, type Price } from "@/rules/business-rules";
import { recordAudit } from "./audit";
import { releaseChecks, type ReleaseCheck } from "./release-checks";
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
}

export interface ProposedNewOrder {
  customerId: string;
  shipToId: string;
  requestedDate: string;
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
  totalCents: number;
  checks: RecordedCheck[];
}

export interface PricedLine extends ProposedLine {
  price: Price | null;
  sellable: boolean;
  available: number | null;
}

const RELEASE_LOCK = 0x48500601;

// The audit actions that name a released sales order: the gate's own and a person's approval.
export const RELEASE_ACTIONS = ["order.released", "proposal.approved"];

// Records the Proposal, runs every check, and releases it when all pass, all in the caller's
// transaction, so a failure part-way leaves no Proposal, order, allocation or audit event behind.
export async function proposeNewOrder(tx: Database, context: GateContext, order: ProposedNewOrder): Promise<GateResult> {
  await lockReleases(tx);

  const { lines, totalCents, checks } = await checkOrder(tx, {
    runId: context.runId,
    senderEmail: context.senderEmail,
    orderDate: context.orderDate,
    customerId: order.customerId,
    shipToId: order.shipToId,
    lines: order.lines,
  });
  const verdict: GateVerdict = checks.every((result) => result.passes) ? "released" : "review";

  const [proposal] = await tx
    .insert(proposals)
    .values({
      runId: context.runId,
      emailId: context.emailId,
      customerId: order.customerId,
      shipToId: order.shipToId,
      customerPo: order.customerPo,
      requestedDate: order.requestedDate,
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
    })),
  );

  const audit = { at: context.at, emailId: context.emailId, runId: context.runId };
  await recordAudit(tx, {
    ...audit,
    actor: "gate",
    action: "gate.verdict",
    detail: { proposalId: proposal.id, verdict, totalCents, failing: checks.filter((result) => !result.passes) },
  });

  if (verdict === "review") {
    return { proposalId: proposal.id, verdict, soNumber: null, totalCents, checks };
  }

  const soNumber = await releaseOrder(tx, {
    proposalId: proposal.id,
    customerId: order.customerId,
    shipToId: order.shipToId,
    customerPo: order.customerPo,
    requestedDate: order.requestedDate,
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
  return { proposalId: proposal.id, verdict, soNumber, totalCents, checks };
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
  senderEmail: string;
  orderDate: string;
  customerId: string;
  shipToId: string;
  lines: ProposedLine[];
}

export interface CheckedOrder {
  lines: PricedLine[];
  totalCents: number;
  checks: RecordedCheck[];
}

// Prices every line at the system's price and runs every release check against the ERP as it
// stands now.
export async function checkOrder(tx: Database, order: OrderToCheck): Promise<CheckedOrder> {
  const [customer] = await tx.select().from(customers).where(eq(customers.customerId, order.customerId));
  if (!customer) throw new ToolError(`There is no customer ${order.customerId}.`);

  const lines = await priceLines(tx, order);
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
  const flags = await tx.select({ code: agentFlags.code }).from(agentFlags).where(eq(agentFlags.runId, order.runId));
  const releasedTodayCents = await releasedTodayFor(tx, customer.customerId);

  const credit = creditCheck({ customer, releasedTodayCents, orderValueCents: totalCents });
  const sender = normaliseAddress(order.senderEmail);
  const checks = evaluate({
    knownContact: contacts.some((contact) => normaliseAddress(contact.email) === sender),
    lines,
    credit,
    shipToIsTheCustomers: shipTo !== undefined,
    flagCodes: flags.map((flag) => flag.code),
  });
  return { lines, totalCents, checks };
}

// The lines a release can carry: every one has a system price once the skus-sellable check passes.
export function sellableLines(lines: PricedLine[]): ReleasedLine[] {
  return lines.flatMap((line) => (line.price ? [{ sku: line.sku, quantity: line.quantity, unitPriceCents: line.price.unitPriceCents }] : []));
}

async function priceLines(tx: Database, order: OrderToCheck): Promise<PricedLine[]> {
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

  return order.lines.map((line) => {
    const product = productRows.find((row) => row.sku === line.sku);
    if (!product) return { ...line, price: null, sellable: false, available: null };
    const price = priceFor({ customerId: order.customerId, orderDate: order.orderDate, product, contracts });
    return {
      ...line,
      price,
      sellable: sellability({ product }).sellable,
      available: stockRows.find((row) => row.sku === line.sku)?.available ?? 0,
    };
  });
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
  const short = shortLines(lines);

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
            detail: `A stated price differs from the system's: ${priceMismatches
              .map((line) => `${line.sku} stated ${formatUsd(line.statedUnitPriceCents ?? 0)}, system ${line.price ? formatUsd(line.price.unitPriceCents) : "none"}`)
              .join("; ")}.`,
          },
    "full-stock":
      short.length === 0
        ? { passes: true, detail: "Every line is fully in stock." }
        : { passes: false, detail: `Not enough available: ${short.join("; ")}.` },
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

// A SKU on several lines needs all of them covered.
function shortLines(lines: PricedLine[]): string[] {
  const wanted = new Map<string, { quantity: number; available: number | null }>();
  for (const line of lines) {
    const entry = wanted.get(line.sku) ?? { quantity: 0, available: line.available };
    entry.quantity += line.quantity;
    wanted.set(line.sku, entry);
  }
  return [...wanted]
    .filter(([, entry]) => entry.available === null || entry.quantity > entry.available)
    .map(([sku, entry]) => `${sku} wants ${entry.quantity}, ${entry.available ?? 0} available`);
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
  await tx.update(proposals).set({ status: "released", soNumber }).where(eq(proposals.id, release.proposalId));
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

function normaliseAddress(address: string): string {
  return address.trim().toLowerCase();
}
