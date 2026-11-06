import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite is test-only; keep it and the pg driver out of the server bundle's tracing.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default nextConfig;
