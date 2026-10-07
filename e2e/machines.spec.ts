import { CLOSE_CODES } from "@decent-sync/protocol";
import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import {
  PluginStorage,
  RawConnection,
  SimulatedTablet,
  type SimulatedTabletOptions,
  derivedDe1Pro,
  helloWith,
  settingsFor,
} from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// Machines in the management interface, as an Admin, with Seam 1's simulated
// tablets running the built plugin against the same server. Hardware ids are
// made up: serials from 10001, connection ids from 00:00:5E:00:53:xx.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });
// Machine pages poll the server every few seconds, so status takes up to that long to show.
const expect = baseExpect.configure({ timeout: 15_000 });

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };
const tablets: SimulatedTablet[] = [];
const connections: RawConnection[] = [];

/** Starts a simulated tablet with the plugin set up as someone at the machine would. */
function loadTablet(settings: { serverUrl: string; token: string }, options: Omit<SimulatedTabletOptions, "settings"> = {}) {
  const tablet = SimulatedTablet.load({ settings: settingsFor(settings), ...options });
  tablets.push(tablet);
  return tablet;
}

test.beforeEach(async ({ page }) => {
  // The first test sets the server up; later ones sign in. Both sign the page's context in.
  const setup = await page.request.post("/api/setup", { data: admin });
  if (setup.status() === 409) await page.request.post("/api/session", { data: admin });
  else baseExpect(setup.status()).toBe(201);
});

test.afterEach(async () => {
  await Promise.all(connections.splice(0).map((raw) => raw.terminate()));
});

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

let lab: { serverUrl: string; token: string };
let labTablet: SimulatedTablet;

test("creating a Machine shows its token once, and a tablet using it shows the Machine online", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Machines" }).click();
  await expect(page.getByRole("heading", { name: "Machines", level: 1 })).toBeVisible();
  await expect(page.getByText("No Machines yet.")).toBeVisible();

  const form = page.getByRole("form", { name: "New Machine" });
  await form.getByLabel("Name").fill("Lab");
  await form.getByRole("button", { name: "Create Machine" }).click();

  const notice = page.getByRole("region", { name: "Token for Lab" });
  await expect(notice).toContainText("It will not be shown again");
  await notice.getByRole("button", { name: "Copy server URL" }).click();
  await expect(notice.getByRole("button", { name: "Copy server URL" })).toHaveText("Copied");
  const serverUrl = await clipboard(page);
  await notice.getByRole("button", { name: "Copy token" }).click();
  const token = await clipboard(page);
  expect(serverUrl).toBe(server.url());
  expect(token).toMatch(/^\S{20,}$/);
  await expect(notice.getByRole("textbox", { name: "Token" })).toHaveValue(token);

  const row = machineRow(page, "Lab");
  await expect(row).toContainText("Offline");
  await expect(row).toContainText("Never");
  await expect(row).toContainText("Hardware not reported");

  // Someone at the machine enters what was copied in the plugin's settings.
  lab = { serverUrl, token };
  labTablet = loadTablet(lab);
  await expect(row).toContainText("Online");
  await expect(row).toContainText("DE1Pro");
  await expect(row).not.toContainText("Hardware not reported");

  // Once dismissed, the token is gone for good.
  await notice.getByRole("button", { name: "Done" }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(machineRow(page, "Lab")).toContainText("Online");
  await expectTokenNotShown(page, token);

  await machineRow(page, "Lab").getByRole("link", { name: "Lab" }).click();
  await expect(page.getByRole("heading", { name: "Lab", level: 1 })).toBeVisible();
  await expect(field(page, "Model")).toHaveText("DE1Pro");
  await expect(field(page, "Serial")).toHaveText("10001");
  await expect(field(page, "Identification")).toHaveText("Identified by its model and serial");
  await expect(field(page, "Connection id")).toHaveText("00:00:5E:00:53:01");
  await expect(field(page, "Aliases")).toHaveText("00:00:5E:00:53:01");
  await expect(field(page, "Decaid")).toHaveText("0.8.7+2847");
  await expect(field(page, "Plugin")).toHaveText(/^\d+\.\d+\.\d+/);
  await expect(field(page, "Status")).toHaveText("Online");

  // The tablet its connection came from, known by the id the plugin keeps in Decaid's plugin storage.
  const tablets = page.getByRole("region", { name: "Tablets" });
  await expect(field(tablets, "Tablet id")).toHaveText(String(labTablet.storage.read("tabletId")));
  await expect(field(tablets, "First seen")).not.toBeEmpty();
  await expect(field(tablets, "Last seen")).not.toBeEmpty();
  await expect(tablets.getByRole("list", { name: "Earlier tablets" })).toHaveCount(0);
});

let uptown: { serverUrl: string; token: string };
let uptownTablet: SimulatedTablet;

test("a mismatch is resolved by creating a machine entry for the reported hardware", async ({ page }) => {
  // Lab's tablet moves onto another machine, still with Lab's token.
  await labTablet.unload();
  const moved = loadTablet(lab, { api: derivedDe1Pro({ serial: "10002", connectionId: "00:00:5E:00:53:02" }) });

  await page.goto("/machines");
  await expect(machineRow(page, "Lab")).toContainText("Mismatch");
  const pending = pendingMachine(page, "Pending Machines", "DE1Pro serial 10002");
  await expect(pending).toContainText("Reported with the token of Lab");

  await pending.getByRole("button", { name: "Create machine entry" }).click();
  const form = page.getByRole("form", { name: "New machine entry for DE1Pro serial 10002" });
  await form.getByLabel("Name").fill("Uptown 1");
  await form.getByRole("button", { name: "Create Machine" }).click();

  const notice = page.getByRole("region", { name: "Token for Uptown 1" });
  await expect(notice).toContainText("It will not be shown again");
  const token = await notice.getByRole("textbox", { name: "Token" }).inputValue();
  await expect(machineRow(page, "Uptown 1")).toContainText("DE1Pro");
  await expect(page.getByRole("list", { name: "Pending Machines", exact: true })).toHaveCount(0);

  // Lab's page now names the Machine that has the hardware.
  await machineRow(page, "Lab").getByRole("link", { name: "Lab" }).click();
  await expect(page.getByRole("region", { name: "Mismatch" })).toContainText("DE1Pro serial 10002 is Uptown 1");

  // The moved tablet gets the new Machine's token.
  await moved.unload();
  uptown = { serverUrl: lab.serverUrl, token };
  uptownTablet = loadTablet(uptown, { api: derivedDe1Pro({ serial: "10002", connectionId: "00:00:5E:00:53:02" }) });
  await page.getByRole("region", { name: "Mismatch" }).getByRole("link", { name: "Uptown 1" }).click();
  await expect(page.getByRole("heading", { name: "Uptown 1", level: 1 })).toBeVisible();
  await expect(field(page, "Status")).toHaveText("Online");
  await expect(field(page, "Serial")).toHaveText("10002");
  await expect(field(page, "Identification")).toHaveText("Identified by its model and serial");
});

test("a mismatch is resolved by dismissing the reported hardware, which refuses it to the token", async ({ page }) => {
  loadTablet(lab, { api: derivedDe1Pro({ serial: "10003", connectionId: "00:00:5E:00:53:03" }) });

  await page.goto("/machines");
  await expect(pendingMachine(page, "Pending Machines", "DE1Pro serial 10003")).toContainText("Reported with the token of Lab");

  // Resolved from the mismatched Machine's page this time.
  await machineRow(page, "Lab").getByRole("link", { name: "Lab" }).click();
  const mismatch = page.getByRole("region", { name: "Mismatch" });
  await expect(mismatch).toContainText("No machine entry covers DE1Pro serial 10003");
  // The firmware the server holds is the other hardware's, and says so.
  await expect(field(page, "Firmware")).toContainText("from DE1Pro serial 10003");
  await mismatch.getByRole("button", { name: "Dismiss" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Dismiss DE1Pro serial 10003?" });
  await expect(dialog).toContainText("disconnected and refused");
  await dialog.getByRole("button", { name: "Dismiss" }).click();

  await expect(page.getByRole("alert").filter({ hasText: "A connection was refused" })).toContainText(
    "An Admin dismissed DE1Pro serial 10003, which a tablet reported with this Machine's token",
  );
  await expect(mismatch).toContainText("DE1Pro serial 10003 was dismissed");
  await expect(mismatch.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  await expect(mismatch.getByRole("button", { name: "Create machine entry" })).toBeVisible();

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Machines" }).click();
  await expect(pendingMachine(page, "Dismissed Pending Machines", "DE1Pro serial 10003")).toBeVisible();
  await expect(page.getByRole("list", { name: "Pending Machines", exact: true })).toHaveCount(0);
  await expect(machineRow(page, "Lab")).toContainText("Refused");
  await expect(machineRow(page, "Lab")).toContainText("Offline");
});

let home: { serverUrl: string; token: string };
let homeTablet: SimulatedTablet;

test("an Unidentified Machine is identified by entering its model and serial", async ({ page }) => {
  home = await createMachine(page, "Home");
  // An older DE1 that reports no serial.
  homeTablet = loadTablet(home, { api: derivedDe1Pro({ model: "DE1", serial: "0", connectionId: "00:00:5E:00:53:20" }) });

  await page.goto("/machines");
  const row = machineRow(page, "Home");
  await expect(row).toContainText("Online");
  await expect(row).toContainText("Unidentified");
  await expect(row).toContainText("DE1");

  await row.getByRole("link", { name: "Home" }).click();
  await expect(field(page, "Serial")).toHaveText('None (its machine reports "0")');
  const form = page.getByRole("form", { name: "Enter hardware" });
  // What the machine reported is chosen to start with.
  await expect(form.getByRole("combobox", { name: "Model" })).toHaveText("DE1");
  await form.getByRole("combobox", { name: "Model" }).click();
  await page.getByRole("option", { name: "DE1Plus" }).click();
  await form.getByLabel("Serial").fill("0");
  await form.getByRole("button", { name: "Save hardware" }).click();
  await expect(form.getByRole("alert")).toContainText("Enter the machine's serial number");

  await form.getByLabel("Serial").fill("10010");
  await form.getByRole("button", { name: "Save hardware" }).click();
  await expect(page.getByRole("region", { name: "Unidentified Machine" })).toHaveCount(0);
  await expect(field(page, "Model")).toHaveText("DE1Plus");
  await expect(field(page, "Serial")).toHaveText("10010");
  await expect(field(page, "Identification")).toHaveText("Identified by its model and serial");
  await expect(field(page, "Aliases")).toHaveText("00:00:5E:00:53:20");
});

test("a bound Machine connecting from a machine without a serial can be confirmed as its own hardware", async ({ page }) => {
  // Uptown 1's tablet connects from a new connection id while its machine reports no serial.
  await uptownTablet.unload();
  uptownTablet = loadTablet(uptown, { api: derivedDe1Pro({ serial: "0", connectionId: "00:00:5E:00:53:31" }) });

  await page.goto("/machines");
  await expect(machineRow(page, "Uptown 1")).toContainText("Unidentified");
  await machineRow(page, "Uptown 1").getByRole("link", { name: "Uptown 1" }).click();
  const unidentified = page.getByRole("region", { name: "Unidentified Machine" });
  await expect(unidentified).toContainText("from connection id 00:00:5E:00:53:31");
  // The server accepts only the bound hardware, so no form offers other hardware.
  await expect(unidentified.getByRole("form")).toHaveCount(0);
  await expect(field(page, "Firmware")).toContainText("from DE1Pro serial 0");

  await unidentified.getByRole("button", { name: "Confirm it is DE1Pro serial 10002" }).click();
  await expect(unidentified).toHaveCount(0);
  await expect(field(page, "Identification")).toHaveText("Identified by its model and serial");
  await expect(field(page, "Aliases")).toHaveText("00:00:5E:00:53:02, 00:00:5E:00:53:31");
});

test("reissuing a token shows the new token once, and the old token can no longer connect", async ({ page }) => {
  await page.goto("/machines");
  await machineRow(page, "Home").getByRole("link", { name: "Home" }).click();
  await expect(field(page, "Status")).toHaveText("Online");

  await page.getByRole("button", { name: "Issue new token" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Issue a new token for Home?" });
  await expect(dialog).toContainText("The current token stops working at once");
  await dialog.getByRole("button", { name: "Issue new token" }).click();

  const notice = page.getByRole("region", { name: "Token for Home" });
  await expect(notice).toContainText("It will not be shown again");
  await notice.getByRole("button", { name: "Copy token" }).click();
  const replaced = await clipboard(page);
  expect(replaced).not.toBe(home.token);

  // Reissued again before Done: the new token's copy button starts afresh.
  await page.getByRole("button", { name: "Issue new token" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Issue new token" }).click();
  await expect(notice.getByRole("textbox", { name: "Token" })).not.toHaveValue(replaced);
  await expect(notice.getByRole("button", { name: "Copy token" })).toHaveText("Copy");
  await notice.getByRole("button", { name: "Copy token" }).click();
  const token = await clipboard(page);
  expect(token).not.toBe(replaced);

  // The tablet still using the old token is disconnected, and its reconnects are refused.
  await expect(field(page, "Status")).toHaveText("Offline");
  const raw = await RawConnection.open(server.url());
  connections.push(raw);
  raw.send(helloWith(home.token, { machine: { model: "DE1Plus", serial: "10010" }, connectionId: "00:00:5E:00:53:20" }));
  expect(await raw.closed).toEqual({ code: CLOSE_CODES.bad_token, reason: "bad_token" });
  await expect(page.getByRole("alert").filter({ hasText: "A connection was refused" })).toContainText(
    "a token that was replaced by a newer one",
  );

  await notice.getByRole("button", { name: "Done" }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(field(page, "Status")).toBeVisible();
  await expectTokenNotShown(page, token);

  // With the new token entered, the Machine is back.
  await homeTablet.unload();
  loadTablet({ serverUrl: home.serverUrl, token }, { api: derivedDe1Pro({ model: "DE1", serial: "0", connectionId: "00:00:5E:00:53:20" }) });
  await expect(field(page, "Status")).toHaveText("Online");
  await expect(page.getByRole("alert").filter({ hasText: "A connection was refused" })).toHaveCount(0);
});

test("the Machine page shows why a too-old plugin was refused", async ({ page }) => {
  const old = await createMachine(page, "Old plugin");
  const raw = await RawConnection.open(server.url());
  connections.push(raw);
  raw.send({ type: "hello", protocolVersion: 0, token: old.token });
  expect(await raw.closed).toEqual({ code: CLOSE_CODES.plugin_too_old, reason: "plugin_too_old" });

  await page.goto("/machines");
  await expect(machineRow(page, "Old plugin")).toContainText("Refused");
  await machineRow(page, "Old plugin").getByRole("link", { name: "Old plugin" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "A connection was refused" })).toContainText("update the plugin");
});

test("a tablet whose Decaid data was reset shows up on its Machine's page as a new tablet", async ({ page }) => {
  const settings = await createMachine(page, "Reset tablet");
  const storage = new PluginStorage();
  const api = derivedDe1Pro({ serial: "10030", connectionId: "00:00:5E:00:53:30" });
  const before = loadTablet(settings, { storage, api });
  await before.waitForLog(/^Connected to /);
  const first = String(storage.read("tabletId"));

  await page.goto("/machines");
  await machineRow(page, "Reset tablet").getByRole("link", { name: "Reset tablet" }).click();
  const tablets = page.getByRole("region", { name: "Tablets" });
  await expect(field(tablets, "Tablet id")).toHaveText(first);

  // Resetting Decaid's data loses the plugin's storage, and with it the tablet's id.
  await before.unload();
  storage.clear();
  const after = loadTablet(settings, { storage, api });
  await after.waitForLog(/^Connected to /);
  const second = String(storage.read("tabletId"));
  expect(second).not.toBe(first);

  await expect(field(tablets, "Tablet id")).toHaveText(second);
  const earlier = tablets.getByRole("list", { name: "Earlier tablets" }).getByRole("listitem");
  await expect(earlier).toHaveCount(1);
  await expect(earlier).toContainText(first);
  await expect(earlier).toContainText(/^.+First seen .+, last seen .+$/);
});

test("the Machine page shows when another tablet took it over, and from where, apart from refusals", async ({ page }) => {
  const settings = await createMachine(page, "Taken over");
  const [onMachine, elsewhere] = [new PluginStorage(), new PluginStorage()];
  const replaced = loadTablet(settings, { storage: onMachine, api: derivedDe1Pro({ serial: "10040", connectionId: "00:00:5E:00:53:40" }) });
  await replaced.waitForLog(/^Connected to /);
  // An old tablet still holding the token is switched on away from the machine.
  const replacement = loadTablet(settings, {
    storage: elsewhere,
    machineConnected: false,
    api: derivedDe1Pro({ serial: "10040", connectionId: "00:00:5E:00:53:41" }),
  });
  await replacement.waitForLog(/^Connected to /);
  await replaced.waitForLog(/^Another tablet connected with this Machine's token and took over\./);

  await page.goto("/machines");
  await machineRow(page, "Taken over").getByRole("link", { name: "Taken over" }).click();
  const takeover = page.getByRole("alert").filter({ hasText: /^Another tablet took over at / });
  await expect(field(takeover, "Took over")).toContainText(
    `Tablet ${String(elsewhere.read("tabletId"))} at 127.0.0.1, connection id 00:00:5E:00:53:41, plugin `,
  );
  await expect(field(takeover, "Replaced")).toContainText(
    `Tablet ${String(onMachine.read("tabletId"))} at 127.0.0.1, connection id 00:00:5E:00:53:40, plugin `,
  );
  await expect(page.getByRole("alert").filter({ hasText: "A connection was refused" })).toHaveCount(0);
  await expect(field(page, "Status")).toHaveText("Online");
});

/** Creates a machine entry through the REST API, for tests about what follows. */
async function createMachine(page: Page, name: string): Promise<{ serverUrl: string; token: string }> {
  const response = await page.request.post("/api/machines", { data: { name } });
  baseExpect(response.status()).toBe(201);
  const { serverUrl, token } = (await response.json()) as { serverUrl: string; token: string };
  return { serverUrl, token };
}

/** Checks the page shows no token: no token notice, and the token nowhere in its text or fields. */
async function expectTokenNotShown(page: Page, token: string) {
  await expect(page.getByRole("region", { name: /^Token for / })).toHaveCount(0);
  const values = await page.locator("input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  expect(values).not.toContain(token);
  expect(await page.content()).not.toContain(token);
}

async function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

function machineRow(page: Page, name: string) {
  return page
    .getByRole("table", { name: "Machines" })
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
}

function pendingMachine(page: Page, list: string, hardware: string) {
  return page.getByRole("list", { name: list, exact: true }).getByRole("listitem").filter({ hasText: hardware });
}

/** The value of a field on a Machine page, or in one part of it, by its term. */
function field(scope: Page | Locator, term: string) {
  return scope.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}
