import fs from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Runs against the built server and web app, started with the same command a
// self-hoster uses. DATABASE_URL and PUBLIC_URL come from the environment or
// from .env (see .env.example). The server's start script loads .env, so load
// it here too, letting both agree on PUBLIC_URL; set variables still win.
const envFile = path.join(import.meta.dirname, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

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
