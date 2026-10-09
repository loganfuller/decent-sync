import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import { SimulatedTablet, derivedDe1Pro, settingsFor, workflowFixture } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// Each Location's steam, hot water and rinse settings in the management
// interface (ADR-0014). Two simulated tablets running the built plugin at
// Uptown, a DE1Pro and a Bengle, set Uptown's settings for their models; the
// Location's page shows them per model, an Admin's change reaches the
// DE1Pro's tablet only, and Staff working elsewhere cannot change them.
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

test("a Location's page shows its settings per model and changes them, reaching that model's Machines, and Staff elsewhere cannot change them", async ({
  page,
  browser,
}) => {
  const uptown = await createLocation(page, "Uptown");
  const belmont = await createLocation(page, "Belmont");
  const de1 = await tabletAt(page, "Uptown 1", uptown, { serial: "17101" });
  const bengle = await tabletAt(page, "Uptown Bengle", uptown, { serial: "17102", model: "Bengle" });

  await page.goto("/locations");
  await page.getByRole("list", { name: "Locations" }).getByRole("link", { name: "Uptown" }).click();
  await expect(page.getByRole("heading", { name: "Uptown", level: 1 })).toBeVisible();
  const de1Settings = page.getByRole("region", { name: "DE1Pro settings" });
  const bengleSettings = page.getByRole("region", { name: "Bengle settings" });
  await expect(value(de1Settings.getByRole("table", { name: "DE1Pro settings" }), "Steam flow")).toHaveText("2.5 ml/s");
  await expect(value(bengleSettings.getByRole("table", { name: "Bengle settings" }), "Hot water volume")).toHaveText("100 ml");
  await expect(de1Settings).toContainText("Uptown 1");
  await expect(bengleSettings).toContainText("Uptown Bengle");
  await expect(rows(de1Settings.getByRole("table", { name: "History" }))).toHaveCount(1);

  await de1Settings.getByRole("button", { name: "Change the DE1Pro settings" }).click();
  const form = page.getByRole("form", { name: "Change the DE1Pro settings" });
  await form.getByLabel("Steam flow (ml/s)").fill("1.8");
  await form.getByLabel("Hot water volume (ml)").fill("150");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();
  await expect(value(de1Settings.getByRole("table", { name: "DE1Pro settings" }), "Steam flow")).toHaveText("1.8 ml/s");
  const history = rows(de1Settings.getByRole("table", { name: "History" }));
  await expect(history).toHaveCount(2);
  await expect(history.nth(0)).toContainText("You, here");
  await expect(history.nth(0)).toContainText("Steam flow (ml/s) at Uptown1.8");

  // The DE1Pro's tablet takes them; the Bengle's keeps its own.
  await expect.poll(() => setting(de1, "steamSettings", "flow")).toBe(1.8);
  await expect.poll(() => setting(de1, "hotWaterData", "volume")).toBe(150);
  // As Decaid recorded it, with its float noise.
  baseExpect(setting(bengle, "steamSettings", "flow")).toBeCloseTo(2.5);

  // A change on the tablet shows here.
  await de1.changeSettings({ rinseData: { duration: 9 } });
  await expect(value(de1Settings.getByRole("table", { name: "DE1Pro settings" }), "Rinse time")).toHaveText("9 s");

  // Staff working at Belmont read Uptown's settings, but may not change them.
  const response = await page.request.post("/api/invites", { data: { email: sam.email, role: "staff", locationIds: [belmont.id] } });
  baseExpect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const samsBrowser = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await samsBrowser.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: sam });
    baseExpect(accepted.status()).toBe(201);
    const samsPage = await samsBrowser.newPage();
    await samsPage.goto(`/locations/${uptown.id}`);
    const samsSettings = samsPage.getByRole("region", { name: "DE1Pro settings" });
    await expect(value(samsSettings.getByRole("table", { name: "DE1Pro settings" }), "Steam flow")).toHaveText("1.8 ml/s");
    await expect(samsSettings.getByRole("button", { name: "Change the DE1Pro settings" })).toHaveCount(0);
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
async function tabletAt(page: Page, name: string, location: { id: string }, machine: { serial: string; model?: string }): Promise<SimulatedTablet> {
  const response = await page.request.post("/api/machines", { data: { name, locationId: location.id } });
  baseExpect(response.status()).toBe(201);
  const { token } = (await response.json()) as { token: string };
  const tablet = SimulatedTablet.load({
    settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 },
    api: { ...derivedDe1Pro(machine), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], "/workflow": workflowFixture() },
    timeScale: 50,
  });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  return tablet;
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
