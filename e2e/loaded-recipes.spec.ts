import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import { dye2GlobalIdOf } from "@decent-sync/protocol";
import { DYE2_NAMESPACE, applyInDye2, dye2Keys, dye2Library, dye2List, dye2Recording, saveInDye2 } from "../server/test/support/simulated-dye2.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// Each Machine's Loaded Recipe in the management interface (ticket #145):
// a recipe applied in DYE2 on a simulated tablet running the built plugin
// shows on its Machine's page and its Location's page, and its history keeps
// when it was loaded and unloaded. Serials are made up, from 47501.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
const expect = baseExpect.configure({ timeout: 15_000 });

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };
const tablets: SimulatedTablet[] = [];

type Record_ = Record<string, unknown>;

test.beforeEach(async ({ page }) => {
  const setup = await page.request.post("/api/setup", { data: admin });
  if (setup.status() === 409) await page.request.post("/api/session", { data: admin });
  else baseExpect(setup.status()).toBe(201);
});

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("a recipe applied in DYE2 shows as its Machine's Loaded Recipe on the Machine's page and its Location's, until the profile changes", async ({ page }) => {
  const location = await createLocation(page, "Uptown");
  const recipes = dye2Recording("recipes");
  const library = dye2Library();
  // The recording's tablet, with its library and Workflow, and DYE2's baskets and tools.
  const bar1 = await tabletAt(page, "Bar 1", location, {
    ...derivedDe1Pro({ serial: "47501" }),
    ...library,
    [`/store/${DYE2_NAMESPACE}/baskets`]: dye2Keys().baskets,
    [`/store/${DYE2_NAMESPACE}/equipment`]: dye2Keys().equipment,
    [`/store/${DYE2_NAMESPACE}/recipes`]: [],
  });
  await tabletAt(page, "Bar 2", location, { ...derivedDe1Pro({ serial: "47502" }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS });
  await saveInDye2(bar1.tablet, recipes.saveSlot1);
  await saveInDye2(bar1.tablet, recipes.editSlot1);
  await expect.poll(() => dye2GlobalIdOf(slotOn(bar1.tablet, "1"))).not.toBeNull();

  await page.goto(`/machines/${bar1.id}`);
  const loaded = page.getByRole("region", { name: "Loaded Recipe" });
  await expect(loaded).toContainText("No Recipe is loaded.");

  expect((await applyInDye2(bar1.tablet, "1")).status).toBe(200);
  const now = loaded.getByLabel("Loaded now");
  await expect(field(now, "Recipe")).toHaveText("Fixture Ethiopia EspressoSlot 1");
  await expect(field(now, "Since")).toHaveText(/^\w{3} \d+, \d{4}/);
  const history = loaded.getByRole("table", { name: "Loaded Recipe history" });
  await expect(rows(history)).toHaveCount(1);
  await expect(rows(history).first()).toContainText("Still loaded");

  await page.goto(`/locations/${location.id}`);
  const machines = page.getByRole("table", { name: "Loaded Recipes here" });
  await expect(rows(machines).filter({ hasText: "Bar 1" })).toContainText("Fixture Ethiopia Espresso");
  await expect(rows(machines).filter({ hasText: "Bar 1" })).toContainText("Slot 1");
  await expect(rows(machines).filter({ hasText: "Bar 2" })).toContainText("None");
  await rows(machines).filter({ hasText: "Bar 1" }).getByRole("link", { name: "Fixture Ethiopia Espresso" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Ethiopia Espresso", level: 1 })).toBeVisible();

  // Another profile on the machine unloads it.
  const classic = (library["/profiles"] as { profile: Record_ }[]).find((record) => record.profile.title === "Classic Italian espresso")!.profile;
  await bar1.tablet.changeSettings({ profile: classic });
  await page.goto(`/machines/${bar1.id}`);
  await expect(loaded).toContainText("No Recipe is loaded.");
  await expect(rows(history)).toHaveCount(1);
  await expect(rows(history).first()).not.toContainText("Still loaded");
  await expect(rows(history).first().getByRole("cell").nth(2)).toHaveText(/\w{3} \d+, \d{4}/);
  await page.goto(`/locations/${location.id}`);
  await expect(rows(machines).filter({ hasText: "Bar 1" })).toContainText("None");
});

async function createLocation(page: Page, name: string): Promise<{ id: string; name: string }> {
  const response = await page.request.post("/api/locations", { data: { name, timeZone: "America/Chicago" } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string; name: string } }).location;
}

/** A Machine at the Location, its tablet connected with that API, polling every 5 s of its time, which runs 50 times faster here. */
async function tabletAt(page: Page, name: string, location: { id: string }, api: Record<string, unknown>): Promise<{ id: string; tablet: SimulatedTablet }> {
  const response = await page.request.post("/api/machines", { data: { name, locationId: location.id } });
  baseExpect(response.status()).toBe(201);
  const { token, machine } = (await response.json()) as { token: string; machine: { id: string } };
  const tablet = SimulatedTablet.load({ settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 }, api, timeScale: 50 });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  return { id: machine.id, tablet };
}

/** The tablet's recipe in a slot, if it holds one there. */
function slotOn(tablet: SimulatedTablet, slot: string): Record_ | undefined {
  const list = dye2List(tablet, "recipes");
  return Array.isArray(list) ? (list as Record_[]).find((record) => record.id === slot) : undefined;
}

function field(within: Locator, term: string) {
  return within.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}

/** A table's rows below its header. */
function rows(table: Locator) {
  return table.getByRole("row").filter({ hasNot: table.page().getByRole("columnheader") });
}
