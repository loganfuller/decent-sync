import { expect as baseExpect, type Browser, type Page, test } from "@playwright/test";
import { LOADED_RECIPE_KEY, dye2GlobalIdOf } from "@decent-sync/protocol";
import { shotFixture } from "../server/test/support/shot-fixtures.js";
import { DYE2_NAMESPACE, applyInDye2, dye2Keys, dye2Library, dye2List, dye2Recording, saveInDye2, withDye2Selection } from "../server/test/support/simulated-dye2.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { field, rows } from "./support/locators.js";

// Shots linked to their Recipe and Basket (ticket #147): each Recipe's and
// Basket's page lists its Shots, and the Shots list filters by them; an
// Admin hard-deletes a Recipe no Shot was pulled with, which leaves every
// tablet, but not one a Shot was, nor a Basket a Recipe names, and Staff
// delete nothing. Simulated tablets running the built plugin act as DYE2
// does with the steps recorded from it. Serials are made up, from 49501.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
const expect = baseExpect.configure({ timeout: 15_000 });

const tablets: SimulatedTablet[] = [];
const sam = { name: "Sam Staff", email: "sam@example.com", password: "staff password 1" };

type Record_ = Record<string, unknown>;

test.beforeEach(({ page }) => signInAsAdmin(page));

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("each Recipe's and Basket's page lists its Shots, and the Shots list filters by Recipe and by Basket", async ({ page }) => {
  const { bar1, one, two } = await lab(page, "Uptown", 49501);
  await pullWith(page, bar1, "1", one, "uptown-slot-1", 49501);
  await pullWith(page, bar1, "2", two, "uptown-slot-2", 49501);
  const basket = (await recipe(page, two)).content.basketId as string;

  await page.goto(`/library/recipes/${one}`);
  const recipeShots = page.getByRole("table", { name: "Shots with this Recipe" });
  await expect(rows(recipeShots)).toHaveCount(1);
  await rows(recipeShots).first().getByRole("link").first().click();
  await expect(page).toHaveURL(/\/shots\/uptown-slot-1$/);
  const shot = page.getByLabel("Shot", { exact: true });
  await expect(field(shot, "Recipe")).toHaveText("Fixture Ethiopia Espresso");
  await field(shot, "Recipe").getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Fixture Ethiopia Espresso", level: 1 })).toBeVisible();

  // Slot 2's Shot, by its Recipe in the Shots list.
  await page.goto(`/library/recipes/${two}`);
  await page.getByRole("link", { name: "Filter the Shots list by it" }).click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?recipeId=${two}$`));
  const list = page.getByRole("table", { name: "Shots" });
  await expect(rows(list)).toHaveCount(1);
  await expect(page.getByLabel("Recipe", { exact: true })).toHaveText("Fixture Brazil Espresso, Uptown");
  await page.getByLabel("Recipe", { exact: true }).click();
  await page.getByRole("option", { name: "Any Recipe" }).click();
  await expect(rows(list)).toHaveCount(2);

  // By its Basket, which its page lists it under too.
  await page.getByLabel("Basket", { exact: true }).click();
  const basketName = (await page.request.get(`/api/baskets/${basket}`).then((response) => response.json()) as { basket: { name: string } }).basket.name;
  await page.getByRole("option", { name: basketName, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`basketId=${basket}`));
  await expect(list.getByRole("link", { name: /./ }).first()).toBeVisible();
  await page.goto(`/shots/uptown-slot-2`);
  await expect(field(page.getByLabel("Shot", { exact: true }), "Basket")).toHaveText(basketName);
  await field(page.getByLabel("Shot", { exact: true }), "Basket").getByRole("link").click();
  await expect(page.getByRole("heading", { name: basketName, level: 1 })).toBeVisible();
  await expect(page.getByRole("table", { name: "Shots with this Basket" }).getByRole("link", { name: /./ }).first()).toBeVisible();
});

test("an Admin hard-deletes a Recipe no Shot was pulled with from every tablet, but not one a Shot was, nor a Basket a Recipe names, and Staff cannot", async ({
  page,
  browser,
}) => {
  const { location, bar1, bar2, one, two } = await lab(page, "Belmont", 49511);
  await pullWith(page, bar1, "1", one, "belmont-slot-1", 49511);

  // Staff working there see no Delete, and are refused one.
  await asStaff(browser, page, location, async (samsPage) => {
    await samsPage.goto(`/library/recipes/${two}`);
    await expect(samsPage.getByRole("heading", { name: "Fixture Brazil Espresso", level: 1 })).toBeVisible();
    await expect(samsPage.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
    await expect(samsPage.getByRole("button", { name: "Delete" })).toHaveCount(0);
    baseExpect((await samsPage.request.delete(`/api/recipes/${two}`)).status()).toBe(403);
  });

  // The Recipe a Shot was pulled with stays.
  await page.goto(`/library/recipes/${one}`);
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alert")).toContainText("A Shot names this Recipe, so it cannot be deleted.");

  // A Basket a Recipe names stays.
  const created = await page.request.post("/api/baskets", { data: { locationId: location.id, content: { name: "Belmont 22 g" } } });
  baseExpect(created.status()).toBe(201);
  const basket = ((await created.json()) as { basket: { id: string } }).basket.id;
  baseExpect((await page.request.patch(`/api/recipes/${two}`, { data: { content: { basketId: basket } } })).status()).toBe(200);
  await page.goto(`/library/baskets/${basket}`);
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alert")).toContainText("A Recipe names this Basket, so it cannot be deleted.");

  // The Recipe no Shot was pulled with goes, from both tablets.
  await page.goto(`/library/recipes/${two}`);
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(new RegExp(`/locations/${location.id}$`));
  for (const tablet of [bar1, bar2]) await expect.poll(() => recipeRecords(tablet).some((record) => dye2GlobalIdOf(record) === two)).toBe(false);
  expect(recipeRecords(bar1).some((record) => dye2GlobalIdOf(record) === one)).toBe(true);
  baseExpect((await page.request.get(`/api/recipes/${two}`)).status()).toBe(404);
});

/**
 * A Location with two Machines: Bar 1, the recording's tablet with DYE2
 * v0.1.20's selection, whose DYE2 editor saves slots 1 and 2, and Bar 2,
 * whose tablet has no DYE2 lists, each written both.
 */
async function lab(page: Page, name: string, serial: number) {
  const location = await createLocation(page, name);
  const recipes = dye2Recording("recipes");
  const bar1 = await tabletAt(page, `${name} 1`, location, withDye2Selection({
    ...derivedDe1Pro({ serial: String(serial) }),
    ...dye2Library(),
    [`/store/${DYE2_NAMESPACE}/baskets`]: dye2Keys().baskets,
    [`/store/${DYE2_NAMESPACE}/equipment`]: dye2Keys().equipment,
    [`/store/${DYE2_NAMESPACE}/recipes`]: [],
  }));
  const bar2 = await tabletAt(page, `${name} 2`, location, { ...derivedDe1Pro({ serial: String(serial + 1) }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS });
  await saveInDye2(bar1, recipes.saveSlot1);
  await saveInDye2(bar1, recipes.saveSlot2);
  await saveInDye2(bar1, recipes.editSlot1);
  const inSlot = (slot: string) => dye2GlobalIdOf(recipeRecords(bar1).find((record) => record.id === slot));
  await expect.poll(() => [inSlot("1"), inSlot("2")]).not.toContain(null);
  const [one, two] = [inSlot("1")!, inSlot("2")!];
  for (const id of [one, two]) await expect.poll(() => recipeRecords(bar2).some((record) => dye2GlobalIdOf(record) === id)).toBe(true);
  return { location, bar1, bar2, one, two };
}

/**
 * Applies the slot on the tablet's DYE2 dashboard, then pulls a Shot with
 * the Workflow as it stands, its samples a tenth of a second apart, once its
 * Machine has the Recipe loaded, and waits for the Shot to be linked to it.
 */
async function pullWith(page: Page, tablet: SimulatedTablet, slot: string, recipeId: string, id: string, serial: number): Promise<void> {
  baseExpect((await applyInDye2(tablet, slot)).status).toBe(200);
  await expect.poll(() => ((tablet.workflow().context as Record_ | undefined)?.extras as Record_ | undefined)?.[LOADED_RECIPE_KEY]).toBe(recipeId);
  const fixture = shotFixture();
  const samples = fixture.measurements as Record_[];
  const startedAt = Date.now() - (samples.length - 1) * 100;
  tablet.pullShot({
    ...fixture,
    id,
    timestamp: new Date(startedAt).toISOString(),
    measurements: samples.map((sample, index) => ({ ...sample, machine: { ...(sample.machine as Record_), timestamp: new Date(startedAt + index * 100).toISOString().slice(0, -1) } })),
    workflow: { ...structuredClone(tablet.workflow()), machine: { ...((fixture.workflow as Record_).machine as Record_), serialNumber: String(serial) } },
  });
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/shots/${id}`);
      return response.ok() ? ((await response.json()) as { shot: { recipe: { id: string } | null } }).shot.recipe?.id : undefined;
    })
    .toBe(recipeId);
}

async function recipe(page: Page, id: string): Promise<{ content: Record_ }> {
  return ((await (await page.request.get(`/api/recipes/${id}`)).json()) as { recipe: { content: Record_ } }).recipe;
}

/** The tablet's DYE2 recipes. */
function recipeRecords(tablet: SimulatedTablet): Record_[] {
  const list = dye2List(tablet, "recipes");
  return Array.isArray(list) ? (list as Record_[]) : [];
}

/** Runs `act` as Sam, Staff at the Location, signed in in a browser of their own. */
async function asStaff(browser: Browser, page: Page, location: { id: string }, act: (samsPage: Page) => Promise<void>): Promise<void> {
  const response = await page.request.post("/api/invites", { data: { email: sam.email, role: "staff", locationIds: [location.id] } });
  baseExpect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const samsBrowser = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await samsBrowser.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: sam });
    baseExpect(accepted.status()).toBe(201);
    await act(await samsBrowser.newPage());
  } finally {
    await samsBrowser.close();
  }
}

/** A Machine at the Location, its tablet connected, polling every 5 s of its time, which runs 50 times faster here. */
async function tabletAt(page: Page, name: string, location: { id: string }, api: Record<string, unknown>): Promise<SimulatedTablet> {
  const response = await page.request.post("/api/machines", { data: { name, locationId: location.id } });
  baseExpect(response.status()).toBe(201);
  const { token } = (await response.json()) as { token: string };
  const tablet = SimulatedTablet.load({ settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 }, api, timeScale: 50 });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}
