import type { Database } from "@/db/database";
import { customerContacts } from "@/db/schema";

// Who sent an email (policy 5, ticket 09 of the map): a known contact's own address wins; else a
// domain that exactly one customer's contacts use names that customer, unverified; a domain several
// customers share (`mail.example`: C011, C014, C017) identifies no one.

export interface Contact {
  customerId: string;
  name: string;
  email: string;
  role: string;
}

export type SenderMatch =
  | { matchedBy: "address"; customerId: string; contact: Contact }
  | { matchedBy: "domain"; customerId: string; domain: string }
  | { matchedBy: "none"; sharedDomain: boolean };

export function matchSender(contacts: readonly Contact[], address: string): SenderMatch {
  const sender = normaliseAddress(address);
  const contact = contacts.find((candidate) => normaliseAddress(candidate.email) === sender);
  if (contact) return { matchedBy: "address", customerId: contact.customerId, contact };

  const domain = domainOf(sender);
  if (domain === null) return { matchedBy: "none", sharedDomain: false };
  const owners = new Set(
    contacts.filter((candidate) => domainOf(normaliseAddress(candidate.email)) === domain).map((candidate) => candidate.customerId),
  );
  const [owner] = owners;
  if (owners.size === 1 && owner !== undefined) return { matchedBy: "domain", customerId: owner, domain };
  return { matchedBy: "none", sharedDomain: owners.size > 1 };
}

export async function allContacts(tx: Database): Promise<Contact[]> {
  return tx
    .select({
      customerId: customerContacts.customerId,
      name: customerContacts.name,
      email: customerContacts.email,
      role: customerContacts.role,
    })
    .from(customerContacts);
}

// The customer an address belongs to, by its own address or its customer's own domain.
export function customerOfSender(contacts: readonly Contact[], address: string): string | null {
  const match = matchSender(contacts, address);
  return match.matchedBy === "none" ? null : match.customerId;
}

export function normaliseAddress(address: string): string {
  return address.trim().toLowerCase();
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 1 || at === address.length - 1) return null;
  return address.slice(at + 1);
}
