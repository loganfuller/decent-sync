import { defineConfig, devices } from "@playwright/test";

// Each spec file starts the built server (`npm run build` first) on its own
// fresh database through e2e/support/fresh-server.ts, which also sets
// baseURL. DATABASE_URL, from the environment or .env, names the PostgreSQL
// server to create those databases on.
export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
