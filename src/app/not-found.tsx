import Link from "next/link";

// No raw "404": a calm sentence and the way back (DESIGN.md, "States").
export default function NotFound() {
  return (
    <section className="card not-found" aria-labelledby="not-found-title">
      <h1 id="not-found-title" className="title">
        There’s nothing at this address
      </h1>
      <p className="meta">The link may be old or mistyped. Today’s emails are all in the inbox.</p>
      <Link className="btn btn--primary" href="/">
        Go to the inbox
      </Link>
    </section>
  );
}
