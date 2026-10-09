import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import { SimulatedTablet, derivedDe1Pro, settingsFor, workflowFixture } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// Each Location's steam, hot water and rinse settings in the management
// interface (ADR-0014). Two simulated tablets running the built plugin at
// Uptown, a DE1Pro and a Bengle, share Uptown's settings, which the first to
// connect set; the Location's page shows them and its Machines, an Admin's
// change reaches both tablets, a Machine with sharing turned off keeps its
// own, and Staff working elsewhere can change neither.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
const expect = baseExpect.configure({ timeout: 15_000 });

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };
const sam = { name: "Sam Staff", email: "sam@example.com", password: "staff password 1" };
const tablets: SimulatedTablet[] = [];

test.beforeEach(async ({ page }) => {
  const setup = await page.request.post("/api/setup", { data: admin });
  if (setup.status() === 409) await page.request.post("/api/session", { data: admin });
  else baseExpect(setup.status()).toBe(201);
});

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("a Location's page shows its settings and Machines, changes them on every Machine sharing them, turns a Machine's sharing off, and Staff elsewhere cannot change them", async ({
  page,
  browser,
}) => {
  const uptown = await createLocation(page, "Uptown");
  const belmont = await createLocation(page, "Belmont");
  const de1 = await tabletAt(page, "Uptown 1", uptown, { serial: "17101" });
  const bengle = await tabletAt(page, "Uptown Bengle", uptown, { serial: "17102", model: "Bengle" }, { steamSettings: { flow: 1.2 } });
  // The Bengle takes the settings the DE1Pro, connected first, set.
  await expect.poll(() => setting(bengle, "steamSettings", "flow")).toBeCloseTo(2.5);

  await page.goto("/locations");
  await page.getByRole("list", { name: "Locations" }).getByRole("link", { name: "Uptown" }).click();
  await expect(page.getByRole("heading", { name: "Uptown", level: 1 })).toBeVisible();
  const settings = page.getByRole("region", { name: "Steam, hot water and rinse" });
  const values = settings.getByRole("table", { name: "Steam, hot water and rinse settings" });
  await expect(value(values, "Steam flow")).toHaveText("2.5 ml/s");
  await expect(value(values, "Hot water volume")).toHaveText("100 ml");
  const machines = settings.getByRole("table", { name: "Machines sharing these settings" });
  await expect(rows(machines)).toHaveCount(2);
  await expect(rows(machines).nth(0)).toContainText("Uptown 1DE1Pro");
  await expect(rows(machines).nth(1)).toContainText("Uptown BengleBengle");
  await expect(rows(settings.getByRole("table", { name: "History" }))).toHaveCount(1);

  await settings.getByRole("button", { name: "Change the steam, hot water and rinse settings" }).click();
  const form = page.getByRole("form", { name: "Change the steam, hot water and rinse settings" });
  await form.getByLabel("Steam flow (ml/s)").fill("1.8");
  await form.getByLabel("Hot water volume (ml)").fill("150");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();
  await expect(value(values, "Steam flow")).toHaveText("1.8 ml/s");
  const history = rows(settings.getByRole("table", { name: "History" }));
  await expect(history).toHaveCount(2);
  await expect(history.nth(0)).toContainText("You, here");
  await expect(history.nth(0)).toContainText("Steam flow (ml/s) at Uptown1.8");

  // Both tablets take them, whatever their model.
  for (const tablet of [de1, bengle]) {
    await expect.poll(() => setting(tablet, "steamSettings", "flow")).toBe(1.8);
    await expect.poll(() => setting(tablet, "hotWaterData", "volume")).toBe(150);
  }

  // A change on a tablet shows here.
  await de1.changeSettings({ rinseData: { duration: 9 } });
  await expect(value(values, "Rinse time")).toHaveText("9 s");

  // With sharing turned off, the Bengle keeps its own; turned back on, it takes Uptown's.
  const bengleSwitch = machines.getByRole("switch", { name: "Uptown Bengle shares these settings" });
  await bengleSwitch.click();
  await expect(bengleSwitch).not.toBeChecked();
  await expect.poll(() => setting(bengle, "rinseData", "duration")).toBe(9);
  await bengle.changeSettings({ rinseData: { duration: 4 } });
  await de1.changeSettings({ hotWaterData: { volume: 120 } });
  await expect(value(values, "Hot water volume")).toHaveText("120 ml");
  await expect(value(values, "Rinse time")).toHaveText("9 s");
  baseExpect(setting(bengle, "hotWaterData", "volume")).toBe(150);
  await bengleSwitch.click();
  await expect(bengleSwitch).toBeChecked();
  await expect.poll(() => setting(bengle, "hotWaterData", "volume")).toBe(120);
  await expect.poll(() => setting(bengle, "rinseData", "duration")).toBe(9);

  // Staff working at Belmont read Uptown's settings, but may not change them or switch its Machines.
  const response = await page.request.post("/api/invites", { data: { email: sam.email, role: "staff", locationIds: [belmont.id] } });
  baseExpect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const samsBrowser = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await samsBrowser.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: sam });
    baseExpect(accepted.status()).toBe(201);
    const samsPage = await samsBrowser.newPage();
    await samsPage.goto(`/locations/${uptown.id}`);
    const samsSettings = samsPage.getByRole("region", { name: "Steam, hot water and rinse" });
    await expect(value(samsSettings.getByRole("table", { name: "Steam, hot water and rinse settings" }), "Steam flow")).toHaveText("1.8 ml/s");
    await expect(samsSettings.getByRole("button", { name: "Change the steam, hot water and rinse settings" })).toHaveCount(0);
    await expect(samsSettings.getByRole("switch", { name: "Uptown Bengle shares these settings" })).toBeDisabled();
  } finally {
    await samsBrowser.close();
  }
});

async function createLocation(page: Page, name: string): Promise<{ id: string; name: string }> {
  const response = await page.request.post("/api/locations", { data: { name, timeZone: "America/Chicago" } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string; name: string } }).location;
}

/** A Machine at the Location, its tablet connected, polling every 5 s of its time, which runs 50 times faster here. */
async function tabletAt(
  page: Page,
  name: string,
  location: { id: string },
  machine: { serial: string; model?: string },
  parts: Record<string, Record<string, unknown>> = {},
): Promise<SimulatedTablet> {
  const response = await page.request.post("/api/machines", { data: { name, locationId: location.id } });
  baseExpect(response.status()).toBe(201);
  const { token } = (await response.json()) as { token: string };
  const tablet = SimulatedTablet.load({
    settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 },
    api: { ...derivedDe1Pro(machine), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], "/workflow": workflowWith(parts) },
    timeScale: 50,
  });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}

/** The test tablet's Workflow with these settings changed. */
function workflowWith(parts: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const workflow = workflowFixture();
  for (const [part, values] of Object.entries(parts)) workflow[part] = { ...(workflow[part] as Record<string, unknown>), ...values };
  return workflow;
}

/** A setting of the tablet's Workflow, as Decaid holds it. */
function setting(tablet: SimulatedTablet, part: string, name: string): unknown {
  return (tablet.workflow()[part] as Record<string, unknown>)[name];
}

/** A table's rows below its header. */
function rows(table: Locator) {
  return table.getByRole("row").filter({ hasNot: table.page().getByRole("columnheader") });
}

/** The value a settings table shows for a setting. */
function value(table: Locator, setting: string) {
  return rows(table).filter({ has: table.page().getByRole("cell", { name: setting, exact: true }) }).getByRole("cell").nth(1);
}
