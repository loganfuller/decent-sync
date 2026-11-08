import { type APIRequestContext, type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { rememberSecret } from "../server/test/support/secrets.js";
import { ASSISTANT_ENV, type Allowed, type TestApp, authorizationUrl, pkce, serveTestApp } from "../server/test/support/test-app.js";
import { useFreshServer } from "./support/fresh-server.js";
import { openAccountMenu, rows } from "./support/locators.js";
import { admin, createLocation, signInAsAdmin } from "./support/seed.js";

// Seeing and disconnecting Connected Apps (#410; #405, ADR-0027): the
// Connected Apps page in the account menu lists the person's own, each with
// the name its app gave itself above the host its client id is published at,
// whether it may read or read and change, and when it was approved and last
// used, and disconnects one, whose token is then refused; an Admin does the
// same for every account's on the Accounts page. Apps connect as the consent
// page would have them, through the REST API, as loopback test apps.
const server = useFreshServer({ env: ASSISTANT_ENV });
const sam = { name: "Sam Staff", email: "sam@example.com", password: "staff password 1" };

let claude: TestApp;
let chatGpt: TestApp;
test.beforeAll(async () => {
  claude = await serveTestApp("Claude");
  chatGpt = await serveTestApp("ChatGPT");
});
test.afterAll(async () => {
  await claude?.close();
  await chatGpt?.close();
});
test.beforeEach(({ page }) => signInAsAdmin(page));

const hostOf = (app: TestApp) => new URL(app.clientId).host;

/** Connects the app as the signed-in account of `request`, allowing it `allowed`, and returns its access token. */
async function connect(request: APIRequestContext, app: TestApp, allowed: Allowed): Promise<string> {
  const { verifier, challenge } = pkce();
  const authorized = await request.get(authorizationUrl(server.url(), app, challenge), { maxRedirects: 0 });
  expect(authorized.status()).toBe(302);
  const requestId = authorized.headers().location!.split("/").at(-1)!;
  const approved = await request.post(`/api/oauth/requests/${requestId}/approve`, { data: { scopes: allowed } });
  expect(approved.status()).toBe(200);
  const code = new URL(((await approved.json()) as { redirect: string }).redirect).searchParams.get("code")!;
  rememberSecret(code);
  const tokens = await request.post("/api/oauth/token", {
    form: { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: app.redirectUri, client_id: app.clientId, resource: `${server.url()}/api/mcp` },
  });
  expect(tokens.status()).toBe(200);
  const { access_token: accessToken, refresh_token: refreshToken } = (await tokens.json()) as { access_token: string; refresh_token: string };
  rememberSecret(accessToken);
  rememberSecret(refreshToken);
  return accessToken;
}

/** The status the MCP endpoint answers a call with this access token with: 200, or 401 once refused. */
async function callWith(request: APIRequestContext, accessToken: string): Promise<number> {
  const response = await request.post("/api/mcp", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  return response.status();
}

/** Invites Sam as Staff at a new Location, and opens a new browser, signed in as Sam. */
async function samsBrowser(page: Page, browser: Browser): Promise<BrowserContext> {
  const uptown = await createLocation(page, "Uptown");
  const invited = await page.request.post("/api/invites", { data: { email: sam.email, role: "staff", locationIds: [uptown.id] } });
  expect(invited.status()).toBe(201);
  const { link } = (await invited.json()) as { link: string };
  const context = await browser.newContext({ baseURL: server.url() });
  expect((await context.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: sam })).status()).toBe(201);
  return context;
}

test("the Connected Apps page, in the account menu, lists the person's apps, and disconnecting one refuses it at once", async ({ page }) => {
  const reading = await connect(page.request, claude, ["read"]);
  const changing = await connect(page.request, chatGpt, ["read", "change"]);

  await page.goto("/");
  await (await openAccountMenu(page, admin.name)).getByRole("menuitem", { name: "Connected Apps" }).click();
  await expect(page).toHaveURL(/\/connected-apps$/);
  await expect(page.getByRole("heading", { name: "Connected Apps", level: 1 })).toBeVisible();
  const table = page.getByRole("table", { name: "Connected Apps" });
  await expect(table.getByRole("columnheader")).toHaveText(["App", "Access", "Approved", "Last used", "Actions"]);
  // The latest approved first, each name above its host.
  await expect(rows(table)).toHaveCount(2);
  await expect(rows(table).nth(0).getByRole("cell").nth(0)).toHaveText(`ChatGPT${hostOf(chatGpt)}`);
  await expect(rows(table).nth(0).getByRole("cell").nth(1)).toHaveText("Read and change");
  await expect(rows(table).nth(1).getByRole("cell").nth(0)).toHaveText(`Claude${hostOf(claude)}`);
  await expect(rows(table).nth(1).getByRole("cell").nth(1)).toHaveText("Read");
  for (const row of [0, 1]) {
    for (const time of [2, 3]) await expect(rows(table).nth(row).getByRole("cell").nth(time)).not.toBeEmpty();
  }
  expect(await callWith(page.request, changing)).toBe(200);

  await table.getByRole("button", { name: "Disconnect ChatGPT" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Disconnect ChatGPT?" });
  await expect(confirm).toContainText(`ChatGPT at ${hostOf(chatGpt)} stops acting as you at once.`);
  await confirm.getByRole("button", { name: "Disconnect" }).click();
  await expect(rows(table)).toHaveCount(1);
  await expect(rows(table).first()).toContainText("Claude");
  expect(await callWith(page.request, changing)).toBe(401);
  expect(await callWith(page.request, reading)).toBe(200);

  await table.getByRole("button", { name: "Disconnect Claude" }).click();
  await page.getByRole("alertdialog", { name: "Disconnect Claude?" }).getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("No apps are connected to your account.")).toBeVisible();
  await expect(table).toHaveCount(0);
  expect(await callWith(page.request, reading)).toBe(401);
});

test("an Admin sees every account's Connected Apps on the Accounts page and disconnects a Staff member's, who sees only their own", async ({ page, browser }) => {
  const samsContext = await samsBrowser(page, browser);
  try {
    const samsApp = await connect(samsContext.request, claude, ["read", "change"]);
    const adminsApp = await connect(page.request, claude, ["read"]);

    // Sam's own page lists only Sam's.
    const samsPage = await samsContext.newPage();
    await samsPage.goto("/connected-apps");
    const samsTable = samsPage.getByRole("table", { name: "Connected Apps" });
    await expect(rows(samsTable)).toHaveCount(1);
    await expect(rows(samsTable).first().getByRole("cell").nth(1)).toHaveText("Read and change");

    await page.goto("/accounts");
    const table = page.getByRole("table", { name: "Connected Apps" });
    await expect(table.getByRole("columnheader")).toHaveText(["Account", "App", "Access", "Approved", "Last used", "Actions"]);
    // By account.
    await expect(rows(table)).toHaveCount(2);
    await expect(rows(table).nth(0).getByRole("cell").nth(0)).toHaveText(admin.name);
    await expect(rows(table).nth(0).getByRole("cell").nth(2)).toHaveText("Read");
    await expect(rows(table).nth(1).getByRole("cell").nth(0)).toHaveText(sam.name);
    await expect(rows(table).nth(1).getByRole("cell").nth(1)).toHaveText(`Claude${hostOf(claude)}`);
    await expect(rows(table).nth(1).getByRole("cell").nth(2)).toHaveText("Read and change");

    await table.getByRole("button", { name: `Disconnect ${sam.name}'s Claude` }).click();
    const confirm = page.getByRole("alertdialog", { name: "Disconnect Claude?" });
    await expect(confirm).toContainText(`Claude at ${hostOf(claude)} stops acting as ${sam.name} at once.`);
    await confirm.getByRole("button", { name: "Disconnect" }).click();
    await expect(rows(table)).toHaveCount(1);
    await expect(rows(table).first().getByRole("cell").first()).toHaveText(admin.name);
    expect(await callWith(page.request, samsApp)).toBe(401);
    expect(await callWith(page.request, adminsApp)).toBe(200);

    await samsPage.reload();
    await expect(samsPage.getByText("No apps are connected to your account.")).toBeVisible();
  } finally {
    await samsContext.close();
  }
});

test("the Accounts page still lists accounts when Connected Apps can't be loaded, as from the previous release during a deploy", async ({ page }) => {
  // The previous release has no such route, so it answers 404, as Nest does for any route it lacks.
  await page.route("**/api/accounts/connected-apps", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "Cannot GET /api/accounts/connected-apps", statusCode: 404 }) }),
  );
  await page.goto("/accounts");
  await expect(rows(page.getByRole("table", { name: "Accounts" }))).not.toHaveCount(0);
  await expect(page.getByText("Cannot GET /api/accounts/connected-apps")).toBeVisible();
  await expect(page.getByRole("table", { name: "Connected Apps" })).toHaveCount(0);
});

test("on a phone, the menu leads to the Connected Apps page, which fits the screen", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: server.url(), viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  try {
    const phone = await context.newPage();
    await signInAsAdmin(phone);
    await connect(phone.request, chatGpt, ["read", "change"]);
    await phone.goto("/");
    await phone.getByRole("banner").getByRole("button", { name: "Menu" }).click();
    await phone.getByRole("dialog", { name: "Decent Sync" }).getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Connected Apps" }).click();
    await expect(phone.getByRole("heading", { name: "Connected Apps", level: 1 })).toBeVisible();
    await expect(rows(phone.getByRole("table", { name: "Connected Apps" }))).not.toHaveCount(0);
    const { scrollWidth, clientWidth } = await phone.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect({ scrollWidth, clientWidth }).toEqual({ scrollWidth: 393, clientWidth: 393 });
  } finally {
    await context.close();
  }
});
