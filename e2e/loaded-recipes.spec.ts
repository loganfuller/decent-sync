import { expect as baseExpect, type Page, test } from "@playwright/test";
import { dye2GlobalIdOf } from "@decent-sync/protocol";
import { DYE2_NAMESPACE, SimulatedDye2, dye2Keys, dye2Library, dye2List, dye2Recording, openDye2Dashboard, saveInDye2 } from "../server/test/support/simulated-dye2.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { field, rows } from "./support/locators.js";

// Each Machine's Loaded Recipe in the management interface (ticket #145):
// a recipe applied in DYE2 on a simulated tablet running the built plugin
// shows on its Machine's page and its Location's page, and its history keeps
// when it was loaded and unloaded. Serials are made up, from 47501.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
const expect = baseExpect.configure({ timeout: 15_000 });

const tablets: SimulatedTablet[] = [];

type Record_ = Record<string, unknown>;

test.beforeEach(({ page }) => signInAsAdmin(page));

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

  expect((await (await openDye2Dashboard(bar1.tablet)).applyRecipe("1")).selection?.status).toBe(200);
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

test("a grind changed on one Machine reaches the Recipe's page, and the Workflow of the other Machine with it loaded, whose sharing status shows it", async ({ page }) => {
  const location = await createLocation(page, "Belmont");
  const recipes = dye2Recording("recipes");
  const bar1 = await tabletAt(page, "Belmont 1", location, {
    ...derivedDe1Pro({ serial: "47511" }),
    ...dye2Library(),
    [`/store/${DYE2_NAMESPACE}/baskets`]: dye2Keys().baskets,
    [`/store/${DYE2_NAMESPACE}/equipment`]: dye2Keys().equipment,
    [`/store/${DYE2_NAMESPACE}/recipes`]: [],
  });
  const bar2 = await tabletAt(page, "Belmont 2", location, { ...derivedDe1Pro({ serial: "47512" }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS });
  await saveInDye2(bar1.tablet, recipes.saveSlot1);
  await saveInDye2(bar1.tablet, recipes.editSlot1);
  for (const { tablet } of [bar1, bar2]) {
    await expect.poll(() => dye2GlobalIdOf(slotOn(tablet, "1"))).not.toBeNull();
    await expect.poll(() => ((slotOn(tablet, "1")?.dashboardVariables ?? {}) as Record_).basketId ?? null).not.toBeNull();
    expect((await (await openDye2Dashboard(tablet)).applyRecipe("1")).selection?.status).toBe(200);
  }
  await page.goto(`/machines/${bar2.id}`);
  await expect(field(page.getByRole("region", { name: "Loaded Recipe" }).getByLabel("Loaded now"), "Recipe")).toHaveText("Fixture Ethiopia EspressoSlot 1");

  await bar1.tablet.changeSettings({ context: { grinderSetting: "2.8" } });
  await expect.poll(() => (bar2.tablet.workflow().context as Record_).grinderSetting).toBe("2.8");
  const sharing = page.getByRole("region", { name: "Sharing" });
  await expect(sharing.getByText("Its Workflow written, or cleared of, the Recipe Fixture Ethiopia Espresso")).toBeVisible();
  await sharing.getByRole("link", { name: "Fixture Ethiopia Espresso" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Ethiopia Espresso", level: 1 })).toBeVisible();
  await expect(page.getByText("2.8", { exact: true }).first()).toBeVisible();
});

/** A Machine at the Location, its tablet connected with that API, polling every 5 s of its time, which runs 50 times faster here. */
async function tabletAt(page: Page, name: string, location: { id: string }, api: Record<string, unknown>): Promise<{ id: string; tablet: SimulatedTablet }> {
  const response = await page.request.post("/api/machines", { data: { name, locationId: location.id } });
  baseExpect(response.status()).toBe(201);
  const { token, machine } = (await response.json()) as { token: string; machine: { id: string } };
  const tablet = SimulatedTablet.load({ settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 }, api, dye2: new SimulatedDye2(), timeScale: 50 });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  return { id: machine.id, tablet };
}

/** The tablet's recipe in a slot, if it holds one there. */
function slotOn(tablet: SimulatedTablet, slot: string): Record_ | undefined {
  const list = dye2List(tablet, "recipes");
  return Array.isArray(list) ? (list as Record_[]).find((record) => record.id === slot) : undefined;
}
