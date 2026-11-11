import { and, asc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/database";
import { customerContacts, customers, emailEmbeddings, emails, products, salesOrders } from "@/db/schema";
import { errorClassOf, logError } from "@/lib/log";
import type { Embedder } from "@/model/embedder";

// Search (ADR 0005). By keyword, every word of the query must appear somewhere in the email: its
// sender, subject, body, or the name of the customer whose contact sent it. By meaning, the
// emails and the query are embedded and ranked by cosine similarity; when that cannot run, it
// falls back to keywords and says why. Global search adds customers, products and sales orders.

export const SEARCH_QUERY_MAX = 200;
// How much of the text a snippet shows on each side of the match.
const SNIPPET_SIDE = 60;
// Search by meaning keeps at most this many emails, and only those this similar to the query.
export const MEANING_TOP = 15;
export const MEANING_MIN_SCORE = 0.35;
const OTHER_RESULTS_MAX = 10;

export const NO_EMBEDDER_REASON = "Search by meaning needs a Gemini key.";
export const EMBEDDER_FAILED_REASON = "The embedding service didn’t answer; showing keyword matches.";

export interface SearchSnippet {
  before: string;
  match: string;
  after: string;
}

export interface EmailHit {
  emailId: string;
  score: number;
  snippet: SearchSnippet | null;
}

export type SearchMode = "keyword" | "meaning";

export interface GlobalResults {
  query: string;
  mode: SearchMode;
  fellBack: boolean;
  reason: string | null;
  emails: EmailHit[];
  customers: { customerId: string; name: string; status: string }[];
  products: { sku: string; name: string; status: string }[];
  orders: { soNumber: string; customerName: string; status: string }[];
}

interface SearchableEmail {
  emailId: string;
  receivedAt: Date;
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  customerNames: string[];
}

export function normalizeQuery(query: string): string {
  return query.slice(0, SEARCH_QUERY_MAX).trim().replace(/\s+/g, " ");
}

// The query's words, lower-cased, each once.
export function queryWords(query: string): string[] {
  return [...new Set(normalizeQuery(query).toLowerCase().split(" ").filter(Boolean))];
}

// The day's inbox is 40 emails, so they are matched in memory: case-insensitive, with no
// pattern syntax for a query to break.
export async function searchEmailsByKeyword(db: Database, query: string): Promise<EmailHit[]> {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const hits: (EmailHit & { receivedAt: Date })[] = [];
  for (const email of await searchableEmails(db)) {
    const fields = [email.fromName, email.fromEmail, email.subject, email.body, ...email.customerNames].map((field) => field.toLowerCase());
    let score = 0;
    let everyWord = true;
    for (const word of words) {
      const matches = fields.reduce((total, field) => total + occurrences(field, word), 0);
      if (matches === 0) {
        everyWord = false;
        break;
      }
      score += matches;
    }
    if (everyWord) hits.push({ emailId: email.emailId, score, snippet: snippetOf(email, words), receivedAt: email.receivedAt });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.receivedAt.getTime() - b.receivedAt.getTime())
    .map(({ emailId, score, snippet }) => ({ emailId, score, snippet }));
}

export interface MeaningResults {
  hits: EmailHit[];
  fellBack: boolean;
  reason: string | null;
}

export async function searchEmailsByMeaning(db: Database, embedder: Embedder | null, query: string): Promise<MeaningResults> {
  const words = queryWords(query);
  if (words.length === 0) return { hits: [], fellBack: false, reason: null };
  if (embedder === null) return { hits: await searchEmailsByKeyword(db, query), fellBack: true, reason: NO_EMBEDDER_REASON };

  try {
    const inbox = await searchableEmails(db);
    const vectors = await emailVectors(db, embedder, inbox);
    const [queryVector] = await embedder.embed([normalizeQuery(query)]);
    if (!queryVector) throw new Error("The query was not embedded.");
    const hits = inbox
      .flatMap((email) => {
        const vector = vectors.get(email.emailId);
        return vector ? [{ email, score: cosine(queryVector, vector) }] : [];
      })
      .filter((hit) => hit.score > MEANING_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MEANING_TOP)
      .map(({ email, score }) => ({ emailId: email.emailId, score: Math.round(score * 1000) / 1000, snippet: snippetOf(email, words) }));
    return { hits, fellBack: false, reason: null };
  } catch (error) {
    logError({ event: "search_failed", errorClass: errorClassOf(error) });
    return { hits: await searchEmailsByKeyword(db, query), fellBack: true, reason: EMBEDDER_FAILED_REASON };
  }
}

// Emails, customers, products and sales orders. Customers, products and orders match every word
// against their names and numbers; emails go by `mode`.
export async function globalSearch(
  db: Database,
  query: string,
  options: { mode: SearchMode; embedder: Embedder | null },
): Promise<GlobalResults> {
  const normalized = normalizeQuery(query);
  const words = queryWords(query);
  const empty: GlobalResults = {
    query: normalized,
    mode: options.mode,
    fellBack: false,
    reason: null,
    emails: [],
    customers: [],
    products: [],
    orders: [],
  };
  if (words.length === 0) return empty;

  const meaning =
    options.mode === "meaning"
      ? await searchEmailsByMeaning(db, options.embedder, normalized)
      : { hits: await searchEmailsByKeyword(db, normalized), fellBack: false, reason: null };

  const everyWord = (columns: (column: string) => SQL[]) =>
    and(...words.map((word) => or(...columns(`%${escapeLike(word)}%`))));

  const customerRows = await db
    .select({ customerId: customers.customerId, name: customers.name, status: customers.status })
    .from(customers)
    .where(everyWord((pattern) => [ilike(customers.name, pattern), ilike(customers.customerId, pattern)]))
    .orderBy(asc(customers.name))
    .limit(OTHER_RESULTS_MAX);
  const productRows = await db
    .select({ sku: products.sku, name: products.name, status: products.status })
    .from(products)
    .where(everyWord((pattern) => [ilike(products.name, pattern), ilike(products.sku, pattern)]))
    .orderBy(asc(products.name))
    .limit(OTHER_RESULTS_MAX);
  const orderRows = await db
    .select({ soNumber: salesOrders.soNumber, customerName: customers.name, status: salesOrders.status })
    .from(salesOrders)
    .innerJoin(customers, eq(customers.customerId, salesOrders.customerId))
    .where(
      everyWord((pattern) => [
        ilike(salesOrders.soNumber, pattern),
        ilike(salesOrders.customerPo, pattern),
        ilike(customers.name, pattern),
      ]),
    )
    .orderBy(asc(salesOrders.soNumber))
    .limit(OTHER_RESULTS_MAX);

  return {
    ...empty,
    fellBack: meaning.fellBack,
    reason: meaning.reason,
    emails: meaning.hits,
    customers: customerRows,
    products: productRows,
    orders: orderRows,
  };
}

// ---- Internals -------------------------------------------------------------------------------

async function searchableEmails(db: Database): Promise<SearchableEmail[]> {
  const rows = await db
    .select({
      emailId: emails.emailId,
      receivedAt: emails.receivedAt,
      fromName: emails.fromName,
      fromEmail: emails.fromEmail,
      subject: emails.subject,
      body: emails.body,
    })
    .from(emails)
    .orderBy(asc(emails.receivedAt), asc(emails.emailId));
  const contacts = await db
    .select({ email: customerContacts.email, name: customers.name })
    .from(customerContacts)
    .innerJoin(customers, eq(customers.customerId, customerContacts.customerId));
  const customersOf = new Map<string, Set<string>>();
  for (const contact of contacts) {
    const address = contact.email.trim().toLowerCase();
    customersOf.set(address, (customersOf.get(address) ?? new Set()).add(contact.name));
  }
  return rows.map((row) => ({ ...row, customerNames: [...(customersOf.get(row.fromEmail.trim().toLowerCase()) ?? [])] }));
}

// Each email's vector for this embedder's model: stored ones are reused, the rest (and any made
// by another model) are embedded now, in one call, and stored.
async function emailVectors(db: Database, embedder: Embedder, inbox: SearchableEmail[]): Promise<Map<string, number[]>> {
  const ids = inbox.map((email) => email.emailId);
  const stored =
    ids.length === 0
      ? []
      : await db
          .select({ emailId: emailEmbeddings.emailId, model: emailEmbeddings.model, vector: emailEmbeddings.vector })
          .from(emailEmbeddings)
          .where(inArray(emailEmbeddings.emailId, ids));
  const vectors = new Map(stored.filter((row) => row.model === embedder.model).map((row) => [row.emailId, row.vector]));
  const missing = inbox.filter((email) => !vectors.has(email.emailId));
  if (missing.length === 0) return vectors;

  const fresh = await embedder.embed(missing.map((email) => `${email.subject}\n\n${email.body}`));
  if (fresh.length !== missing.length) throw new Error("The embedder returned the wrong number of vectors.");
  const rows = missing.map((email, index) => ({ emailId: email.emailId, model: embedder.model, vector: fresh[index] ?? [] }));
  await db
    .insert(emailEmbeddings)
    .values(rows.map((row) => ({ ...row, createdAt: new Date() })))
    .onConflictDoUpdate({
      target: emailEmbeddings.emailId,
      set: { model: embedder.model, vector: sql`excluded.vector`, createdAt: new Date() },
    });
  for (const row of rows) vectors.set(row.emailId, row.vector);
  return vectors;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

function occurrences(text: string, word: string): number {
  let total = 0;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) total += 1;
  return total;
}

// Around the earliest match in the body, else in the subject; null when neither holds a word.
function snippetOf(email: { subject: string; body: string }, words: string[]): SearchSnippet | null {
  for (const text of [email.body, email.subject]) {
    const lower = text.toLowerCase();
    let best: { at: number; length: number } | null = null;
    for (const word of words) {
      const at = lower.indexOf(word);
      if (at !== -1 && (best === null || at < best.at)) best = { at, length: word.length };
    }
    if (best) {
      const start = Math.max(0, best.at - SNIPPET_SIDE);
      const end = Math.min(text.length, best.at + best.length + SNIPPET_SIDE);
      return {
        before: (start > 0 ? "…" : "") + flatten(text.slice(start, best.at)).trimStart(),
        match: text.slice(best.at, best.at + best.length),
        after: flatten(text.slice(best.at + best.length, end)).trimEnd() + (end < text.length ? "…" : ""),
      };
    }
  }
  return null;
}

// A snippet is one line.
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

function escapeLike(word: string): string {
  return word.replace(/[\\%_]/g, (character) => `\\${character}`);
}
