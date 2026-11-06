# Harbor Point order-to-cash

The language of Harbor Point Supply Co.'s order inbox and the agent that works it inside the ERP.
ERP words (`sell_uom`, `CREDIT_HOLD`, `PARTIALLY_SHIPPED`, `replaced_by`) are the data pack's own
and are used as written there.

## Requests

**Email**:
One message received at orders@harborpointsupply.example, identified by its `email_id` (E001…E040).
_Avoid_: Message, ticket

**Request**:
One thing an Email asks Harbor Point to do. An Email can carry several (E033 asks for an order and
refers to a cancellation).
_Avoid_: Intent, task

**Request kind**:
The category of a Request: new order, order change, cancellation, return, billing dispute, quote
request, order inquiry, or no action.
_Avoid_: Type, intent, category

## The agent's work

**Proposal**:
An ERP change the agent has prepared but not made, waiting for a person to approve, edit or reject.
_Avoid_: Suggestion, draft action, recommendation

**Release**:
Committing a sales order in the ERP: its stock is allocated and its value counts against the
customer's credit.
_Avoid_: Submit, confirm, book

**Clean order**:
A new order that passes every release check (known contact, every line resolved to an active SKU,
system price, full stock, credit OK, one clear ship-to, no flags), so the agent may release it alone.
_Avoid_: Simple order, happy path

**Review queue**:
The Proposals and routed Requests waiting for a person.
_Avoid_: Inbox, approval list

**Draft reply**:
A reply to the customer the agent writes for a person to edit and approve. It is never sent.
_Avoid_: Response, outbound email
