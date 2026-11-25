import { defineConfig, devices } from "@playwright/test";

// The image generator's own config, apart from the e2e suite's, so `npm run test:e2e` never runs the spec.
// `npm run readme-images` and `npm run site-images` run it (README.md beside this file). As in the e2e suite, the
// spec starts the built server on a fresh database on the PostgreSQL that TEST_DATABASE_URL, or else DATABASE_URL,
// names.
export default defineConfig({
  testDir: ".",
  testMatch: "**/images.spec.ts",
  timeout: 900_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
