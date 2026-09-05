import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts", "apps/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The MCP conformance suite binds real ports. Running files in parallel
    // makes port collisions a flake source, and a flaky conformance suite is
    // worse than a slow one.
    pool: "forks",
    poolOptions: { forks: { singleFork: false } },
  },
});
