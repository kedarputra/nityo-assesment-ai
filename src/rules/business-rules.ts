import { z } from "zod";
import { customerStatus, productStatus, salesOrderStatus } from "@/db/schema";

// The data pack README's business rules and the map's checks, as pure functions. The agent's
// tools and the release gate both call these, so a price, a stock figure, a credit result or an
// edit right is computed one way only (ADR 0001: code gates a release, the model only
// interprets). Callers read the rows; nothing here touches a database, the network or a model.
// Every input is parsed with Zod first, because a tool's arguments come from the model.
//
// Money is integer cents throughout. Dates are ISO calendar dates ("2026-11-02"), which compare
// correctly as strings.

// The business clock is fixed at the snapshot's day (policy 1): every order is dated Mon 2 Nov 2026.
export const businessDate = "2026-11-02";

const isoDate = z.iso.date();
const cents = z.number().int().nonnegative();
const sku = z.string().min(1);
// Only whole selling units can be ordered.
const wholeUnits = z.number().int().positive();

const productSchema = z.object({
  sku,
  listPriceCents: cents,
  status: z.enum(productStatus.enumValues),
  replacedBy: z.string().min(1).nullable(),
});

const contractSchema = z.object({
  customerId: z.string().min(1),
  sku,
  unitPriceCents: cents,
  validFrom: isoDate,
  validTo: isoDate,
});

// ---- Price -------------------------------------------------------------------------------------

export const priceInput = z.object({
  customerId: z.string().min(1),
  orderDate: isoDate,
  product: productSchema,
  // The customer's contract rows; rows for another customer or SKU are ignored, not trusted.
  contracts: z.array(contractSchema),
});

export type Contract = z.infer<typeof contractSchema>;

export type Price =
  | { sku: string; unitPriceCents: number; source: "contract"; contract: Contract }
  | {
      sku: string;
      unitPriceCents: number;
      source: "list";
      // A contract for this customer and SKU that exists but does not cover the order date, so
      // a reply can say why the customer's remembered price no longer applies (E024).
      expiredContract: Contract | null;
    };

// A valid contract price (order date within valid_from–valid_to, both inclusive) overrides the
// list price; otherwise the list price applies.
export function priceFor(input: z.input<typeof priceInput>): Price {
  const { customerId, orderDate, product, contracts } = priceInput.parse(input);
  const forThisSku = contracts.filter(
    (contract) => contract.customerId === customerId && contract.sku === product.sku,
  );
  const valid = forThisSku.filter(
    (contract) => contract.validFrom <= orderDate && orderDate <= contract.validTo,
  );
  if (valid.length > 1) {
    // The pack has no overlapping contracts; if one appears, which price wins is a decision for
    // a person, not something to pick silently.
    throw new BusinessRuleError(
      `${customerId} has ${valid.length} contracts for ${product.sku} valid on ${orderDate}`,
    );
  }
  const [contract] = valid;
  if (contract) {
    return { sku: product.sku, unitPriceCents: contract.unitPriceCents, source: "contract", contract };
  }
  const lapsed = forThisSku
    .filter((candidate) => candidate.validTo < orderDate)
    .sort((a, b) => b.validTo.localeCompare(a.validTo));
  return {
    sku: product.sku,
    unitPriceCents: product.listPriceCents,
    source: "list",
    expiredContract: lapsed[0] ?? null,
  };
}

// ---- Order value -------------------------------------------------------------------------------

export const orderValueInput = z.object({
  lines: z.array(z.object({ sku, quantity: wholeUnits, unitPriceCents: cents })).min(1),
});

export interface OrderValue {
  lines: { sku: string; quantity: number; unitPriceCents: number; lineTotalCents: number }[];
  totalCents: number;
}

export function orderValue(input: z.input<typeof orderValueInput>): OrderValue {
  const { lines } = orderValueInput.parse(input);
  const priced = lines.map((line) => ({ ...line, lineTotalCents: line.quantity * line.unitPriceCents }));
  const totalCents = priced.reduce((sum, line) => sum + line.lineTotalCents, 0);
  if (!Number.isSafeInteger(totalCents)) throw new BusinessRuleError("order value is too large");
  return { lines: priced, totalCents };
}

// ---- Stock -------------------------------------------------------------------------------------

export const stockInput = z.object({
  sku,
  // `available = on_hand - allocated`; a release allocates stock and so reduces it.
  available: z.number().int(),
  incoming: z.array(z.object({ sku, supplierPo: z.string().min(1), qty: wholeUnits, expectedDate: isoDate })),
});

export interface Stock {
  sku: string;
  available: number;
  // This SKU's supplier deliveries, soonest first.
  incoming: { supplierPo: string; qty: number; expectedDate: string }[];
  incomingTotal: number;
}

export function stockFor(input: z.input<typeof stockInput>): Stock {
  const parsed = stockInput.parse(input);
  const incoming = parsed.incoming
    .filter((delivery) => delivery.sku === parsed.sku)
    .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate))
    .map(({ supplierPo, qty, expectedDate }) => ({ supplierPo, qty, expectedDate }));
  return {
    sku: parsed.sku,
    available: parsed.available,
    incoming,
    incomingTotal: incoming.reduce((sum, delivery) => sum + delivery.qty, 0),
  };
}

// ---- Credit ------------------------------------------------------------------------------------

export const creditInput = z.object({
  customer: z.object({
    customerId: z.string().min(1),
    status: z.enum(customerStatus.enumValues),
    creditLimitCents: cents,
    openBalanceCents: cents,
  }),
  // The value of this customer's orders released earlier the same day: a release counts against
  // credit at once. Pre-existing OPEN orders are not added, as open_balance may hold them (U15).
  releasedTodayCents: cents,
  orderValueCents: cents,
});

export interface CreditCheck {
  customerId: string;
  passes: boolean;
  status: { passes: boolean; customerStatus: z.infer<typeof creditInput>["customer"]["status"] };
  limit: {
    passes: boolean;
    openBalanceCents: number;
    releasedTodayCents: number;
    orderValueCents: number;
    // open_balance + released today + this order
    exposureCents: number;
    creditLimitCents: number;
    // What the customer could still order before this one: limit − balance − released today.
    headroomCents: number;
    // How far this order takes the customer over the limit; 0 when it does not.
    exceedsByCents: number;
  };
}

// An order should not be released if the customer is on CREDIT_HOLD, or if open_balance plus the
// new order's value (and today's earlier releases) would exceed credit_limit. Both results are
// returned, so a reviewer sees every reason, not only the first.
export function creditCheck(input: z.input<typeof creditInput>): CreditCheck {
  const { customer, releasedTodayCents, orderValueCents } = creditInput.parse(input);
  const statusPasses = customer.status !== "CREDIT_HOLD";
  const exposureCents = customer.openBalanceCents + releasedTodayCents + orderValueCents;
  const limitPasses = exposureCents <= customer.creditLimitCents;
  return {
    customerId: customer.customerId,
    passes: statusPasses && limitPasses,
    status: { passes: statusPasses, customerStatus: customer.status },
    limit: {
      passes: limitPasses,
      openBalanceCents: customer.openBalanceCents,
      releasedTodayCents,
      orderValueCents,
      exposureCents,
      creditLimitCents: customer.creditLimitCents,
      headroomCents: customer.creditLimitCents - customer.openBalanceCents - releasedTodayCents,
      exceedsByCents: Math.max(0, exposureCents - customer.creditLimitCents),
    },
  };
}

// ---- Can it be sold ----------------------------------------------------------------------------

export const sellabilityInput = z.object({ product: productSchema });

export type Sellability =
  | { sku: string; sellable: true }
  | { sku: string; sellable: false; reason: "DISCONTINUED"; replacedBy: string | null };

// DISCONTINUED products cannot be sold; `replaced_by` names the successor. The successor's own
// status is the caller's to check with this same function.
export function sellability(input: z.input<typeof sellabilityInput>): Sellability {
  const { product } = sellabilityInput.parse(input);
  if (product.status === "DISCONTINUED") {
    return { sku: product.sku, sellable: false, reason: "DISCONTINUED", replacedBy: product.replacedBy };
  }
  return { sku: product.sku, sellable: true };
}

// ---- Editing a sales order ---------------------------------------------------------------------

const orderLineSchema = z.object({
  lineNo: z.number().int().positive(),
  sku,
  qtyOrdered: z.number().int().nonnegative(),
  qtyShipped: z.number().int().nonnegative(),
});

const salesOrderSchema = z.object({
  soNumber: z.string().min(1),
  status: z.enum(salesOrderStatus.enumValues),
  lines: z.array(orderLineSchema),
});

export const editRightsInput = z.object({ order: salesOrderSchema });

export type EditRights =
  | { soNumber: string; status: "SHIPPED"; editable: false; reason: string }
  | { soNumber: string; status: "OPEN"; editable: true; scope: "whole-order" }
  | {
      soNumber: string;
      status: "PARTIALLY_SHIPPED";
      editable: true;
      scope: "unshipped-quantity";
      // Each line's quantity may move, but never below what has already shipped.
      lines: { lineNo: number; sku: string; qtyShipped: number; unshippedQty: number; minQty: number }[];
    };

// SHIPPED orders cannot be edited. OPEN orders can. PARTIALLY_SHIPPED orders can only change the
// unshipped quantity.
export function editRights(input: z.input<typeof editRightsInput>): EditRights {
  const { order } = editRightsInput.parse(input);
  switch (order.status) {
    case "SHIPPED":
      return {
        soNumber: order.soNumber,
        status: "SHIPPED",
        editable: false,
        reason: `${order.soNumber} has shipped and cannot be edited`,
      };
    case "OPEN":
      return { soNumber: order.soNumber, status: "OPEN", editable: true, scope: "whole-order" };
    case "PARTIALLY_SHIPPED":
      return {
        soNumber: order.soNumber,
        status: "PARTIALLY_SHIPPED",
        editable: true,
        scope: "unshipped-quantity",
        lines: order.lines.map((line) => ({
          lineNo: line.lineNo,
          sku: line.sku,
          qtyShipped: line.qtyShipped,
          unshippedQty: line.qtyOrdered - line.qtyShipped,
          minQty: line.qtyShipped,
        })),
      };
  }
}

const orderEditSchema = z.discriminatedUnion("kind", [
  // A line's new ordered quantity; 0 removes what is left of it.
  z.object({ kind: z.literal("line-quantity"), lineNo: z.number().int().positive(), quantity: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("add-line"), sku, quantity: wholeUnits }),
  z.object({ kind: z.literal("ship-to"), shipToId: z.string().min(1) }),
  z.object({ kind: z.literal("requested-date"), requestedDate: isoDate }),
  z.object({ kind: z.literal("cancel") }),
]);

export const orderEditInput = z.object({ order: salesOrderSchema, edit: orderEditSchema });

export type OrderEdit = z.infer<typeof orderEditSchema>;

export type OrderEditCheck = { allowed: true } | { allowed: false; reason: string };

// Whether one proposed change to an existing sales order is within its edit rights.
export function checkOrderEdit(input: z.input<typeof orderEditInput>): OrderEditCheck {
  const { order, edit } = orderEditInput.parse(input);
  const rights = editRights({ order });
  const line = edit.kind === "line-quantity" ? order.lines.find((candidate) => candidate.lineNo === edit.lineNo) : undefined;
  if (edit.kind === "line-quantity" && !line) {
    return { allowed: false, reason: `${order.soNumber} has no line ${edit.lineNo}` };
  }
  switch (rights.status) {
    case "SHIPPED":
      return { allowed: false, reason: rights.reason };
    case "OPEN":
      return { allowed: true };
    case "PARTIALLY_SHIPPED":
      if (edit.kind !== "line-quantity" || !line) {
        return {
          allowed: false,
          reason: `${order.soNumber} is partially shipped; only the unshipped quantity of a line can change`,
        };
      }
      if (edit.quantity < line.qtyShipped) {
        return {
          allowed: false,
          reason: `${order.soNumber} line ${line.lineNo} has shipped ${line.qtyShipped}; it cannot go below that`,
        };
      }
      return { allowed: true };
  }
}

export class BusinessRuleError extends Error {
  override name = "BusinessRuleError";
}
