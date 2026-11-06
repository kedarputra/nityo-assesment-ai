import { requireUser } from "@/server/auth/current-user";

export default async function HomePage() {
  // The proxy already turned away anyone without a session; this is the page's own check.
  await requireUser();

  return (
    <>
      <h1 className="greeting">Good morning.</h1>
      <p className="reading">The order desk is getting ready. The inbox arrives here soon.</p>
    </>
  );
}
