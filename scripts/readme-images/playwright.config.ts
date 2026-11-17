import { defineConfig, devices } from "@playwright/test";

// The README images' own config, apart from the e2e suite's, so `npm run test:e2e` and CI never run the spec.
// `npm run readme-images` runs it (README.md beside this file). As in the e2e suite, the spec starts the built server
// on a fresh database on the PostgreSQL that TEST_DATABASE_URL, or else DATABASE_URL, names.
export default defineConfig({
  testDir: ".",
  testMatch: "**/readme-images.spec.ts",
  timeout: 900_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
