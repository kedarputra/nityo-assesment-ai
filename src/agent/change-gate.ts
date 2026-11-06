import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/database";
import {
  agentFlags,
  customerContacts,
  customers,
  emails,
  inventory,
  proposalLines,
  proposals,
  salesOrderLines,
  salesOrders,
  type ProposalKind,
  type RecordedCheck,
} from "@/db/schema";
import { formatUsd } from "@/lib/money";
import { BusinessRuleError, checkOrderEdit, creditCheck, type OrderEdit } from "@/rules/business-rules";
import { recordAudit } from "./audit";
import { skuCodesIn } from "./product-search";
import { changeChecks, type ChangeCheck } from "./release-checks";
import {
  citedSearches,
  lockReleases,
  normaliseAddress,
  priceLines,
  releasedTodayFor,
  stockResult,
  unitProblems,
  type GateContext,
  type PricedLine,
} from "./release-gate";
import { ToolError } from "./tool-error";

// Changes and cancellations of an existing sales order (charting, "Requests that are not new
// orders"). The agent never applies one: each is a Proposal that waits for a person, checked here
// against the README's edit rules (the business-rules module) and, for what it adds, against
// stock and credit. Only a person's approval applies it, with its stock, in one transaction.

export type ChangeKind = Exclude<ProposalKind, "new order">;

// One change to the target order, signed: +5 on line 1, a line added, or −20 as a line is cancelled.
export interface OrderLineChange {
  // The target order's line; null for a line added.
  orderLineNo: number | null;
  sku: string;
  delta: number;
  customerWords: string | null;
  productSearchId: number | null;
  // The unit and amount the customer wrote, when they differ from whole selling units (U1).
  unitAsWritten: string | null;
  quantityAsWritten: number | null;
}

interface CustomerWords {
  customerWords: string | null;
  unitAsWritten: string | null;
  quantityAsWritten: number | null;
}

export interface ProposedChange {
  customerId: string;
  soNumber: string;
  // The new ordered quantity of each existing line that changes; 0 removes what is left of it.
  lineChanges: ({ lineNo: number; quantity: number } & CustomerWords)[];
  addedLines: ({ sku: string; quantity: number; productSearchId: number | null } & CustomerWords)[];
}

export interface PricedChange extends OrderLineChange {
  // The order line's own price for an existing line; the system's price today for a line added.
  unitPriceCents: number | null;
  priceSource: "contract" | "list" | null;
}

export interface CheckedChange {
  lines: PricedChange[];
  // The change in the order's value: +575.00, or −1,500.00 for a cancellation.
  totalCents: number;
  checks: RecordedCheck[];
}

export interface ChangeResult {
  proposalId: number;
  kind: ChangeKind;
  soNumber: string;
  totalCents: number;
  checks: RecordedCheck[];
  // Each changed line as before → after, for the model's reply.
  lines: { lineNo: number | null; sku: string; before: number; after: number; unitPriceCents: number | null }[];
}

type SalesOrder = typeof salesOrders.$inferSelect;
type SalesOrderLine = typeof salesOrderLines.$inferSelect;

export interface TargetOrder {
  order: SalesOrder;
  lines: SalesOrderLine[];
}

export async function proposeOrderChange(tx: Database, context: GateContext, change: ProposedChange): Promise<ChangeResult> {
  await lockReleases(tx);
  const target = await targetOrder(tx, change.soNumber);
  requireCustomersOrder(target, change.customerId);
  return storeChangeProposal(tx, context, "order change", target, requestedChanges(target, change));
}

// A cancellation takes every line down to what has shipped. On a PARTIALLY_SHIPPED or SHIPPED
// order the edit rules refuse it, and the Proposal says so for a person to reject.
export async function proposeCancellation(
  tx: Database,
  context: GateContext,
  cancellation: { customerId: string; soNumber: string },
): Promise<ChangeResult> {
  await lockReleases(tx);
  const target = await targetOrder(tx, cancellation.soNumber);
  requireCustomersOrder(target, cancellation.customerId);
  return storeChangeProposal(tx, context, "cancellation", target, cancellationChanges(target));
}

export async function targetOrder(tx: Database, soNumber: string): Promise<TargetOrder> {
  const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.soNumber, soNumber));
  if (!order) throw new ToolError(`There is no sales order ${soNumber}.`);
  const lines = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.soNumber, soNumber))
    .orderBy(asc(salesOrderLines.lineNo));
  return { order, lines };
}

// The model names the customer as well as the order, so an email can never reach another
// customer's order by its number alone.
function requireCustomersOrder({ order }: TargetOrder, customerId: string): void {
  if (order.customerId !== customerId) throw new ToolError(`${order.soNumber} is not one of ${customerId}'s orders.`);
}

function requestedChanges(target: TargetOrder, change: ProposedChange): OrderLineChange[] {
  const { soNumber } = target.order;
  if (change.lineChanges.length === 0 && change.addedLines.length === 0) {
    throw new ToolError("Name at least one line to change or add.");
  }
  const seen = new Set<number>();
  const changed = change.lineChanges.map((lineChange) => {
    const line = target.lines.find((candidate) => candidate.lineNo === lineChange.lineNo);
    if (!line) {
      const lineNos = target.lines.map((candidate) => candidate.lineNo).join(", ");
      throw new ToolError(`${soNumber} has no line ${lineChange.lineNo}; its lines are ${lineNos}.`);
    }
    if (seen.has(line.lineNo)) throw new ToolError(`Line ${line.lineNo} is changed twice; give its new quantity once.`);
    seen.add(line.lineNo);
    if (lineChange.quantity === line.qtyOrdered) {
      throw new ToolError(`${soNumber} line ${line.lineNo} is already ${line.qtyOrdered}; that is no change.`);
    }
    return {
      orderLineNo: line.lineNo,
      sku: line.sku,
      delta: lineChange.quantity - line.qtyOrdered,
      customerWords: lineChange.customerWords,
      productSearchId: null,
      unitAsWritten: lineChange.unitAsWritten,
      quantityAsWritten: lineChange.quantityAsWritten,
    };
  });
  const added = change.addedLines.map((line) => ({
    orderLineNo: null,
    sku: line.sku,
    delta: line.quantity,
    customerWords: line.customerWords,
    productSearchId: line.productSearchId,
    unitAsWritten: line.unitAsWritten,
    quantityAsWritten: line.quantityAsWritten,
  }));
  return [...changed, ...added];
}

function cancellationChanges(target: TargetOrder): OrderLineChange[] {
  return target.lines.flatMap((line) => {
    const unshipped = line.qtyOrdered - line.qtyShipped;
    if (unshipped <= 0) return [];
    return [
      {
        orderLineNo: line.lineNo,
        sku: line.sku,
        delta: -unshipped,
        customerWords: null,
        productSearchId: null,
        unitAsWritten: null,
        quantityAsWritten: null,
      },
    ];
  });
}

async function storeChangeProposal(
  tx: Database,
  context: GateContext,
  kind: ChangeKind,
  target: TargetOrder,
  changes: OrderLineChange[],
): Promise<ChangeResult> {
  const { order } = target;
  const checked = await checkChange(tx, { ...context, kind, target, changes });
  const [proposal] = await tx
    .insert(proposals)
    .values({
      runId: context.runId,
      emailId: context.emailId,
      customerId: order.customerId,
      shipToId: order.shipToId,
      customerPo: order.customerPo,
      requestedDate: order.requestedDate,
      totalCents: checked.totalCents,
      kind,
      targetSoNumber: order.soNumber,
      // A change is never applied on the agent's own authority: it always waits for a person.
      status: "open",
      checks: checked.checks,
    })
    .returning({ id: proposals.id });
  if (!proposal) throw new Error("The Proposal was not stored.");
  await storeLines(tx, proposal.id, checked.lines);
  await recordAudit(tx, {
    at: context.at,
    actor: "gate",
    action: "gate.verdict",
    emailId: context.emailId,
    runId: context.runId,
    detail: {
      proposalId: proposal.id,
      kind,
      soNumber: order.soNumber,
      verdict: "review",
      totalCents: checked.totalCents,
      failing: checked.checks.filter((check) => !check.passes),
    },
  });
  return {
    proposalId: proposal.id,
    kind,
    soNumber: order.soNumber,
    totalCents: checked.totalCents,
    checks: checked.checks,
    lines: checked.lines.map((line) => {
      const before = beforeQuantity(target, line);
      return { lineNo: line.orderLineNo, sku: line.sku, before, after: before + line.delta, unitPriceCents: line.unitPriceCents };
    }),
  };
}

async function storeLines(tx: Database, proposalId: number, lines: PricedChange[]): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(proposalLines).values(
    lines.map((line, index) => ({
      proposalId,
      lineNo: index + 1,
      sku: line.sku,
      quantity: line.delta,
      unitPriceCents: line.unitPriceCents,
      priceSource: line.priceSource,
      customerWords: line.customerWords,
      productSearchId: line.productSearchId,
      orderLineNo: line.orderLineNo,
    })),
  );
}

function beforeQuantity(target: TargetOrder, line: OrderLineChange): number {
  if (line.orderLineNo === null) return 0;
  return target.lines.find((candidate) => candidate.lineNo === line.orderLineNo)?.qtyOrdered ?? 0;
}

interface ChangeToCheck {
  runId: string;
  emailId: string;
  senderEmail: string;
  orderDate: string;
  kind: ChangeKind;
  target: TargetOrder;
  changes: OrderLineChange[];
}

// Checks the changes against the order as it stands now: the edit rules first, then what any
// increase needs. A decrease frees stock and credit, so only increases are checked for them.
export async function checkChange(tx: Database, change: ChangeToCheck): Promise<CheckedChange> {
  const { order } = change.target;
  const [customer] = await tx.select().from(customers).where(eq(customers.customerId, order.customerId));
  if (!customer) throw new Error(`${order.soNumber}'s customer ${order.customerId} is missing.`);

  const priced = await priceLines(tx, {
    customerId: order.customerId,
    orderDate: change.orderDate,
    lines: change.changes.map((line) => ({
      sku: line.sku,
      // The quantity the customer asked for: the line's new total, or the whole of a line added.
      quantity: beforeQuantity(change.target, line) + line.delta,
      statedUnitPriceCents: null,
      customerWords: line.customerWords,
      fromSalesOrder: null,
      productSearchId: line.productSearchId,
      unitAsWritten: line.unitAsWritten,
      quantityAsWritten: line.quantityAsWritten,
      replacesSku: null,
    })),
  });
  const lines = change.changes.map((line, index): PricedChange => {
    const orderLine = change.target.lines.find((candidate) => candidate.lineNo === line.orderLineNo);
    if (orderLine) return { ...line, unitPriceCents: orderLine.unitPriceCents, priceSource: null };
    const price = priced[index]?.price ?? null;
    return { ...line, unitPriceCents: price?.unitPriceCents ?? null, priceSource: price?.source ?? null };
  });
  const totalCents = lines.reduce((sum, line) => sum + line.delta * (line.unitPriceCents ?? 0), 0);
  if (!Number.isSafeInteger(totalCents)) throw new BusinessRuleError("the change in value is too large");

  const contacts = await tx
    .select({ email: customerContacts.email })
    .from(customerContacts)
    .where(eq(customerContacts.customerId, customer.customerId));
  const flags = await tx.select({ code: agentFlags.code }).from(agentFlags).where(eq(agentFlags.runId, change.runId));
  const [email] = await tx.select({ body: emails.body }).from(emails).where(eq(emails.emailId, change.emailId));
  const increaseCents = Math.max(totalCents, 0);
  const credit = creditCheck({
    customer,
    releasedTodayCents: await releasedTodayFor(tx, customer.customerId),
    orderValueCents: increaseCents,
  });
  const sender = normaliseAddress(change.senderEmail);

  const results: Record<ChangeCheck, Omit<RecordedCheck, "check">> = {
    "known-contact": contacts.some((contact) => normaliseAddress(contact.email) === sender)
      ? { passes: true, detail: `The sender is a known contact of ${order.soNumber}'s customer.` }
      : { passes: false, detail: `The sender is not a known contact of ${order.soNumber}'s customer.` },
    "edit-rights": editRightsResult(change.kind, change.target, change.changes),
    ...lineResults(priced, lines, {
      runId: change.runId,
      codesInEmail: skuCodesIn(email?.body ?? ""),
      searches: await citedSearches(tx, priced),
    }),
    "credit-hold": creditHoldResult(increaseCents, credit),
    "credit-limit": creditLimitResult(increaseCents, credit),
    "no-flags":
      flags.length === 0
        ? { passes: true, detail: "The agent raised no flags." }
        : { passes: false, detail: `The agent raised: ${flags.map((flag) => flag.code).join(", ")}.` },
  };
  return { lines, totalCents, checks: changeChecks.map((check) => ({ check, ...results[check] })) };
}

// The README's edit rules, as the business-rules module reads them: SHIPPED cannot be edited,
// OPEN can, PARTIALLY_SHIPPED only in the unshipped quantity.
function editRightsResult(kind: ChangeKind, target: TargetOrder, changes: OrderLineChange[]): Omit<RecordedCheck, "check"> {
  const { order } = target;
  const salesOrder = { soNumber: order.soNumber, status: order.status, lines: target.lines };
  const edits: OrderEdit[] =
    kind === "cancellation" ? [{ kind: "cancel" }] : changes.map((line) => editOf(target, line));
  const refusals = new Set<string>();
  for (const edit of edits) {
    if (edit.kind === "line-quantity" && edit.quantity < 0) {
      refusals.add(`${order.soNumber} line ${edit.lineNo} cannot go below 0`);
      continue;
    }
    const result = checkOrderEdit({ order: salesOrder, edit });
    if (!result.allowed) refusals.add(result.reason);
  }
  if (refusals.size > 0) return { passes: false, detail: `${[...refusals].join("; ")}.` };
  return { passes: true, detail: `${order.soNumber} is ${order.status}, so this ${kind} is allowed.` };
}

function editOf(target: TargetOrder, line: OrderLineChange): OrderEdit {
  if (line.orderLineNo === null) return { kind: "add-line", sku: line.sku, quantity: line.delta };
  return { kind: "line-quantity", lineNo: line.orderLineNo, quantity: beforeQuantity(target, line) + line.delta };
}

type LineCheck = "skus-sellable" | "confident-skus" | "selling-units" | "full-stock";

// What the lines need: an increase sells the product, so it must be sellable and in stock; a line
// added is chosen the way a new order's is (U18); every quantity is in whole selling units (U1).
function lineResults(
  priced: PricedLine[],
  lines: PricedChange[],
  context: { runId: string; codesInEmail: string[]; searches: Awaited<ReturnType<typeof citedSearches>> },
): Record<LineCheck, Omit<RecordedCheck, "check">> {
  const increases = priced.flatMap((line, index) => {
    const delta = lines[index]?.delta ?? 0;
    return delta > 0 ? [{ ...line, quantity: delta }] : [];
  });
  const notSellable = increases.filter((line) => !line.sellable).map((line) => line.sku);
  const unconfident = priced.flatMap((line, index) => {
    if (lines[index]?.orderLineNo !== null) return [];
    if (line.productSearchId === null) {
      return context.codesInEmail.includes(line.sku) ? [] : [`${line.sku} is not written in the email and cites no search.`];
    }
    const search = context.searches.get(line.productSearchId);
    if (!search || search.runId !== context.runId) return [`${line.sku} cites search ${line.productSearchId}, which this run did not make.`];
    const onlyThis = search.candidateSkus.length === 1 && search.candidateSkus[0] === line.sku;
    if (onlyThis && search.discontinuedSkus.length === 0) return [];
    const candidates = search.candidateSkus.length > 0 ? search.candidateSkus.join(", ") : "no candidates";
    return [`${line.sku} is not the only product its description fits (${candidates}).`];
  });
  const oddUnits = unitProblems(priced);
  return {
    "skus-sellable":
      notSellable.length === 0
        ? { passes: true, detail: "Every product the change adds is in the catalog and active." }
        : { passes: false, detail: `Not in the catalog or discontinued: ${notSellable.join(", ")}.` },
    "confident-skus":
      unconfident.length === 0
        ? { passes: true, detail: "Every line is on the order already, a SKU the email names, or the one product its description fits." }
        : { passes: false, detail: `LOW-CONF-sku: ${unconfident.join(" ")}` },
    "selling-units":
      oddUnits.length === 0
        ? { passes: true, detail: "Every quantity is in whole selling units." }
        : { passes: false, detail: `UNIT-ambiguous: ${oddUnits.join(" ")}` },
    "full-stock":
      increases.length === 0 ? { passes: true, detail: "The change takes no more stock." } : stockResult(increases, null),
  };
}

function creditHoldResult(increaseCents: number, credit: ReturnType<typeof creditCheck>): Omit<RecordedCheck, "check"> {
  if (increaseCents === 0) return { passes: true, detail: "The change adds nothing to the order's value." };
  if (credit.status.passes) return { passes: true, detail: "The customer is not on credit hold." };
  return { passes: false, detail: "The customer is on CREDIT_HOLD, and the change adds to the order." };
}

function creditLimitResult(increaseCents: number, credit: ReturnType<typeof creditCheck>): Omit<RecordedCheck, "check"> {
  const { exposureCents, creditLimitCents, exceedsByCents } = credit.limit;
  if (increaseCents === 0) return { passes: true, detail: "The change adds nothing to the customer's exposure." };
  if (credit.limit.passes) {
    return {
      passes: true,
      detail: `Exposure ${formatUsd(exposureCents)} with the ${formatUsd(increaseCents)} increase is within the ${formatUsd(creditLimitCents)} limit.`,
    };
  }
  return {
    passes: false,
    detail: `Exposure ${formatUsd(exposureCents)} with the ${formatUsd(increaseCents)} increase exceeds the ${formatUsd(creditLimitCents)} limit by ${formatUsd(exceedsByCents)}.`,
  };
}

// The stored change, re-read for a person's approval: a change's lines as proposed, and a
// cancellation's from the order as it stands now.
export async function changesToRecheck(
  tx: Database,
  proposal: { id: number; kind: ChangeKind },
  target: TargetOrder,
): Promise<OrderLineChange[]> {
  if (proposal.kind === "cancellation") return cancellationChanges(target);
  const stored = await tx
    .select()
    .from(proposalLines)
    .where(eq(proposalLines.proposalId, proposal.id))
    .orderBy(asc(proposalLines.lineNo));
  return stored.map((line) => ({
    orderLineNo: line.orderLineNo,
    sku: line.sku,
    delta: line.quantity,
    customerWords: line.customerWords,
    productSearchId: line.productSearchId,
    // How the customer wrote a unit is not kept on the line, so a re-run reads whole selling units.
    unitAsWritten: null,
    quantityAsWritten: null,
  }));
}

// Keeps the re-checked lines, prices and checks on the Proposal.
export async function storeRecheckedChange(tx: Database, proposalId: number, checked: CheckedChange): Promise<void> {
  await tx.delete(proposalLines).where(eq(proposalLines.proposalId, proposalId));
  await storeLines(tx, proposalId, checked.lines);
  await tx
    .update(proposals)
    .set({ checks: checked.checks, totalCents: checked.totalCents })
    .where(eq(proposals.id, proposalId));
}

// Applies an approved change to the sales order and moves its stock: each line's ordered quantity
// and the SKU's allocation move by the same amount, and a cancelled order is marked CANCELLED. The
// caller holds the release lock, re-ran the checks and writes the audit event.
export async function applyChange(
  tx: Database,
  kind: ChangeKind,
  target: TargetOrder,
  lines: PricedChange[],
): Promise<{ sku: string; quantity: number }[]> {
  const { soNumber } = target.order;
  let nextLineNo = target.lines.reduce((max, line) => Math.max(max, line.lineNo), 0) + 1;
  for (const line of lines) {
    if (line.orderLineNo === null) {
      // The skus-sellable check has passed, so a line added has the system's price.
      if (line.unitPriceCents === null) throw new Error(`${line.sku} has no price to add to ${soNumber}.`);
      await tx.insert(salesOrderLines).values({
        soNumber,
        lineNo: nextLineNo,
        sku: line.sku,
        qtyOrdered: line.delta,
        qtyShipped: 0,
        unitPriceCents: line.unitPriceCents,
      });
      nextLineNo += 1;
    } else {
      await tx
        .update(salesOrderLines)
        .set({ qtyOrdered: sql`${salesOrderLines.qtyOrdered} + ${line.delta}` })
        .where(and(eq(salesOrderLines.soNumber, soNumber), eq(salesOrderLines.lineNo, line.orderLineNo)));
    }
    await tx
      .update(inventory)
      .set({ allocated: sql`${inventory.allocated} + ${line.delta}` })
      .where(eq(inventory.sku, line.sku));
  }
  if (kind === "cancellation") {
    await tx.update(salesOrders).set({ status: "CANCELLED" }).where(eq(salesOrders.soNumber, soNumber));
  }
  return lines.map((line) => ({ sku: line.sku, quantity: line.delta }));
}
