import type { NextRequest, NextResponse } from "next/server";

// Security 4: the headers every response carries. The CSP carries a fresh nonce per request, so
// it is set in the proxy; these fixed ones are also set in next.config, which reaches the static
// assets the proxy skips.
export const FIXED_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The older browsers' form of `frame-ancestors 'none'`.
  { key: "X-Frame-Options", value: "DENY" },
];

// No inline script runs unless it carries this request's nonce, which Next.js adds to its own.
// Styles allow 'unsafe-inline' because React writes `style` attributes (the inbox's progress
// bar); a style cannot run code. Development needs 'unsafe-eval' for React's error overlay.
export function contentSecurityPolicy(nonce: string, { development }: { development: boolean }): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (!development) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}

// Wraps the proxy's handling of one request: the handler gets the request headers to pass on,
// which carry the CSP so Next.js finds the nonce while rendering, and whatever it answers (the
// page, a redirect to sign in, a refusal) leaves with every security header.
export async function withSecurityHeaders(
  request: NextRequest,
  handle: (forwardedHeaders: Headers) => Promise<NextResponse>,
  { development = process.env.NODE_ENV === "development" }: { development?: boolean } = {},
): Promise<NextResponse> {
  const policy = contentSecurityPolicy(newNonce(), { development });
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set("Content-Security-Policy", policy);

  const response = await handle(forwardedHeaders);
  response.headers.set("Content-Security-Policy", policy);
  for (const { key, value } of FIXED_SECURITY_HEADERS) response.headers.set(key, value);
  return response;
}
