import { expect, type Page, test } from "@playwright/test";
import { dye2GlobalIdOf } from "@decent-sync/protocol";
import { SimulatedDye2, dye2Library, dye2List, openDye2Dashboard, recordedDye2MainTablet, selectRecipeInDye2 } from "../server/test/support/simulated-dye2.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { CHECK_MS, afterStatusPolls } from "./support/polling.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { field, rows } from "./support/locators.js";
import { expectTip } from "./support/tooltips.js";

// Each Machine's Loaded Recipe in the management interface (tickets #145 and
// #216): a recipe applied in DYE2 on a simulated tablet running the built
// plugin, in a Recipe Slot or not, shows on its Machine's page and its
// Location's page, and its history keeps when it was loaded and unloaded; a
// change on one Machine reaches the Recipe and the other Machine that has it
// loaded. The tablet is DYE2 v0.1.26's recording's
// (server/test/fixtures/decaid/dye2-v0.1.26/). Serials are made up, from
// 47501.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

type Record_ = Record<string, unknown>;

/** The recording's tablet's record ids: the Ethiopia's recipe, in no Recipe Slot, and the Brazil's, in slot 2. */
const ETHIOPIA = "1";
const BRAZIL = "2";

test.beforeEach(({ page }) => signInAsAdmin(page));

test("a recipe applied in DYE2 shows as its Machine's Loaded Recipe on the Machine's page and its Location's, in its slot or in none, until the profile changes", async ({ page }) => {
  const location = await createLocation(page, "Uptown");
  // The recording's tablet, with its library, Workflow and eight recipes, its beans' names starting with the scenario's.
  const bar1 = await tabletAt(page, "Bar 1", location, recordedDye2MainTablet("47501", "Uptown"));
  await tabletAt(page, "Bar 2", location, { ...derivedDe1Pro({ serial: "47502" }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS });
  await expect.poll(() => [ETHIOPIA, BRAZIL].map((id) => dye2GlobalIdOf(recordOn(bar1.tablet, id)))).not.toContain(null);

  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto(`/machines/${bar1.id}`);
  const loaded = page.getByRole("region", { name: "Loaded Recipe" });
  await expect(loaded).toContainText("No Recipe is loaded.");

  expect((await (await openDye2Dashboard(bar1.tablet)).applyRecipe(BRAZIL)).workflow?.status).toBe(200);
  const now = loaded.getByLabel("Loaded now");
  await afterStatusPolls(page, () => expect(field(now, "Recipe")).toHaveText("Fixture Brazil EspressoSlot 2", { timeout: CHECK_MS }));
  await expect(field(now, "Since")).toHaveText(/^\w{3} \d+, \d{4}/);
  const history = loaded.getByRole("table", { name: "Loaded Recipe history" });
  await expect(rows(history)).toHaveCount(1);
  await expect(rows(history).first()).toContainText("Still loaded");

  await page.goto(`/locations/${location.id}`);
  const machines = page.getByRole("table", { name: "Loaded Recipes here" });
  await expectTip(page.getByRole("region", { name: "Machines" }), "Machines", "The Machines here now, each flagged if it is capture-only, and the Recipe each has loaded.");
  await expect(rows(machines).filter({ hasText: "Bar 1" })).toContainText("Fixture Brazil Espresso");
  await expect(rows(machines).filter({ hasText: "Bar 1" })).toContainText("Slot 2");
  await expect(rows(machines).filter({ hasText: "Bar 2" })).toContainText("None");
  await rows(machines).filter({ hasText: "Bar 1" }).getByRole("link", { name: "Fixture Brazil Espresso" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Brazil Espresso", level: 1 })).toBeVisible();

  // The Ethiopia's recipe, in no slot, applied from DYE2's Select Recipe page.
  expect((await selectRecipeInDye2(bar1.tablet, ETHIOPIA)).applied?.workflow?.status).toBe(200);
  await page.goto(`/machines/${bar1.id}`);
  await expect(field(now, "Recipe")).toHaveText("Fixture Ethiopia EspressoNo slot");
  await expect(rows(history)).toHaveCount(2);

  // Another profile on the machine unloads it.
  const classic = (dye2Library()["/profiles"] as { profile: Record_ }[]).find((record) => record.profile.title === "Classic Italian espresso")!.profile;
  await bar1.tablet.changeSettings({ profile: classic });
  await page.goto(`/machines/${bar1.id}`);
  await expect(loaded).toContainText("No Recipe is loaded.");
  await expect(rows(history)).toHaveCount(2);
  await expect(rows(history).first()).not.toContainText("Still loaded");
  await expect(rows(history).first().getByRole("cell").nth(2)).toHaveText(/\w{3} \d+, \d{4}/);
  await page.goto(`/locations/${location.id}`);
  await expect(rows(machines).filter({ hasText: "Bar 1" })).toContainText("None");
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
  await expect(field(page.getByRole("region", { name: "Loaded Recipe" }).getByLabel("Loaded now"), "Recipe")).toHaveText("Fixture Brazil EspressoSlot 2");

  // The plugin on Belmont 1 has DYE2 save the change into the recipe, and the server writes it into Belmont 2's Workflow.
  await bar1.tablet.changeSettings({ context: { grinderSetting: "2.8" } });
  await expect.poll(() => (bar2.tablet.workflow().context as Record_).grinderSetting).toBe("2.8");
  const sharing = page.getByRole("region", { name: "Sharing" });
  await afterStatusPolls(page, () => expect(sharing.getByText("Its Workflow written, or cleared of, the Recipe Fixture Brazil Espresso")).toBeVisible({ timeout: CHECK_MS }));
  await sharing.getByRole("link", { name: "Fixture Brazil Espresso" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Brazil Espresso", level: 1 })).toBeVisible();
  await expect(page.getByText("2.8", { exact: true }).first()).toBeVisible();
});

/** A Machine at the Location, its tablet connected with that API and running DYE2, polling every 5 s of its time, which runs 50 times faster here. */
async function tabletAt(page: Page, name: string, location: { id: string }, api: Record<string, unknown>): Promise<{ id: string; tablet: SimulatedTablet }> {
  const response = await page.request.post("/api/machines", { data: { name, locationId: location.id } });
  expect(response.status()).toBe(201);
  const { token, machine } = (await response.json()) as { token: string; machine: { id: string } };
  const tablet = SimulatedTablet.load({ settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 }, api, dye2: new SimulatedDye2(), timeScale: 50 });
  await tablet.waitForLog(/^Connected to /);
  return { id: machine.id, tablet };
}

/** The tablet's recipe with that record id, if it holds one. */
function recordOn(tablet: SimulatedTablet, id: string): Record_ | undefined {
  const list = dye2List(tablet, "recipes");
  return Array.isArray(list) ? (list as Record_[]).find((record) => record.id === id) : undefined;
}
