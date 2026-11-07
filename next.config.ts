import type { NextConfig } from "next";
import { FIXED_SECURITY_HEADERS } from "./src/server/security-headers";

const nextConfig: NextConfig = {
  // No "X-Powered-By: Next.js": the stack is nobody's business.
  poweredByHeader: false,
  // PGlite is test-only; keep it and the pg driver out of the server bundle's tracing.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  // The CSP needs a nonce per request, so the proxy sets it with these (src/proxy.ts).
  async headers() {
    return [{ source: "/:path*", headers: [...FIXED_SECURITY_HEADERS] }];
  },
};

export default nextConfig;
