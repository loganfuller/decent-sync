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
    projects: [
      { extends: true, test: { name: "protocol", include: ["protocol/test/**/*.test.ts"] } },
      { extends: true, test: { name: "plugin", include: ["plugin/test/**/*.test.ts"] } },
      { extends: true, test: { name: "server", include: ["server/test/**/*.test.ts"] } },
    ],
  },
});
