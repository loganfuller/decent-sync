import { availableParallelism } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Module tests run against workspace sources. Tests that need a build (the
// committed plugin, the compiled server) read the build output directly.
export default defineConfig({
  resolve: {
    alias: {
      "@decent-sync/protocol": path.resolve(import.meta.dirname, "protocol/src/index.ts"),
    },
  },
  test: {
    // Each server test file runs up to three server instances on one
    // PostgreSQL, whose connection pools each hold up to 10 connections, and
    // PostgreSQL allows 100 by default. Vitest's default of one worker per
    // CPU but one ran out of them on a 10-CPU machine; five peaked near 60.
    maxWorkers: Math.min(5, Math.max(1, availableParallelism() - 1)),
    // Checks that no server's or simulated tablet's log holds a secret a test was given.
    setupFiles: ["server/test/support/setup.ts"],
    projects: [
      { extends: true, test: { name: "protocol", include: ["protocol/test/**/*.test.ts"] } },
      { extends: true, test: { name: "plugin", include: ["plugin/test/**/*.test.ts"] } },
      { extends: true, test: { name: "server", include: ["server/test/**/*.test.ts"] } },
      { extends: true, test: { name: "scripts", include: ["scripts/test/**/*.test.ts"] } },
    ],
  },
});
