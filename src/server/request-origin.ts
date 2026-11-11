// The address a request was sent to, so background steps ask this same app for the next email
// (ADR 0004). Behind Vercel's proxy the browser's host arrives as x-forwarded-host.
export function originFromHeaders(incoming: Headers): string | null {
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host");
  if (!host) return null;
  const protocol = incoming.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${protocol}://${host}`;
}
