// "Same as last time" and "the usual" (policy 8, U14), worked out from the customer's sales
// orders in code rather than left to the model's reading of them.
//
// "Last time" is the most recent order. "The usual" is the lines common to the recent orders, at
// the quantity of the most recent order that has them; a line on only some of them is offered to
// the customer in the Draft reply, never added. "Recent" is the three latest orders, an
// assumption: the pack's customers have at most two.

export const RECENT_ORDERS = 3;

export interface HistoricOrder {
  soNumber: string;
  orderDate: string;
  lines: { sku: string; qtyOrdered: number }[];
}

export interface RepeatedLine {
  sku: string;
  quantity: number;
  // The sales order the quantity comes from.
  fromSalesOrder: string;
}

export interface UsualOrder {
  // The orders considered, newest first.
  basedOn: string[];
  latest: { soNumber: string; orderDate: string; lines: { sku: string; quantity: number }[] } | null;
  common: RepeatedLine[];
  offered: RepeatedLine[];
}

export function usualOrder(orders: HistoricOrder[]): UsualOrder {
  const recent = [...orders]
    .sort((a, b) => b.orderDate.localeCompare(a.orderDate) || b.soNumber.localeCompare(a.soNumber))
    .slice(0, RECENT_ORDERS)
    .map((order) => ({ ...order, quantities: quantitiesBySku(order) }));
  const [latest] = recent;
  if (!latest) return { basedOn: [], latest: null, common: [], offered: [] };

  const common: RepeatedLine[] = [];
  const offered: RepeatedLine[] = [];
  const seen = new Set<string>();
  for (const order of recent) {
    for (const [sku, quantity] of order.quantities) {
      if (seen.has(sku)) continue;
      seen.add(sku);
      const line = { sku, quantity, fromSalesOrder: order.soNumber };
      if (recent.every((other) => other.quantities.has(sku))) common.push(line);
      else offered.push(line);
    }
  }

  return {
    basedOn: recent.map((order) => order.soNumber),
    latest: {
      soNumber: latest.soNumber,
      orderDate: latest.orderDate,
      lines: [...latest.quantities].map(([sku, quantity]) => ({ sku, quantity })),
    },
    common,
    offered,
  };
}

// A SKU on several lines of one order counts once, at its total.
function quantitiesBySku(order: HistoricOrder): Map<string, number> {
  const quantities = new Map<string, number>();
  for (const line of order.lines) quantities.set(line.sku, (quantities.get(line.sku) ?? 0) + line.qtyOrdered);
  return quantities;
}
