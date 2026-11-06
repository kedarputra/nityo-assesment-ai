import type { Stock } from "./business-rules";

// What a person can do with a line the stock cannot cover (policy 2 and U10). Short stock is
// never released on its own: the Proposal shows what is available now and what is due in, and a
// person picks. When no choice meets the date the customer asked for, the date is flagged and
// declining is offered too.
//
// A delivery due in on a day is taken to be shippable that same day, and incoming supply is not
// yet promised to anyone else (the pack records no such promise).

export type ShortStockChoice =
  // Ship what is available now, and the rest once enough is due in (`laterBy`, null if never).
  | { kind: "partial"; now: number; later: number; laterBy: string | null }
  // Ship the whole quantity once enough is due in.
  | { kind: "backorder"; by: string }
  | { kind: "decline" };

export interface ShortStock {
  sku: string;
  wanted: number;
  available: number;
  incoming: Stock["incoming"];
  // The first day available plus deliveries due in covers the whole quantity; null if never.
  fullBy: string | null;
  dateUnmeetable: boolean;
  choices: ShortStockChoice[];
}

export function shortStock(input: { wanted: number; stock: Stock; requestedDate: string | null }): ShortStock {
  const { wanted, stock, requestedDate } = input;
  const available = Math.max(0, stock.available);
  const fullBy = firstDayCovering(wanted, available, stock.incoming);
  // Only a date the customer asked for can be missed.
  const dateUnmeetable = requestedDate !== null && (fullBy === null || fullBy > requestedDate);

  const choices: ShortStockChoice[] = [];
  if (available > 0) choices.push({ kind: "partial", now: available, later: wanted - available, laterBy: fullBy });
  if (fullBy !== null) choices.push({ kind: "backorder", by: fullBy });
  if (dateUnmeetable || fullBy === null) choices.push({ kind: "decline" });

  return { sku: stock.sku, wanted, available, incoming: stock.incoming, fullBy, dateUnmeetable, choices };
}

function firstDayCovering(wanted: number, available: number, incoming: Stock["incoming"]): string | null {
  let covered = available;
  for (const delivery of incoming) {
    covered += delivery.qty;
    if (covered >= wanted) return delivery.expectedDate;
  }
  return null;
}
