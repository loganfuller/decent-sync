import { expect, type Page, test } from "@playwright/test";
import { globalIdOf } from "@decent-sync/protocol";
import { shotFixture } from "../server/test/support/shot-fixtures.js";
import { useFreshServer } from "./support/fresh-server.js";
import { rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";

// What a Bean Batch is for and what a Location has, in the management
// interface (ticket #707): a batch's page lists the Recipes that name it, at
// any Location, with each one's Location and Recipe Slot, and a Location's
// page lists the batches there, each with its weight there, what Shots have
// used and Batch Moves have brought and taken since, and the Recipes there
// that name it. A Viewer reads both. The rules themselves are
// server/test/library-batch-lists.test.ts's.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

/** What the Machine's tablet holds over derivedDe1Pro()'s: no library. */
const tabletApi = { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] };

const val = { name: "Val Viewer", email: "val@example.com", password: "viewer password 1" };

type Record_ = Record<string, unknown>;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("a batch's page lists the Recipes that name it at any Location, and a Location's page lists its batches with each one's weight, Shots, moves and Recipes there, which a Viewer reads too", async ({ page, browser }) => {
  const downtown = await createLocation(page, "Downtown");
  const riverside = await createLocation(page, "Riverside");
  const harbor = await createLocation(page, "Harbor");
  const tablet = await tabletAt(page, server, "Bar Left", downtown, "70751", tabletApi);
  const { bean } = await post<{ bean: { id: string } }>(page, "/api/beans", { content: { roaster: "Lantern Coffee Roasters", name: "Ethiopia Guji Natural" } });
  const batchOf = async (roastDate: string, batchCode: string | undefined, remainingWeight?: number) =>
    (
      await post<{ batch: { id: string } }>(page, "/api/bean-batches", {
        beanId: bean.id,
        content: { roastDate, ...(batchCode === undefined ? {} : { batchCode }) },
        locations: [{ locationId: downtown.id, ...(remainingWeight === undefined ? {} : { remainingWeight }) }],
      })
    ).batch.id;
  const guji = await batchOf("2026-11-18", "LR-0412", 4180);
  const older = await batchOf("2026-11-10", undefined);
  const unnamed = await batchOf("2026-11-02", "LR-0399", 250);
  const recipe = async (location: { id: string }, name: string, beanBatchId: string, slot: number | null, content: Record_ = {}) =>
    (await post<{ recipe: { id: string } }>(page, "/api/recipes", { locationId: location.id, slot, content: { name, beanBatchId, ...content } })).recipe.id;
  const espresso = await recipe(downtown, "Guji Espresso", guji, 2, { dose: 20, yield: 46 });
  await recipe(downtown, "Guji Long", guji, null, { dose: 18, yield: 54 });
  // A Recipe at another Location takes the batch there, with no weight.
  await recipe(riverside, "Guji Cupping", guji, 5);
  // A Recipe naming another roast of the same Bean is not one of this batch's.
  await recipe(downtown, "Last week's Guji", older, null);

  // Two Shots at Downtown since its weight was entered, then 500 g moved to Riverside.
  const local = () => tablet.batches().find((record) => globalIdOf(record) === guji)?.id;
  await expect.poll(local).toBeTruthy();
  tablet.pullShot(shotWith("listed-1", "70751", local(), 18.5));
  tablet.pullShot(shotWith("listed-2", "70751", local(), 20));
  await expect.poll(async () => ((await (await page.request.get(`/api/shots?beanBatchId=${guji}`)).json()) as { total: number }).total).toBe(2);
  expect((await page.request.post(`/api/bean-batches/${guji}/moves`, { data: { fromLocationId: downtown.id, toLocationId: riverside.id, amount: 500 } })).status()).toBe(200);

  // The batch's page: every Recipe that names it, by Location, then slot, then those in no slot.
  await page.goto(`/library/bean-batches/${guji}`);
  const naming = page.getByRole("region", { name: "Recipes", exact: true }).getByRole("table", { name: "Recipes naming this batch" });
  await expect(rows(naming)).toHaveText([
    ["Guji Espresso", "Downtown", "2", "20 g → 46 g", ""].join(""),
    ["Guji Long", "Downtown", "No slot", "18 g → 54 g", ""].join(""),
    ["Guji Cupping", "Riverside", "5", "-", ""].join(""),
  ]);
  await naming.getByRole("link", { name: "Guji Espresso", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/library/recipes/${espresso}$`));
  await expect(page.getByRole("heading", { level: 1, name: /Guji Espresso/ })).toBeVisible();
  // A batch no Recipe names says so.
  await page.goto(`/library/bean-batches/${unnamed}`);
  await expect(page.getByRole("region", { name: "Recipes", exact: true })).toContainText("No Recipe names this batch.");

  // Downtown's page: its batches, the latest roasted first, each with what is Downtown's alone.
  await page.goto(`/locations/${downtown.id}`);
  const here = page.getByRole("region", { name: "Bean Batches", exact: true });
  await expect(here).toContainText("3 batches here, 2 with a weight");
  const listed = here.getByRole("table", { name: "Bean Batches here" });
  await expect(rows(listed)).toHaveText([
    /^Ethiopia Guji NaturalRoasted 2026-11-18LR-04123641\.5 gof 4180 g entered .+38\.5 g used, 2 Shots500 g moved to RiversideGuji Espresso slot 2Guji Long no slot$/,
    // A batch with no weight here is not tracked, never zero.
    /^Ethiopia Guji NaturalRoasted 2026-11-10NoneNot trackedNo weight enteredShotsLast week's Guji no slot$/,
    /^Ethiopia Guji NaturalRoasted 2026-11-02LR-0399250 gof 250 g entered .+0 g used, 0 ShotsNothing movedNone$/,
  ]);
  // Riverside's has the same batch with Riverside's own weight, Shots, moves and Recipe.
  await page.goto(`/locations/${riverside.id}`);
  await expect(here).toContainText("1 batch here, 1 with a weight");
  await expect(rows(listed)).toHaveText([/^Ethiopia Guji NaturalRoasted 2026-11-18LR-0412500 gof 500 g arrived .+0 g used, 0 ShotsNothing movedGuji Cupping slot 5$/]);
  // A Location with none says so.
  await page.goto(`/locations/${harbor.id}`);
  await expect(page.getByRole("region", { name: "Bean Batches", exact: true })).toContainText("No Bean Batch is here.");
  await expect(page.getByRole("table", { name: "Bean Batches here" })).toHaveCount(0);

  // A row's links open the batch's Shots here, one of its Recipes, and the batch.
  await page.goto(`/locations/${downtown.id}`);
  const row = rows(listed).first();
  await row.getByRole("link", { name: "2 Shots", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?beanBatchId=${guji}&locationId=${downtown.id}$`));
  await expect(rows(page.getByRole("table", { name: "Shots" }))).toHaveCount(2);
  await page.goBack();
  await row.getByRole("link", { name: "Guji Espresso", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/library/recipes/${espresso}$`));
  await page.goBack();
  await row.getByRole("link", { name: "Ethiopia Guji Natural", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/library/bean-batches/${guji}$`));

  // Moved away from Riverside entirely, the batch is no longer in its list, and its Recipe there is still on the batch's page, marked.
  expect((await page.request.post(`/api/bean-batches/${guji}/moves`, { data: { fromLocationId: riverside.id, toLocationId: downtown.id, amount: "all" } })).status()).toBe(200);
  await page.reload();
  await expect(rows(naming).nth(2)).toHaveText(["Guji Cupping", "Riverside", "5", "-", "Batch finished there"].join(""));
  await expect(rows(naming)).toHaveCount(3);
  await page.goto(`/locations/${riverside.id}`);
  await expect(page.getByRole("region", { name: "Bean Batches", exact: true })).toContainText("No Bean Batch is here.");

  // A Viewer reads both, at every Location, and changes nothing in either.
  const { link } = await post<{ link: string }>(page, "/api/invites", { email: val.email, role: "viewer", locationIds: [] });
  const valsBrowser = await browser.newContext({ baseURL: server.url() });
  try {
    expect((await valsBrowser.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: val })).status()).toBe(201);
    const valsPage = await valsBrowser.newPage();
    await valsPage.goto(`/library/bean-batches/${guji}`);
    await expect(rows(valsPage.getByRole("table", { name: "Recipes naming this batch" }))).toHaveCount(3);
    await valsPage.goto(`/locations/${downtown.id}`);
    const valsList = valsPage.getByRole("region", { name: "Bean Batches", exact: true });
    await expect(rows(valsList.getByRole("table", { name: "Bean Batches here" }))).toHaveCount(3);
    await expect(valsList.getByRole("button").filter({ hasNotText: /^$/ })).toHaveCount(0);
  } finally {
    await valsBrowser.close();
  }
});

/** A Shot pulled a minute from now on the Machine of that serial, its Workflow naming the batch by the tablet's id for it, with the dose measured. */
function shotWith(id: string, serial: string, beanBatchId: unknown, dose: number): Record_ {
  const fixture = shotFixture();
  const workflow = fixture.workflow as Record_;
  return {
    ...fixture,
    id,
    timestamp: new Date(Date.now() + 60_000).toISOString(),
    annotations: { ...(fixture.annotations as Record_), actualDoseWeight: dose },
    workflow: {
      ...workflow,
      machine: { ...(workflow.machine as Record_), serialNumber: serial },
      context: { ...(workflow.context as Record_), grinderId: null, beanBatchId },
    },
  };
}

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as T;
}
