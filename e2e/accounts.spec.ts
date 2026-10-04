import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { useFreshServer } from "./support/fresh-server.js";

// First-run setup and signing in and out, on one server from first visit on.
const server = useFreshServer();

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };

test("first-run setup creates the first Admin and signs them in", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Set up Decent Sync" })).toBeVisible();
  // The server's password rule, not a copy in the web app.
  await expect(page.getByText("At least 12 characters.")).toBeVisible();
  await page.getByLabel("Name").fill(admin.name);
  await page.getByLabel("Email").fill(admin.email);
  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Create Admin account" }).click();

  await expectSignedIn(page);
});

test("first-run setup is closed once an account exists", async ({ page }) => {
  await page.goto("/setup");

  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("alert")).toHaveText("This server is already set up. Sign in instead.");
  await expect(page.getByRole("heading", { name: "Set up Decent Sync" })).toHaveCount(0);
});

test("wrong credentials are refused without saying which part was wrong", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);

  await signIn(page, { email: admin.email, password: "not the password" });
  await expect(page.getByRole("alert")).toHaveText("The email or password is incorrect");

  await signIn(page, { email: "nobody@example.com", password: admin.password });
  await expect(page.getByRole("alert")).toHaveText("The email or password is incorrect");
});

test("signing in survives a browser restart, and signing out ends the session on the server", async ({ browser, page }) => {
  await page.goto("/");
  await signIn(page, admin);
  await expectSignedIn(page);

  // A browser restart keeps only cookies with an expiry; session cookies go.
  const restarted = await restart(browser, page.context());
  const pageAfterRestart = await restarted.newPage();
  await pageAfterRestart.goto("/");
  await expectSignedIn(pageAfterRestart);

  // Keep a copy of the signed-in cookie, as a browser that ignored the
  // sign-out (or someone who copied the cookie) would.
  const copied = await restarted.storageState();
  await pageAfterRestart.getByRole("button", { name: "Sign out" }).click();
  await expect(pageAfterRestart).toHaveURL(/\/sign-in$/);
  await expect(pageAfterRestart.getByRole("heading", { name: "Sign in to Decent Sync" })).toBeVisible();

  const replayed = await browser.newContext({ baseURL: server.url(), storageState: copied });
  const replayedPage = await replayed.newPage();
  await replayedPage.goto("/");
  await expect(replayedPage).toHaveURL(/\/sign-in$/);
  await replayed.close();
  await restarted.close();
});

async function signIn(page: Page, credentials: { email: string; password: string }) {
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function expectSignedIn(page: Page) {
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: `Welcome, ${admin.name}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function restart(browser: Browser, context: BrowserContext): Promise<BrowserContext> {
  const state = await context.storageState();
  const persistent = state.cookies.filter((cookie) => cookie.expires > Date.now() / 1000);
  expect(persistent.map((cookie) => cookie.name)).toContain("decent_sync_session");
  return browser.newContext({ baseURL: server.url(), storageState: { ...state, cookies: persistent } });
}
