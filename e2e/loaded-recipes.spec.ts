import { expect, type Locator, type Page, test } from "@playwright/test";
import { dye2GlobalIdOf } from "@decent-sync/protocol";
import { SimulatedDye2, dye2Library, dye2List, openDye2Dashboard, recordedDye2MainTablet, selectRecipeInDye2 } from "../server/test/support/simulated-dye2.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { farFromMidnight } from "./support/calendar.js";
import { useFreshServer } from "./support/fresh-server.js";
import { CHECK_MS, afterStatusPolls } from "./support/polling.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { openMachineTab, rows } from "./support/locators.js";

// Each Machine's Loaded Recipe in the management interface (tickets #145 and
// #216): a recipe applied in DYE2 on a simulated tablet running the built
// plugin, in a Recipe Slot or not, shows in its Machine's Workflow, on the
// Now tab of its page, and on its Location's page, and the Machine's
// Activity tab lists those it had loaded today, with when each was loaded and unloaded; a
// change on one Machine reaches the Recipe and the other Machine that has it
// loaded. The tablet is DYE2 v0.1.26's recording's
// (server/test/fixtures/decaid/dye2-v0.1.26/), as DYE2 v0.1.33 leaves it. Serials are made up, from
// 47501.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

type Record_ = Record<string, unknown>;

/** The recording's tablet's record ids: the Ethiopia's recipe, in no Recipe Slot, and the Brazil's, in slot 2. */
const ETHIOPIA = "1";
const BRAZIL = "2";

test.beforeEach(({ page }) => signInAsAdmin(page));

test("a recipe applied in DYE2 shows as its Machine's Loaded Recipe on the Machine's page and its Location's, in its slot or in none, until the profile changes", async ({ page }) => {
  // Uptown is where no day begins while this runs, as the Activity tab lists today's Loaded Recipes.
  const { zone, zoneName } = farFromMidnight();
  const location = await createLocation(page, "Uptown", zone);
  // The recording's tablet, with its library, Workflow and eight recipes, its beans' names starting with the scenario's.
  const bar1 = await tabletAt(page, "Bar 1", location, recordedDye2MainTablet("47501", "Uptown"));
  await tabletAt(page, "Bar 2", location, { ...derivedDe1Pro({ serial: "47502" }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS });
  await expect.poll(() => [ETHIOPIA, BRAZIL].map((id) => dye2GlobalIdOf(recordOn(bar1.tablet, id)))).not.toContain(null);

  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto(`/machines/${bar1.id}`);
  const loaded = loadedRecipe(page);
  await expect(loaded).toHaveText("No Recipe is loaded.");

  expect((await (await openDye2Dashboard(bar1.tablet)).applyRecipe(BRAZIL)).workflow?.status).toBe(200);
  await afterStatusPolls(page, () => expect(loaded).toHaveText(loadedFrom("Fixture Brazil Espresso", "Slot 2"), { timeout: CHECK_MS }));
  await expect(loaded.getByRole("link", { name: "Fixture Brazil Espresso" })).toHaveAttribute("href", /^\/library\/recipes\//);
  // Those it had loaded are on its Activity tab, not here.
  await expect(page.getByRole("region", { name: "Workflow" }).getByRole("table")).toHaveCount(0);
  let history = await loadedToday(page);
  await expect(rows(history)).toHaveCount(1);
  await expect(rows(history).first()).toContainText("Still loaded");

  await page.goto(`/locations/${location.id}`);
  // Its Overview's status cards are its Machines, each with the Recipe it has loaded (#543).
  const machines = page.getByRole("list", { name: /^Machines at / }).getByRole("listitem");
  await expect(machines.filter({ hasText: "Bar 1" })).toContainText("Loaded: Fixture Brazil Espresso (slot 2)");
  await expect(machines.filter({ hasText: "Bar 2" })).toContainText("No Recipe loaded");
  await expect(page.getByRole("region", { name: "Machines" })).toHaveCount(0);
  await machines.filter({ hasText: "Bar 1" }).getByRole("link", { name: "Fixture Brazil Espresso" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Brazil Espresso", level: 1 })).toBeVisible();

  // The Ethiopia's recipe, in no slot, applied from DYE2's Select Recipe page.
  expect((await selectRecipeInDye2(bar1.tablet, ETHIOPIA)).applied?.workflow?.status).toBe(200);
  await page.goto(`/machines/${bar1.id}`);
  await expect(loaded).toHaveText(loadedFrom("Fixture Ethiopia Espresso", "No slot"));
  history = await loadedToday(page);
  await expect(rows(history)).toHaveCount(2);
  await expect(rows(history).getByRole("cell").filter({ hasText: /^Fixture/ })).toHaveText(["Fixture Ethiopia EspressoNo slot", "Fixture Brazil EspressoSlot 2"]);

  // Another profile on the machine unloads it.
  const classic = (dye2Library()["/profiles"] as { profile: Record_ }[]).find((record) => record.profile.title === "Classic Italian espresso")!.profile;
  await bar1.tablet.changeSettings({ profile: classic });
  await page.goto(`/machines/${bar1.id}`);
  await expect(loaded).toHaveText("No Recipe is loaded.");
  history = await loadedToday(page);
  await expect(rows(history)).toHaveCount(2);
  await expect(rows(history).first()).not.toContainText("Still loaded");
  // When it was unloaded, today, as a time at Uptown, with Uptown's zone.
  await expect(rows(history).first().getByRole("cell").nth(2)).toHaveText(new RegExp(`^\\d+:\\d\\d:\\d\\d [AP]M ${zoneName.replace("+", "\\+")}$`));
  await page.goto(`/locations/${location.id}`);
  await expect(machines.filter({ hasText: "Bar 1" })).toContainText("No Recipe loaded");
});

test("a grind changed on one Machine reaches the Recipe's page, and the Workflow of the other Machine with it loaded, whose sharing status shows it", async ({ page }) => {
  const location = await createLocation(page, "Belmont");
  const bar1 = await tabletAt(page, "Belmont 1", location, recordedDye2MainTablet("47511", "Belmont"));
  await expect.poll(() => dye2GlobalIdOf(recordOn(bar1.tablet, BRAZIL))).not.toBeNull();
  const bar2 = await tabletAt(page, "Belmont 2", location, { ...derivedDe1Pro({ serial: "47512" }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS });
  for (const { tablet } of [bar1, bar2]) {
    await expect.poll(() => dye2GlobalIdOf(recordOn(tablet, BRAZIL))).not.toBeNull();
    await expect.poll(() => ((recordOn(tablet, BRAZIL)?.dashboardVariables ?? {}) as Record_).basketId ?? null).not.toBeNull();
    expect((await (await openDye2Dashboard(tablet)).applyRecipe(BRAZIL)).workflow?.status).toBe(200);
  }
  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto(`/machines/${bar2.id}`);
  await expect(loadedRecipe(page)).toHaveText(loadedFrom("Fixture Brazil Espresso", "Slot 2"));

  // The plugin on Belmont 1 has DYE2 save the change into the recipe, and the server writes it into Belmont 2's Workflow.
  await bar1.tablet.changeSettings({ context: { grinderSetting: "2.8" } });
  await expect.poll(() => (bar2.tablet.workflow().context as Record_).grinderSetting).toBe("2.8");
  await openMachineTab(page, "Setup");
  const sharing = page.getByRole("region", { name: "Sharing" });
  await afterStatusPolls(page, () => expect(sharing.getByText("Its Workflow written, or cleared of, the Recipe Fixture Brazil Espresso")).toBeVisible({ timeout: CHECK_MS }));
  await sharing.getByRole("link", { name: "Fixture Brazil Espresso" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Brazil Espresso", level: 1 })).toBeVisible();
  await expect(page.getByText("2.8", { exact: true }).first()).toBeVisible();
});

/** The line in the Workflow, on a Machine page's Now tab, naming the Recipe it was loaded from, or that none is loaded. */
function loadedRecipe(page: Page): Locator {
  return page.getByRole("region", { name: "Workflow" }).getByRole("group", { name: "Loaded Recipe" });
}

/** What that line reads for a Recipe loaded, with its slot ("Slot 2", "No slot"), since a date. */
function loadedFrom(recipe: string, slot: string): RegExp {
  return new RegExp(`^Loaded from\\s*${recipe}\\s*${slot}\\s*since \\w{3} \\d+, \\d{4}`);
}

/** The Loaded Recipes the Machine page's Activity tab lists for today, latest loaded first, opened on them. */
async function loadedToday(page: Page): Promise<Locator> {
  await openMachineTab(page, "Activity");
  const activity = page.getByRole("region", { name: "On one day" });
  await activity.getByRole("tab", { name: "Loaded Recipes" }).click();
  return activity.getByRole("table", { name: "Loaded Recipes that day" });
}

/**
 * A Machine at the Location, its tablet connected with that API and running DYE2, polling every 5 s of its time, which
 * runs 50 times faster here. It is there since long before, so its days are the Location's: a Machine put there only
 * now has today read in UTC, the zone it was in at noon UTC, which from 00:00 to 04:00 UTC is over where the Location
 * is still on the day before (#499).
 */
async function tabletAt(page: Page, name: string, location: { id: string }, api: Record<string, unknown>): Promise<{ id: string; tablet: SimulatedTablet }> {
  const response = await page.request.post("/api/machines", { data: { name } });
  expect(response.status()).toBe(201);
  const { token, machine } = (await response.json()) as { token: string; machine: { id: string } };
  const moved = await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" } });
  expect(moved.status()).toBe(201);
  const tablet = SimulatedTablet.load({ settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 }, api, dye2: new SimulatedDye2(), timeScale: 50 });
  await tablet.waitForLog(/^Connected to /);
  return { id: machine.id, tablet };
}

/** The tablet's recipe with that record id, if it holds one. */
function recordOn(tablet: SimulatedTablet, id: string): Record_ | undefined {
  const list = dye2List(tablet, "recipes");
  return Array.isArray(list) ? (list as Record_[]).find((record) => record.id === id) : undefined;
}
