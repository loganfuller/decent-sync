import { defineConfig, devices } from "@playwright/test";

// Each spec file starts the built server (`npm run build` first) on its own
// fresh database through e2e/support/fresh-server.ts, which also sets
// baseURL. TEST_DATABASE_URL, or else DATABASE_URL, from the environment or
// .env, names the PostgreSQL server to create those databases on.
export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  // Playwright's defaults (an expect gives up after 5 s, a test after 30 s)
  // fail on a busy machine before a page polling every few seconds has
  // caught up. As in vitest.config.ts, a spec bounds its times from below and
  // leaves the upper bound to these (docs/AI_BUILD_NOTES.md).
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // CI's runners have 4 vCPUs, where Playwright's default of half the cores
  // gives each shard 2 workers. 3 ran each shard faster in #303's same-run
  // trial and failed nothing in 48 jobs. Locally the default stands.
  workers: process.env.CI ? 3 : undefined,
  // No retries, in CI either: a test that passes only when retried is flaky, and should fail until it is fixed.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
