import { createHash } from "node:crypto";
import { expect as baseExpect, type Browser, type Page, test } from "@playwright/test";
import { useFreshServer } from "./support/fresh-server.js";

// Inviting people: an Admin creates a one-time link and sends it themselves;
// the Staff member who opens it chooses a name and password, is signed in,
// and sees only the Locations they work at and the Machines there. A link
// already used, or expired, says it can no longer be used.
const server = useFreshServer();
// Machine pages poll the server every few seconds.
const expect = baseExpect.configure({ timeout: 15_000 });

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };
const sam = { name: "Sam Staff", email: "sam@example.com", password: "staff password 1" };
/** Sam's invite link, once the first test has created it. */
let samsLink: string;

test.beforeEach(async ({ page }) => {
  // The first test sets the server up; later ones sign in. Both sign the page's context in.
  const setup = await page.request.post("/api/setup", { data: admin });
  if (setup.status() === 409) await page.request.post("/api/session", { data: admin });
  else baseExpect(setup.status()).toBe(201);
});

test("an Admin invites a Staff member, who accepts, is signed in and sees only their Locations and Machines", async ({ page, browser }) => {
  const lab = await createLocation(page, "Lab", "America/Denver");
  const uptown = await createLocation(page, "Uptown", "America/Chicago");
  const belmont = await createLocation(page, "Belmont", "America/Chicago");
  await createMachine(page, "Lab 1", lab.id);
  await createMachine(page, "Uptown 1", uptown.id);
  await createMachine(page, "Belmont 1", belmont.id);

  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Accounts" }).click();
  const form = page.getByRole("form", { name: "Invite someone" });
  await form.getByLabel("Email").fill(sam.email);
  await expect(form.getByRole("combobox", { name: "Role" })).toHaveText("Staff");
  await form.getByRole("checkbox", { name: "Uptown" }).check();
  await form.getByRole("checkbox", { name: "Belmont" }).check();
  await form.getByRole("button", { name: "Create invite" }).click();

  const notice = page.getByRole("region", { name: `Invite for ${sam.email}` });
  await expect(notice).toContainText("Staff at Belmont and Uptown");
  samsLink = await notice.getByRole("textbox", { name: "Invite link" }).inputValue();
  baseExpect(samsLink.startsWith(`${server.url()}/invite/`)).toBe(true);
  // Ready for the next invite.
  await expect(form.getByLabel("Email")).toHaveValue("");

  // Sam opens it in their own browser, where nobody is signed in.
  const samsBrowser = await browser.newContext({ baseURL: server.url() });
  const samsPage = await samsBrowser.newPage();
  await samsPage.goto(samsLink);
  await expect(samsPage.getByRole("heading", { name: "Join Decent Sync" })).toBeVisible();
  await expect(samsPage.getByText("You are invited as Staff at Belmont and Uptown.")).toBeVisible();
  await expect(samsPage.getByLabel("Email")).toHaveValue(sam.email);
  await expect(samsPage.getByLabel("Email")).not.toBeEditable();
  await samsPage.getByLabel("Name").fill(sam.name);
  await samsPage.getByLabel("Password").fill(sam.password);
  await samsPage.getByRole("button", { name: "Create account" }).click();

  await expect(samsPage).toHaveURL(/\/$/);
  await expect(samsPage.getByRole("heading", { name: `Welcome, ${sam.name}` })).toBeVisible();
  const nav = samsPage.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Accounts" })).toHaveCount(0);

  await nav.getByRole("link", { name: "Locations" }).click();
  const locations = samsPage.getByRole("list", { name: "Locations" }).getByRole("listitem");
  await expect(locations).toHaveText([/^Belmont/, /^Uptown/]);
  await expect(samsPage.getByRole("heading", { name: "New Location" })).toHaveCount(0);
  await expect(samsPage.getByRole("button", { name: /^Edit/ })).toHaveCount(0);

  await nav.getByRole("link", { name: "Machines" }).click();
  const machines = samsPage.getByRole("table", { name: "Machines" }).getByRole("row");
  // A header row, then Belmont 1 and Uptown 1.
  await expect(machines).toHaveCount(3);
  await expect(samsPage.getByRole("link", { name: "Belmont 1", exact: true })).toBeVisible();
  await expect(samsPage.getByRole("link", { name: "Uptown 1", exact: true })).toBeVisible();
  await expect(samsPage.getByRole("link", { name: "Lab 1", exact: true })).toHaveCount(0);
  await expect(samsPage.getByRole("heading", { name: "New Machine" })).toHaveCount(0);

  // Sam moves Uptown 1 to Belmont, and could not move it to the Lab.
  await samsPage.getByRole("link", { name: "Uptown 1", exact: true }).click();
  await expect(samsPage.getByRole("heading", { name: "Uptown 1", level: 1 })).toBeVisible();
  await expect(samsPage.getByRole("heading", { name: "Token" })).toHaveCount(0);
  const move = samsPage.getByRole("region", { name: "Location" }).getByRole("form", { name: "Move" });
  await move.getByRole("combobox", { name: "Move to" }).click();
  await expect(samsPage.getByRole("option")).toHaveText(["Belmont"]);
  await samsPage.getByRole("option", { name: "Belmont" }).click();
  await move.getByRole("button", { name: "Move" }).click();
  const history = samsPage.getByRole("list", { name: "Location History" }).getByRole("listitem");
  await expect(history).toHaveCount(2);
  await expect(history.nth(0)).toContainText("Belmont");
  await expect(samsPage.getByRole("button", { name: /^Correct/ })).toHaveCount(0);
  await samsBrowser.close();

  // Ada sees the move.
  await page.goto("/machines");
  await expect(machineRow(page, "Uptown 1").getByRole("cell").nth(2)).toHaveText("Belmont");
});

test("an invite link already used says it can no longer be used", async ({ browser }) => {
  const page = await signedOutPage(browser);
  await page.goto(samsLink);

  await expect(page.getByRole("heading", { name: "This invite can no longer be used" })).toBeVisible();
  await expect(page.getByText(/^This invite has already been used/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account" })).toHaveCount(0);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.context().close();
});

test("an expired invite link says it can no longer be used", async ({ page, browser }) => {
  const link = await invite(page, { email: "late@example.com", role: "admin" });
  // A week passes.
  const database = await server.connectDatabase();
  try {
    const secret = new URL(link).pathname.split("/").at(-1)!;
    await database.query("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE secret_hash = $1", [
      createHash("sha256").update(secret).digest(),
    ]);
  } finally {
    await database.end();
  }

  const latePage = await signedOutPage(browser);
  await latePage.goto(link);
  await expect(latePage.getByRole("heading", { name: "This invite can no longer be used" })).toBeVisible();
  await expect(latePage.getByText("This invite has expired. Ask an Admin for a new one")).toBeVisible();
  await latePage.context().close();
});

test("someone signed in who opens an invite link signs out before accepting it", async ({ page }) => {
  const link = await invite(page, { email: "alex@example.com", role: "admin" });

  await page.goto(link);
  await expect(page.getByRole("heading", { name: "You are already signed in" })).toBeVisible();
  await expect(page.getByText(`You are signed in as ${admin.name}. Sign out to accept this invite for alex@example.com.`)).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page.getByRole("heading", { name: "Join Decent Sync" })).toBeVisible();
  await expect(page.getByText(/^You are invited as an Admin/)).toBeVisible();
  await page.getByLabel("Name").fill("Alex Admin");
  await page.getByLabel("Password").fill("admin password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, Alex Admin" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Accounts" })).toBeVisible();
});

async function createLocation(page: Page, name: string, timeZone: string): Promise<{ id: string }> {
  const response = await page.request.post("/api/locations", { data: { name, timeZone } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string } }).location;
}

async function createMachine(page: Page, name: string, locationId: string): Promise<void> {
  const response = await page.request.post("/api/machines", { data: { name, locationId } });
  baseExpect(response.status()).toBe(201);
}

/** Creates an invite through the REST API and returns its link. */
async function invite(page: Page, body: { email: string; role: "admin" | "staff"; locationIds?: string[] }): Promise<string> {
  const response = await page.request.post("/api/invites", { data: body });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { link: string }).link;
}

async function signedOutPage(browser: Browser): Promise<Page> {
  return (await browser.newContext({ baseURL: server.url() })).newPage();
}

function machineRow(page: Page, name: string) {
  return page
    .getByRole("table", { name: "Machines" })
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
}
