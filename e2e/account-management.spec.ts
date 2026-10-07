import { expect as baseExpect, type Browser, type Page, test } from "@playwright/test";
import { recordAlerts } from "./support/alerts.js";
import { useFreshServer } from "./support/fresh-server.js";
import { nextRefusedPoll } from "./support/polling.js";

// Managing accounts: an Admin changes a Staff member's role and Locations,
// which their open session follows; resets their password with a one-time
// link they open themselves; deactivates and reactivates their account; and
// revokes an unused invite. The last active Admin cannot deactivate
// themselves. A session the Admin ends sends its open page to sign-in, and
// back to that page after signing in.
const server = useFreshServer();
// Machine pages poll the server every few seconds.
const expect = baseExpect.configure({ timeout: 15_000 });

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };
const sam = { name: "Sam Staff", email: "sam@example.com", password: "staff password 1" };
const newPassword = "Sam's new password";
/** A Machine at Uptown, whose page Sam keeps open, once the first test has created it. */
let uptown1: { id: string };

test.beforeEach(async ({ page }) => {
  // The first test sets the server up; later ones sign in. Both sign the page's context in.
  const setup = await page.request.post("/api/setup", { data: admin });
  if (setup.status() === 409) await page.request.post("/api/session", { data: admin });
  else baseExpect(setup.status()).toBe(201);
});

test("an Admin changes a Staff member's Locations and role, which their open session follows", async ({ page, browser }) => {
  const uptown = await createLocation(page, "Uptown", "America/Chicago");
  await createLocation(page, "Belmont", "America/Chicago");
  await createLocation(page, "Lab", "America/Denver");
  uptown1 = await createMachine(page, "Uptown 1", uptown.id);
  const link = await invite(page, { email: sam.email, role: "staff", locationIds: [uptown.id] });

  // Sam accepts in their own browser, and keeps it open.
  const samsPage = await signedOutPage(browser);
  baseExpect((await samsPage.request.post(`/api/invite-links/${secretOf(link)}/accept`, { data: sam })).status()).toBe(201);
  await samsPage.goto("/locations");
  const worksAt = samsPage.getByRole("list", { name: "Locations" }).getByRole("listitem").filter({ hasText: "You work here" });
  await expect(worksAt).toHaveText([/^Uptown/]);

  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Accounts" }).click();
  const row = accountRow(page, sam.email);
  await expect(row.getByRole("cell")).toHaveText([sam.name, sam.email, "Staff at Uptown", "Active", /Edit role/]);
  await expect(accountRow(page, admin.email).getByRole("cell").first()).toHaveText(`${admin.name}You`);

  // Sam works at Belmont and the Lab too, which an open page shows once it loads again.
  await row.getByRole("button", { name: `Edit ${sam.name}'s role` }).click();
  const dialog = page.getByRole("dialog", { name: `Role of ${sam.name}` });
  await expect(dialog.getByRole("checkbox", { name: "Uptown" })).toBeChecked();
  await dialog.getByRole("checkbox", { name: "Belmont" }).check();
  await dialog.getByRole("checkbox", { name: "Lab" }).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole("cell").nth(2)).toHaveText("Staff at Belmont, Lab, and Uptown");

  await samsPage.reload();
  await expect(worksAt).toHaveText([/^Belmont/, /^Lab/, /^Uptown/]);

  // Sam is about to move Uptown 1 to Belmont when Ada takes Belmont away.
  await samsPage.goto(`/machines/${uptown1.id}`);
  const move = samsPage.getByRole("region", { name: "Location" }).getByRole("form", { name: "Move" });
  await move.getByRole("combobox", { name: "Move to" }).click();
  await expect(samsPage.getByRole("option")).toHaveText(["Belmont", "Lab"]);
  await samsPage.getByRole("option", { name: "Belmont" }).click();

  await row.getByRole("button", { name: `Edit ${sam.name}'s role` }).click();
  await dialog.getByRole("checkbox", { name: "Belmont" }).uncheck();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row.getByRole("cell").nth(2)).toHaveText("Staff at Lab and Uptown");

  // The move is refused, and the choices follow without a reload.
  await move.getByRole("button", { name: "Move" }).click();
  await expect(move.getByRole("alert")).toHaveText("You can move a Machine only to a Location you work at");
  await expect(move.getByRole("combobox", { name: "Move to" })).toHaveText("Choose a Location");
  await move.getByRole("combobox", { name: "Move to" }).click();
  await expect(samsPage.getByRole("option")).toHaveText(["Lab"]);
  await samsPage.keyboard.press("Escape");

  // Then an Admin, with the Admin's controls open in two tabs.
  await row.getByRole("button", { name: `Edit ${sam.name}'s role` }).click();
  await dialog.getByRole("combobox", { name: "Role" }).click();
  await page.getByRole("option", { name: "Admin" }).click();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row.getByRole("cell").nth(2)).toHaveText("Admin");
  await samsPage.goto("/locations");
  const samsNav = samsPage.getByRole("navigation", { name: "Main" });
  await expect(samsNav.getByRole("link", { name: "Accounts" })).toBeVisible();
  await expect(samsPage.getByRole("heading", { name: "New Location" })).toBeVisible();
  const samsOtherTab = await samsPage.context().newPage();
  await samsOtherTab.goto("/machines");
  const newMachine = samsOtherTab.getByRole("form", { name: "New Machine" });
  await expect(newMachine).toBeVisible();

  // And Staff at Uptown again: each tab drops the Admin's controls at its next request that only an Admin may make.
  await row.getByRole("button", { name: `Edit ${sam.name}'s role` }).click();
  await dialog.getByRole("combobox", { name: "Role" }).click();
  await page.getByRole("option", { name: "Staff" }).click();
  await dialog.getByRole("checkbox", { name: "Uptown" }).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row.getByRole("cell").nth(2)).toHaveText("Staff at Uptown");

  await newMachine.getByLabel("Name").fill("Uptown 2");
  await newMachine.getByRole("button", { name: "Create Machine" }).click();
  await expect(samsOtherTab.getByRole("heading", { name: "New Machine" })).toHaveCount(0);
  await expect(samsOtherTab.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Accounts" })).toHaveCount(0);

  await samsNav.getByRole("link", { name: "Accounts" }).click();
  await expect(samsPage.getByRole("heading", { name: `Welcome, ${sam.name}` })).toBeVisible();
  await expect(samsNav.getByRole("link", { name: "Accounts" })).toHaveCount(0);
  await samsNav.getByRole("link", { name: "Locations" }).click();
  await expect(samsPage.getByRole("heading", { name: "Locations", level: 1 })).toBeVisible();
  await expect(samsPage.getByRole("heading", { name: "New Location" })).toHaveCount(0);
  await samsPage.context().close();
});

test("an Admin resets a Staff member's password with a one-time link that ends their other sessions", async ({ page, browser }) => {
  // Sam has Uptown 1's page open on their laptop.
  const samsLaptop = await signedOutPage(browser);
  baseExpect((await samsLaptop.request.post("/api/session", { data: sam })).status()).toBe(200);
  await samsLaptop.goto(`/machines/${uptown1.id}`);
  await expect(samsLaptop.getByRole("heading", { name: "Uptown 1", level: 1 })).toBeVisible();
  const laptopAlerts = await recordAlerts(samsLaptop);

  await page.goto("/accounts");
  await accountRow(page, sam.email).getByRole("button", { name: `Reset ${sam.name}'s password` }).click();
  const notice = page.getByRole("region", { name: `Password reset link for ${sam.name}` });
  const link = await notice.getByRole("textbox", { name: "Password reset link" }).inputValue();
  baseExpect(link.startsWith(`${server.url()}/reset-password/`)).toBe(true);
  await notice.getByRole("button", { name: "Done" }).click();
  await expect(notice).toHaveCount(0);

  // Sam opens it on another device, where nobody is signed in.
  const samsPhone = await signedOutPage(browser);
  await samsPhone.goto(link);
  await expect(samsPhone.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expect(samsPhone.getByLabel("Email")).toHaveValue(sam.email);
  await expect(samsPhone.getByLabel("Email")).not.toBeEditable();
  await samsPhone.getByLabel("New password").fill(newPassword);
  const refused = nextRefusedPoll(samsLaptop, `/api/machines/${uptown1.id}`);
  await samsPhone.getByRole("button", { name: "Set password" }).click();
  await expect(samsPhone.getByRole("heading", { name: `Welcome, ${sam.name}` })).toBeVisible();

  // The laptop's session ended, so its page is refused at its next poll and goes to sign-in, and back after Sam signs in.
  await refused;
  await baseExpect(samsLaptop).toHaveURL(/\/sign-in$/);
  baseExpect(await laptopAlerts()).toEqual([]);
  await signIn(samsLaptop, sam);
  await expect(samsLaptop.getByRole("alert")).toHaveText("The email or password is incorrect");
  await signIn(samsLaptop, { email: sam.email, password: newPassword });
  await expect(samsLaptop.getByRole("heading", { name: "Uptown 1", level: 1 })).toBeVisible();

  // The link worked once.
  const later = await signedOutPage(browser);
  await later.goto(link);
  await expect(later.getByRole("heading", { name: "This link can no longer be used" })).toBeVisible();
  await expect(later.getByText(/^This password reset link has already been used/)).toBeVisible();
  for (const opened of [samsLaptop, samsPhone, later]) await opened.context().close();
});

test("an Admin deactivates an account, which signs it out and refuses its sign-in, then reactivates it", async ({ page, browser }) => {
  // Sam opens Uptown 1's page, signing in on the way.
  const samsPage = await signedOutPage(browser);
  await samsPage.goto(`/machines/${uptown1.id}`);
  await expect(samsPage).toHaveURL(/\/sign-in$/);
  await signIn(samsPage, { email: sam.email, password: newPassword });
  await expect(samsPage.getByRole("heading", { name: "Uptown 1", level: 1 })).toBeVisible();
  const alerts = await recordAlerts(samsPage);

  await page.goto("/accounts");
  const row = accountRow(page, sam.email);
  await row.getByRole("button", { name: `Deactivate ${sam.name}` }).click();
  const confirm = page.getByRole("alertdialog", { name: `Deactivate ${sam.name}?` });
  const refused = nextRefusedPoll(samsPage, `/api/machines/${uptown1.id}`);
  await confirm.getByRole("button", { name: "Deactivate" }).click();
  await expect(row.getByRole("cell").nth(3)).toContainText("Deactivated");
  await expect(row.getByRole("button", { name: `Reset ${sam.name}'s password` })).toHaveCount(0);

  // Sam's open page is refused at its next poll and goes to sign-in, where signing in is refused.
  await refused;
  await baseExpect(samsPage).toHaveURL(/\/sign-in$/);
  baseExpect(await alerts()).toEqual([]);
  await signIn(samsPage, { email: sam.email, password: newPassword });
  await expect(samsPage.getByRole("alert")).toHaveText("This account has been deactivated. Ask an Admin to reactivate it");

  await row.getByRole("button", { name: `Reactivate ${sam.name}` }).click();
  await expect(row.getByRole("cell").nth(3)).toHaveText("Active");
  await signIn(samsPage, { email: sam.email, password: newPassword });
  await expect(samsPage.getByRole("heading", { name: "Uptown 1", level: 1 })).toBeVisible();
  await samsPage.context().close();
});

test("a request the server answers only after the session ended goes to sign-in, though a later session read found it going", async ({
  page,
  browser,
}) => {
  const { locations } = (await (await page.request.get("/api/locations")).json()) as { locations: { id: string; name: string }[] };
  const uptown = locations.find((location) => location.name === "Uptown")!;
  await setAccess(page, sam.email, { role: "admin", locationIds: [] });

  // Sam, an Admin, opens Locations, whose list the server is sent only once the test releases it.
  const samsPage = await signedOutPage(browser);
  baseExpect((await samsPage.request.post("/api/session", { data: { email: sam.email, password: newPassword } })).status()).toBe(200);
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  await samsPage.route("**/api/locations", async (route) => {
    if (route.request().method() === "GET" && !held) {
      held = true;
      await released;
    }
    await route.continue();
  });
  await samsPage.goto("/locations");
  const form = samsPage.getByRole("form", { name: "New Location" });
  await expect(form).toBeVisible();
  const alerts = await recordAlerts(samsPage);

  // Made Staff again, Sam is refused creating a Location, and the session read that follows finds them signed in.
  await setAccess(page, sam.email, { role: "staff", locationIds: [uptown.id] });
  const sessionRead = samsPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/session" && response.ok());
  await form.getByLabel("Name").fill("Harbor");
  await form.getByRole("button", { name: "Create Location" }).click();
  await sessionRead;
  await expect(samsPage.getByRole("heading", { name: "New Location" })).toHaveCount(0);

  // Then Sam signs out in another tab, and only after that does the server get the list, which it refuses.
  const otherTab = await samsPage.context().newPage();
  await otherTab.goto("/");
  await otherTab.getByRole("button", { name: "Sign out" }).click();
  await expect(otherTab).toHaveURL(/\/sign-in$/);
  const refused = samsPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/locations" && response.status() === 401);
  release();
  await refused;
  await baseExpect(samsPage).toHaveURL(/\/sign-in$/);
  baseExpect(await alerts()).toEqual([]);
  await samsPage.context().close();
});

test("an Admin revokes an unused invite, whose link then says it was revoked", async ({ page, browser }) => {
  await page.goto("/accounts");
  const form = page.getByRole("form", { name: "Invite someone" });
  await form.getByLabel("Email").fill("pat@example.com");
  await form.getByRole("combobox", { name: "Role" }).click();
  await page.getByRole("option", { name: "Admin" }).click();
  await form.getByRole("button", { name: "Create invite" }).click();
  const link = await page.getByRole("region", { name: "Invite for pat@example.com" }).getByRole("textbox", { name: "Invite link" }).inputValue();

  const invites = page.getByRole("table", { name: "Invites" });
  const row = invites.getByRole("row").filter({ hasText: "pat@example.com" });
  await expect(row.getByRole("cell").nth(1)).toHaveText("Admin");
  await row.getByRole("button", { name: "Revoke the invite for pat@example.com" }).click();
  await page.getByRole("alertdialog", { name: "Revoke the invite for pat@example.com?" }).getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("No invites are waiting to be used.")).toBeVisible();

  const patsPage = await signedOutPage(browser);
  await patsPage.goto(link);
  await expect(patsPage.getByRole("heading", { name: "This invite can no longer be used" })).toBeVisible();
  await expect(patsPage.getByText("This invite was revoked. Ask an Admin for a new one")).toBeVisible();
  await expect(patsPage.getByRole("button", { name: "Create account" })).toHaveCount(0);
  await patsPage.context().close();
});

test("the last active Admin cannot deactivate themselves", async ({ page }) => {
  await page.goto("/accounts");
  const row = accountRow(page, admin.email);
  await row.getByRole("button", { name: `Deactivate ${admin.name}` }).click();
  await page.getByRole("alertdialog", { name: "Deactivate your own account?" }).getByRole("button", { name: "Deactivate" }).click();

  await expect(page.getByRole("alert")).toHaveText(`${admin.name} is the last active Admin. Make another account an Admin first`);
  await expect(row.getByRole("cell").nth(3)).toHaveText("Active");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Accounts", level: 1 })).toBeVisible();
});

async function createLocation(page: Page, name: string, timeZone: string): Promise<{ id: string }> {
  const response = await page.request.post("/api/locations", { data: { name, timeZone } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string } }).location;
}

async function createMachine(page: Page, name: string, locationId: string): Promise<{ id: string }> {
  const response = await page.request.post("/api/machines", { data: { name, locationId } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { machine: { id: string } }).machine;
}

/** Sets an account's role and Locations through the REST API, as the Accounts page does. */
async function setAccess(page: Page, email: string, access: { role: "admin" | "staff"; locationIds: string[] }) {
  const { accounts } = (await (await page.request.get("/api/accounts")).json()) as { accounts: { id: string; email: string }[] };
  const account = accounts.find((candidate) => candidate.email === email)!;
  baseExpect((await page.request.put(`/api/accounts/${account.id}/access`, { data: access })).status()).toBe(200);
}

/** Creates an invite through the REST API and returns its link. */
async function invite(page: Page, body: { email: string; role: "admin" | "staff"; locationIds?: string[] }): Promise<string> {
  const response = await page.request.post("/api/invites", { data: body });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { link: string }).link;
}

function secretOf(link: string): string {
  return new URL(link).pathname.split("/").at(-1)!;
}

async function signedOutPage(browser: Browser): Promise<Page> {
  return (await browser.newContext({ baseURL: server.url() })).newPage();
}

async function signIn(page: Page, credentials: { email: string; password: string }) {
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

function accountRow(page: Page, email: string) {
  return page.getByRole("table", { name: "Accounts" }).getByRole("row").filter({ hasText: email });
}
