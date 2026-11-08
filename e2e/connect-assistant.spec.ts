import { type Browser, expect, type Page, test } from "@playwright/test";
import { ASSISTANT_ENV, type TestApp, authorizationUrl, pkce, serveTestApp } from "../server/test/support/test-app.js";
import { useFreshServer } from "./support/fresh-server.js";
import { rows } from "./support/locators.js";
import { admin, signInAsAdmin } from "./support/seed.js";

// The consent page of the authorization server (#406, ADR-0027): an app's
// browser comes to it from the authorization endpoint, signing in first if
// it has no session; it shows the host the app's client id is published at
// above the name the app gives itself, the account it will act as, and
// "Read" or "Read and change", only "Read" for a Viewer; allowing or denying
// sends the browser back to the app; and it fits a phone, where assistants'
// apps open it. The app is a loopback test app named "Claude", as any page
// could name itself. A change made through it is shown in its item's history
// as made through it (#411).
const server = useFreshServer({ env: ASSISTANT_ENV });

let app: TestApp;
test.beforeAll(async () => {
  app = await serveTestApp("Claude");
});
test.afterAll(async () => {
  await app?.close();
});
test.beforeEach(({ page }) => signInAsAdmin(page));

/** The app's redirect, with what the server sent it. */
const atRedirect = () => new RegExp(`^${app.redirectUri.replace(/[.?]/g, "\\$&")}\\?`);

/** Opens a new browser, signed out, on the server, and closes it after `use`. */
async function inNewBrowser(browser: Browser, use: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ baseURL: server.url() });
  try {
    await use(await context.newPage());
  } finally {
    await context.close();
  }
}

/** Exchanges the code the app's redirect last received, as the app does, and returns the scopes its tokens carry. */
async function grantedScopes(page: Page, verifier: string): Promise<string> {
  return (await exchange(page, verifier)).scope;
}

/** Exchanges the code the app's redirect last received, as the app does, for its tokens. */
async function exchange(page: Page, verifier: string): Promise<{ scope: string; access_token: string }> {
  const code = app.callbacks.at(-1)!.get("code")!;
  const response = await page.request.post("/api/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: app.redirectUri,
      client_id: app.clientId,
      resource: `${server.url()}/api/mcp`,
    },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as { scope: string; access_token: string };
}

/** Calls a tool as the app does, with its access token, and returns its structured result. */
async function callTool(page: Page, accessToken: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await page.request.post("/api/mcp", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.status()).toBe(200);
  // As JSON, or as a server-sent event carrying it.
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))!.slice("data: ".length);
  const { result } = JSON.parse(json) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
  expect(result.isError).toBeFalsy();
  return result.structuredContent;
}

test("someone signed out signs in first and comes back to see the app's host above its name, and allows it to read and change", async ({ page, browser }) => {
  await inNewBrowser(browser, async (person) => {
    const { verifier, challenge } = pkce();
    await person.goto(authorizationUrl(server.url(), app, challenge));
    await expect(person).toHaveURL(/\/sign-in$/);
    await expect(person.getByText("Sign in to connect an app to Decent Sync.")).toBeVisible();
    await person.getByLabel("Email").fill(admin.email);
    await person.getByLabel("Password").fill(admin.password);
    await person.getByRole("button", { name: "Sign in" }).click();

    await expect(person).toHaveURL(/\/connect\/[0-9a-f-]{36}$/);
    const heading = person.getByRole("heading", { name: "Connect Claude?" });
    const host = person.getByText(new URL(app.clientId).host, { exact: true });
    await expect(heading).toBeVisible();
    // The host, which no app chooses, above the name, which any app does.
    expect((await host.boundingBox())!.y).toBeLessThan((await heading.boundingBox())!.y);
    await expect(person.getByText(`It will act as you, ${admin.name} (${admin.email}), within what your account may do.`)).toBeVisible();

    const choice = person.getByRole("radiogroup", { name: "What it may do" });
    await expect(choice.getByRole("radio")).toHaveCount(2);
    await expect(choice.getByRole("radio", { name: "Read", exact: true })).toBeChecked();
    await expect(choice.getByRole("radio", { name: "Read and change" })).toHaveAccessibleDescription(
      "Also change what you can change, but never accounts, and never delete anything for good.",
    );
    await choice.getByRole("radio", { name: "Read and change" }).click();
    await person.getByRole("button", { name: "Allow" }).click();

    await expect(person).toHaveURL(atRedirect());
    expect(Object.fromEntries(app.callbacks.at(-1)!)).toMatchObject({ state: "the app's state", iss: server.url() });
    expect(await grantedScopes(page, verifier)).toBe("read change");
  });
});

test("allowing it only to read, as chosen first", async ({ page }) => {
  const { verifier, challenge } = pkce();
  await page.goto(authorizationUrl(server.url(), app, challenge));
  await expect(page.getByRole("heading", { name: "Connect Claude?" })).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page).toHaveURL(atRedirect());
  expect(await grantedScopes(page, verifier)).toBe("read");
});

test("a change made through it is shown in the item's history as yours, through it, by the name it gives itself", async ({ page }) => {
  const { verifier, challenge } = pkce();
  await page.goto(authorizationUrl(server.url(), app, challenge));
  await page.getByRole("radiogroup", { name: "What it may do" }).getByRole("radio", { name: "Read and change" }).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page).toHaveURL(atRedirect());
  const { access_token } = await exchange(page, verifier);
  const { bean } = (await callTool(page, access_token, "create_bean", { roaster: "Roux", name: "Assistant Guji" })) as { bean: { id: string } };
  await callTool(page, access_token, "edit_bean", { id: bean.id, notes: "Peach, asked for on a phone" });
  // One more, made here.
  expect((await page.request.patch(`/api/beans/${bean.id}`, { data: { content: { producer: "Hambela" } } })).status()).toBe(200);

  await page.goto(`/library/beans/${bean.id}`);
  const history = rows(page.getByRole("table", { name: "History" }));
  await expect(history).toHaveCount(3);
  await expect(history.nth(0)).toContainText("You, here");
  await expect(history.nth(1)).toContainText("You, through Claude");
  await expect(history.nth(1)).toContainText("NotesPeach, asked for on a phone");
  await expect(history.nth(2)).toContainText("You, through Claude");
  await expect(history.nth(2)).toContainText("NameAssistant Guji");
});

test("denying it sends the app access_denied, and the request can't be answered again", async ({ page }) => {
  await page.goto(authorizationUrl(server.url(), app, pkce().challenge));
  await expect(page.getByRole("heading", { name: "Connect Claude?" })).toBeVisible();
  const consent = page.url();
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page).toHaveURL(atRedirect());
  expect(Object.fromEntries(app.callbacks.at(-1)!)).toMatchObject({ error: "access_denied", state: "the app's state", iss: server.url() });

  await page.goto(consent);
  await expect(page.getByRole("heading", { name: "This request to connect can no longer be used" })).toBeVisible();
  await expect(page.getByText("This request to connect an app has expired or was answered already. Connect again from the app.")).toBeVisible();
});

test("a Viewer is offered only to let it read", async ({ page, browser }) => {
  const invited = await page.request.post("/api/invites", { data: { email: "val@example.com", role: "viewer", locationIds: [] } });
  expect(invited.status()).toBe(201);
  const { link } = (await invited.json()) as { link: string };
  await inNewBrowser(browser, async (viewer) => {
    await viewer.goto(link);
    await viewer.getByLabel("Name").fill("Val Viewer");
    await viewer.getByLabel("Password").fill("viewer password 1");
    await viewer.getByRole("button", { name: "Create account" }).click();
    await expect(viewer.getByRole("heading", { name: "Welcome, Val Viewer" })).toBeVisible();

    const { verifier, challenge } = pkce();
    await viewer.goto(authorizationUrl(server.url(), app, challenge));
    await expect(viewer.getByRole("heading", { name: "Connect Claude?" })).toBeVisible();
    await expect(viewer.getByRole("radiogroup")).toHaveCount(0);
    const offered = viewer.getByRole("region", { name: "What it may do" });
    await expect(offered).toContainText("Read");
    await expect(offered).toContainText("As a Viewer, you can allow an app only to read.");
    await viewer.getByRole("button", { name: "Allow" }).click();
    await expect(viewer).toHaveURL(atRedirect());
    expect(await grantedScopes(page, verifier)).toBe("read");
  });
});

test("on a phone, where an assistant's app opens it, the consent page fits the screen", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: server.url(), viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  try {
    const phone = await context.newPage();
    await signInAsAdmin(phone);
    await phone.goto(authorizationUrl(server.url(), app, pkce().challenge));
    await expect(phone.getByRole("radiogroup", { name: "What it may do" })).toBeVisible();
    const { scrollWidth, clientWidth } = await phone.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect({ scrollWidth, clientWidth }).toEqual({ scrollWidth: 393, clientWidth: 393 });
  } finally {
    await context.close();
  }
});
