import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    // Each PGlite database boots a WASM Postgres; give the first one room on a cold sandbox.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
