import { defineConfig, devices } from "@playwright/test";

// Runs against the built server and web app, started with the same command a
// self-hoster uses. DATABASE_URL and PUBLIC_URL come from the environment or
// from .env (see .env.example).
const baseURL = process.env.PUBLIC_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run start -w server",
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    timeout: 60_000,
  },
});
