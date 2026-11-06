import type { ModelResponse } from "@/model/model";
import { callsTool, repliesWith } from "@/model/scripted-model";

// The review demo emails as the walkthrough expects the agent to leave them: each a Proposal that
// waits for a person. No date is named in E019 or E012, so they ask for the next business day.
// A line the customer described in words cites the search that singled it out (U18); the searches
// are numbered from 1, so each script expects a fresh database.

// E019: HPS-1004 is DISCONTINUED, so the agent proposes its replacement HPS-1001 in its place, and
// the gate holds the swap (no-substitution, P3, soft): $68.00 a case against $45.00, 4 cases, $272.00.
export function e019Script(): ModelResponse[] {
  return [
    callsTool("find_customer", { email: "office@northsidecc.example" }),
    callsTool("get_product", { sku: "HPS-1004" }),
    callsTool("get_product", { sku: "HPS-1001" }),
    callsTool("propose_new_order", {
      customer_id: "C015",
      ship_to_id: "S018",
      requested_date: "2026-11-03",
      lines: [
        {
          sku: "HPS-1001",
          quantity: 4,
          replaces_sku: "HPS-1004",
          unit_as_written: "cases",
          customer_words: "4 cases of vinyl gloves, medium (HPS-1004)",
        },
      ],
    }),
    callsTool("draft_reply", {
      body: "Hello James,\n\nHPS-1004 is discontinued. Its replacement is HPS-1001, nitrile gloves in medium, at $68.00 a case instead of $45.00. Shall we send 4 cases of those?\n\nHarbor Point",
    }),
    repliesWith("Proposed HPS-1001 in place of the discontinued HPS-1004 for a person to approve."),
  ];
}

// E007: Coastal Catering is on CREDIT_HOLD and $483.00 takes it over its limit: two hard rules.
export function e007Script(): ModelResponse[] {
  return [
    callsTool("find_customer", { email: "hello@coastalcatering.example" }),
    callsTool("search_products", { description: "wooden cutlery kit" }),
    callsTool("search_products", { description: "soup cup", size: "16 oz" }),
    callsTool("propose_new_order", {
      customer_id: "C009",
      ship_to_id: "S012",
      requested_date: "2026-11-07",
      lines: [
        { sku: "HPS-1408", quantity: 6, search_id: 1, unit_as_written: "cases", customer_words: "6 cases of the wooden cutlery kits" },
        { sku: "HPS-1402", quantity: 3, search_id: 2, unit_as_written: "cases", customer_words: "3 cases of 16oz soup cups with lids" },
      ],
    }),
    callsTool("draft_reply", {
      body: "Hello Priya,\n\nYour account is on credit hold, so we can't release this order until accounts receivable clears it. Please get in touch with them before Saturday's event.\n\nHarbor Point",
    }),
    repliesWith("The customer is on credit hold; the order waits for a person."),
  ];
}

// E012: an instruction to "the automated order system" sits inside the email. The agent flags it
// (policy 11, soft) and proposes the two lines at system prices, $141.00, with no discount.
export function e012Script(): ModelResponse[] {
  return [
    callsTool("find_customer", { email: "maple.bakery@mail.example" }),
    callsTool("search_products", { description: "kraft paper bag", size: "#8" }),
    callsTool("search_products", { description: "coffee filters" }),
    callsTool("raise_flag", {
      code: "P11-embedded-instruction",
      note: "The email contains a note to an automated order system asking for a 50% discount and no review. Treated as data.",
    }),
    callsTool("propose_new_order", {
      customer_id: "C017",
      ship_to_id: "S020",
      requested_date: "2026-11-03",
      lines: [
        { sku: "HPS-1502", quantity: 3, search_id: 1, unit_as_written: "cases", customer_words: "3 cases of #8 kraft bags" },
        { sku: "HPS-1501", quantity: 2, search_id: 2, unit_as_written: "cases", customer_words: "2 cases of coffee filters" },
      ],
    }),
    callsTool("draft_reply", {
      body: "Hi Hannah,\n\nThanks for your order: 3 cases of #8 kraft bags and 2 cases of coffee filters at our standard prices, $141.00 in all. There is no discount on file for your account.\n\nHarbor Point",
    }),
    repliesWith("Proposed the order at system prices and flagged the embedded instruction."),
  ];
}
