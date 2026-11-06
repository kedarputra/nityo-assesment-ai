import type { ModelResponse } from "@/model/model";
import { callsTool, repliesWith } from "@/model/scripted-model";

// A turn that reports the tokens it used, as the real model does.
function withUsage(response: ModelResponse, inputTokens = 1_000, outputTokens = 200): ModelResponse {
  return { ...response, usage: { inputTokens, outputTokens } };
}

export const e001Lines = [
  { sku: "HPS-1408", quantity: 4, customer_words: "HPS-1408  x 4" },
  { sku: "HPS-1402", quantity: 6, customer_words: "HPS-1402  x 6" },
  { sku: "HPS-1502", quantity: 2, customer_words: "HPS-1502  x 2" },
];

// E001 as the walkthrough expects it: Bluefin Bistro (C001), explicit SKUs to Pier Street (S001),
// Thursday delivery (Thu 5 Nov), released at $672.00 with a confirmation.
export function e001Script(): ModelResponse[] {
  return [
    callsTool("find_customer", { email: "maria@bluefinbistro.example" }),
    callsTool("list_ship_tos", { customer_id: "C001" }),
    callsTool("get_product", { sku: "HPS-1408" }),
    callsTool("price_line", { customer_id: "C001", sku: "HPS-1408", quantity: 4 }),
    callsTool("check_stock", { sku: "HPS-1408", quantity: 4 }),
    callsTool("check_credit", { customer_id: "C001", order_value_cents: 67200 }),
    callsTool("propose_new_order", {
      customer_id: "C001",
      ship_to_id: "S001",
      requested_date: "2026-11-05",
      lines: e001Lines,
    }),
    callsTool("draft_reply", {
      body: "Hi Maria,\n\nThanks for your order. SO-24059 is confirmed for Pier Street on Thursday 5 November.\n\nHarbor Point",
    }),
    repliesWith("Released Bluefin Bistro's order as SO-24059 and drafted a confirmation."),
  ].map((turn) => withUsage(turn));
}
