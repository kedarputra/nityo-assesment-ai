import { Building2, Mail, Package, Receipt, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { mailHref } from "@/components/mail/folders";
import { getDatabase } from "@/db/client";
import { configuredEmbedder } from "@/model/embedder";
import { requireUser } from "@/server/auth/current-user";
import { loadDeskEmails } from "@/server/desk/load";
import { globalSearch } from "@/server/search/search";
import { StatusPill } from "@/components/inbox/status-pill";

export const metadata: Metadata = { title: "Search · Harbor Point" };

// Global search (ADR 0005): one query across emails, customers, products and sales orders, by
// keyword or by meaning. The folder's own search box filters only the list on screen.
export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  await requireUser();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim().slice(0, 200) : "";
  const mode = params.mode === "meaning" ? "meaning" : "keyword";

  if (query === "") {
    return (
      <div className="page-pad narrow">
        <h1 className="page-title">Search</h1>
        <p className="page-lede">Type in the search box at the top. Keyword finds the words you type; By meaning finds emails about the same thing in other words.</p>
      </div>
    );
  }

  const [results, emails] = await Promise.all([
    globalSearch(getDatabase(), query, { mode, embedder: configuredEmbedder() }),
    loadDeskEmails(),
  ]);
  const total = results.emails.length + results.customers.length + results.products.length + results.orders.length;

  return (
    <div className="page-pad narrow search-page">
      <header className="page-head">
        <h1 className="page-title">
          Results for “{query}”
        </h1>
        <p className="page-lede">
          {total === 1 ? "1 result" : `${total} results`} · {mode === "meaning" && !results.fellBack ? "by meaning" : "by keyword"}
        </p>
        <nav className="mode-switch" aria-label="How to search">
          <Link href={`/search?${new URLSearchParams({ q: query, mode: "keyword" })}`} aria-current={mode === "keyword" ? "true" : undefined}>
            Keyword
          </Link>
          <Link href={`/search?${new URLSearchParams({ q: query, mode: "meaning" })}`} aria-current={mode === "meaning" ? "true" : undefined}>
            <Sparkles size={14} aria-hidden="true" />
            By meaning
          </Link>
        </nav>
        {results.fellBack && results.reason ? <p className="callout-line">{results.reason}</p> : null}
      </header>

      <ResultSection icon={Mail} title="Emails" count={results.emails.length}>
        {results.emails.map((hit) => {
          const email = emails.find((candidate) => candidate.emailId === hit.emailId);
          if (!email) return null;
          return (
            <li key={hit.emailId}>
              <Link className="result" href={mailHref({ folder: "inbox", emailId: hit.emailId, view: "detail" })}>
                <span className="result-top">
                  <b>{email.subject}</b>
                  <span className="id">{email.emailId}</span>
                </span>
                <span className="meta">
                  {email.fromName}
                  {email.customerName ? ` · ${email.customerName}` : ""}
                </span>
                {hit.snippet ? (
                  <span className="snippet">
                    {hit.snippet.before}
                    <mark>{hit.snippet.match}</mark>
                    {hit.snippet.after}
                  </span>
                ) : null}
                <span className="result-bottom">
                  <StatusPill status={email.status} />
                  {mode === "meaning" && !results.fellBack ? <span className="score">{Math.round(hit.score * 100)}% match</span> : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ResultSection>

      <ResultSection icon={Building2} title="Customers" count={results.customers.length}>
        {results.customers.map((customer) => (
          <li key={customer.customerId} className="result result--plain">
            <span className="result-top">
              <b>{customer.name}</b>
              <span className="id">{customer.customerId}</span>
            </span>
            <span className="meta">{customer.status === "CREDIT_HOLD" ? "On credit hold" : "Active"}</span>
          </li>
        ))}
      </ResultSection>

      <ResultSection icon={Package} title="Products" count={results.products.length}>
        {results.products.map((product) => (
          <li key={product.sku} className="result result--plain">
            <span className="result-top">
              <b>{product.name}</b>
              <span className="id">{product.sku}</span>
            </span>
            <span className="meta">{product.status === "DISCONTINUED" ? "Discontinued" : "Active"}</span>
          </li>
        ))}
      </ResultSection>

      <ResultSection icon={Receipt} title="Sales orders" count={results.orders.length}>
        {results.orders.map((order) => (
          <li key={order.soNumber} className="result result--plain">
            <span className="result-top">
              <b>{order.soNumber}</b>
              <span className="meta">{order.status}</span>
            </span>
            <span className="meta">{order.customerName}</span>
          </li>
        ))}
      </ResultSection>
    </div>
  );
}

function ResultSection({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: typeof Mail;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="result-section" aria-label={title}>
      <h2 className="section-title">
        <Icon size={18} aria-hidden="true" />
        {title}
        <span className="count">{count}</span>
      </h2>
      <ul className="results">{children}</ul>
    </section>
  );
}

