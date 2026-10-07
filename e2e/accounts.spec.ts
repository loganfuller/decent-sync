import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { recordAlerts } from "./support/alerts.js";
import { useFreshServer } from "./support/fresh-server.js";
import { nextRefusedPoll } from "./support/polling.js";

// First-run setup and signing in and out, on one server from first visit on.
// A session that ends while a page is open sends it to sign-in, and back to
// that page after signing in.
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

test("a session that expires while a Machine's page is open goes to sign-in at its next poll, and back after signing in", async ({ page }) => {
  await page.goto("/");
  await signIn(page, admin);
  await expectSignedIn(page);
  const response = await page.request.post("/api/machines", { data: { name: "Lab 1" } });
  expect(response.status()).toBe(201);
  const { machine } = (await response.json()) as { machine: { id: string } };
  await page.goto(`/machines/${machine.id}`);
  await expect(page.getByRole("heading", { name: "Lab 1", level: 1 })).toBeVisible();
  const alerts = await recordAlerts(page);
  let sessionReads = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/session") sessionReads++;
  });

  // Its expiry passes.
  const refused = nextRefusedPoll(page, `/api/machines/${machine.id}`);
  const database = await server.connectDatabase();
  try {
    await database.query("UPDATE sessions SET expires_at = now() - interval '1 minute'");
  } finally {
    await database.end();
  }

  // The page's next poll is refused, and it goes to sign-in. All of the poll's refused requests read the session once.
  await refused;
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(await alerts()).toEqual([]);
  expect(sessionReads).toBe(1);
  await signIn(page, admin);
  await expect(page).toHaveURL(new RegExp(`/machines/${machine.id}$`));
  await expect(page.getByRole("heading", { name: "Lab 1", level: 1 })).toBeVisible();
});

test("signing out in one tab sends another to sign-in at its next action, and back after signing in", async ({ page }) => {
  await page.goto("/");
  await signIn(page, admin);
  await expectSignedIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Locations" }).click();
  await expect(page.getByRole("heading", { name: "Locations", level: 1 })).toBeVisible();
  const alerts = await recordAlerts(page);

  const otherTab = await page.context().newPage();
  await otherTab.goto("/");
  await otherTab.getByRole("button", { name: "Sign out" }).click();
  await expect(otherTab).toHaveURL(/\/sign-in$/);

  // The Locations page doesn't poll, so it learns at its next request.
  const form = page.getByRole("form", { name: "New Location" });
  await form.getByLabel("Name").fill("Uptown");
  await form.getByRole("button", { name: "Create Location" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(await alerts()).toEqual([]);
  await signIn(page, admin);
  await expect(page.getByRole("heading", { name: "Locations", level: 1 })).toBeVisible();
  await expect(page.getByText("No Locations yet.")).toBeVisible();
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
