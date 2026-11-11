import { type Browser, expect, type Page, test } from "@playwright/test";
import { dye2GlobalIdOf, dye2RecipeIdOf } from "@decent-sync/protocol";
import { shotFixture } from "../server/test/support/shot-fixtures.js";
import { SimulatedDye2, dye2List, openDye2Dashboard, recordedDye2MainTablet, selectRecipeInDye2 } from "../server/test/support/simulated-dye2.js";
import { SimulatedTablet, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field, rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// A Recipe's Reference Shot (#472, ADR-0029): chosen from a Shot's page,
// which offers the Shot's own Recipe first and then the others the person
// may edit, says which Recipes it is the Reference Shot of, and is marked in
// the Shots list; shown on the Recipe's page with its numbers, a note where
// its Profile is another than the Recipe's, and cleared there; read by a
// Viewer, who has no control for it; and its curves drawn behind those of
// another Shot of the Recipe, on that Shot's page (#473). A simulated
// tablet running the built plugin acts as DYE2 v0.1.33 does with the steps
// recorded from it (server/test/fixtures/decaid/dye2-v0.1.26/ and later),
// its eight recipes becoming Uptown's Recipes. Serials are made up, from
// 47501.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

type Record_ = Record<string, unknown>;

/** The record id of the recording's Ethiopia, in no slot. */
const ETHIOPIA = "1";
const SHOT = "uptown-ethiopia";
/** Pulled with the Ethiopia loaded too, by the last test. */
const LATER_SHOT = "uptown-ethiopia-later";

/** Uptown's tablet, which the first test loads, and the Library's id of its Ethiopia. */
let uptownTablet: SimulatedTablet;
let ethiopiaId: string;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("from a Shot's page, an Admin makes it its own Recipe's Reference Shot, offered first, then another Location's, and the Shots list marks it", async ({ page }) => {
  const uptown = await createLocation(page, "Uptown");
  const tablet = await tabletAt(page, "Uptown 1", uptown, recordedDye2MainTablet("47501", "Uptown"));
  const recordOf = (id: string) => dye2GlobalIdOf(recipeRecords(tablet).find((record) => record.id === id));
  await expect.poll(() => recordOf(ETHIOPIA)).not.toBeNull();
  const ethiopia = recordOf(ETHIOPIA)!;
  await pullWith(page, tablet, ETHIOPIA, ethiopia, SHOT, 47501);
  uptownTablet = tablet;
  ethiopiaId = ethiopia;

  // Belmont's espresso names a Profile the Shot wasn't pulled on.
  const belmont = await createLocation(page, "Belmont");
  const { shot } = (await (await page.request.get(`/api/shots/${SHOT}`)).json()) as { shot: { profile: { id: string } | null } };
  const { profiles } = (await (await page.request.get("/api/profiles")).json()) as { profiles: { id: string; title: string }[] };
  const another = profiles.find((profile) => profile.id !== shot.profile?.id)!;
  const created = await page.request.post("/api/recipes", { data: { locationId: belmont.id, slot: 1, content: { name: "Belmont espresso", profileId: another.id } } });
  expect(created.status()).toBe(201);

  await page.goto(`/shots/${SHOT}`);
  await page.getByRole("button", { name: "Make it a Reference Shot" }).click();
  const dialog = page.getByRole("dialog", { name: "Make it a Reference Shot" });
  // Its own Recipe comes first, and is chosen to begin with; then each Location's others.
  const recipe = dialog.getByRole("combobox", { name: "Recipe" });
  await expect(recipe).toHaveText("Fixture Ethiopia Espresso at Uptown");
  await recipe.click();
  const options = page.getByRole("option");
  await expect(options.first()).toHaveText("Fixture Ethiopia Espresso at Uptown");
  await expect(page.getByRole("option", { name: "Belmont espresso", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Make it the Reference Shot" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Reference Shot of Fixture Ethiopia Espresso at Uptown", { exact: true })).toBeVisible();

  // Its own Recipe has it already, so it is offered no more.
  await page.getByRole("button", { name: "Make it a Reference Shot" }).click();
  await dialog.getByRole("combobox", { name: "Recipe" }).click();
  await expect(page.getByRole("option", { name: "Fixture Ethiopia Espresso at Uptown" })).toHaveCount(0);
  await page.getByRole("option", { name: "Belmont espresso", exact: true }).click();
  await dialog.getByRole("button", { name: "Make it the Reference Shot" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Reference Shot of Belmont espresso at Belmont, Fixture Ethiopia Espresso at Uptown", { exact: true })).toBeVisible();

  await page.goto("/shots");
  const row = rows(page.getByRole("table", { name: "Shots" })).first();
  await expect(row.getByText("Reference", { exact: true })).toBeVisible();
  await expectTip(row, "Reference", "The Reference Shot of Belmont espresso at Belmont, Fixture Ethiopia Espresso at Uptown.");
});

test("the Recipe's page shows its Reference Shot with its numbers, notes a Profile other than the Recipe's, keeps its choice in its history, and clears it", async ({ page }) => {
  const { ethiopia, belmont } = await recipes(page);
  // Pulled with the Ethiopia loaded, it was pulled on its Profile.
  await page.goto(`/library/recipes/${ethiopia}`);
  const card = page.getByRole("region", { name: "Reference Shot" });
  await expect(field(card, "Machine")).toHaveText("Uptown 1");
  await expect(field(card, "Location")).toHaveText("Uptown");
  await expect(field(card, "Dose")).toHaveText("18 g");
  await expect(field(card, "Yield")).toHaveText("35.9 g");
  await expect(field(card, "Duration")).toHaveText(/^\d+\.\d s$/);
  await expect(card.getByRole("status", { name: "Another Profile" })).toHaveCount(0);
  await field(card, "Pulled").getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/shots/${SHOT}$`));

  // Belmont's names a Profile with a title, which the note names after the Shot's.
  const { recipe: belmontRecipe } = (await (await page.request.get(`/api/recipes/${belmont}`)).json()) as {
    recipe: { uses: { profile: { title: string } }; referenceShot: { profile: { title: string } } };
  };
  await page.goto(`/library/recipes/${belmont}`);
  await expect(card.getByRole("status", { name: "Another Profile" })).toHaveText(
    `It was pulled on ${belmontRecipe.referenceShot.profile.title}, not the Recipe's Profile, ${belmontRecipe.uses.profile.title}, so its curves describe another program.`,
  );
  const history = page.getByRole("table", { name: "History" });
  await expect(rows(history).first()).toContainText("Reference Shot");
  await expect(rows(history).first().getByRole("link", { name: "The Shot" })).toHaveAttribute("href", `/shots/${SHOT}`);

  await card.getByRole("button", { name: "Clear its Reference Shot" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Clear it" }).click();
  await expect(card.getByText("None chosen.")).toBeVisible();
  await expect(rows(history).first()).toContainText("Reference ShotNone");
  // Its Shot is still the Ethiopia's.
  await page.goto(`/shots/${SHOT}`);
  await expect(page.getByText("Reference Shot of Fixture Ethiopia Espresso at Uptown", { exact: true })).toBeVisible();
});

test("a Viewer reads a Recipe's Reference Shot and the Recipes a Shot is that of, with no control choosing or clearing one", async ({ page, browser }) => {
  const { ethiopia } = await recipes(page);
  await asViewer(page, browser, async (valsPage) => {
    await valsPage.goto(`/shots/${SHOT}`);
    await expect(valsPage.getByText("Reference Shot of Fixture Ethiopia Espresso at Uptown", { exact: true })).toBeVisible();
    await expect(valsPage.getByRole("button", { name: "Make it a Reference Shot" })).toHaveCount(0);
    await valsPage.goto(`/library/recipes/${ethiopia}`);
    const card = valsPage.getByRole("region", { name: "Reference Shot" });
    await expect(field(card, "Machine")).toHaveText("Uptown 1");
    await expect(card.getByRole("button", { name: "About Reference Shot" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Clear its Reference Shot" })).toHaveCount(0);
  });
});

test("a Shot's page draws its Recipe's Reference Shot's curves behind its own, with the comparison beside them, but not for the Reference Shot itself, a Recipe with none or one it can't read", async ({ page }) => {
  // The Ethiopia's Reference Shot is the first Shot on its Machine: it has none before it, and is not compared with itself.
  await page.goto(`/shots/${SHOT}`);
  const curves = page.getByRole("region", { name: "Curves" });
  await expect(curves.getByText("There is no earlier Shot on Uptown 1 to compare it with.")).toBeVisible();
  await expect(curves.getByRole("radiogroup")).toHaveCount(0);

  // A later Shot of the Ethiopia, which weighed 34.2 g, is compared with nothing, until one is chosen.
  await pullWith(page, uptownTablet, ETHIOPIA, ethiopiaId, LATER_SHOT, 47501, { actualYield: 34.2 });
  await page.goto(`/shots/${LATER_SHOT}`);
  const choice = curves.getByRole("radiogroup", { name: "Compare with" });
  await expect(choice.getByRole("radio")).toHaveCount(3);
  await expect(choice.getByRole("radio", { name: "Nothing" })).toBeChecked();
  const comparison = curves.getByRole("table", { name: "Comparison with the Reference Shot" });
  await expect(comparison).toHaveCount(0);
  await expect(curves.getByRole("figure", { name: "Pressure", exact: true })).not.toContainText("Reference Shot");

  // A Reference Shot that can't be loaded says so while it is the choice, and no longer once another is made.
  const measurements = `**/api/shots/${SHOT}/measurements`;
  await page.route(measurements, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Internal server error" }) }));
  await choice.getByRole("radio", { name: "Its Recipe's Reference Shot" }).check();
  await expect(curves.getByRole("alert")).toHaveText("Internal server error");
  await expect(comparison).toHaveCount(0);
  await choice.getByRole("radio", { name: "Nothing" }).check();
  await expect(curves.getByRole("alert")).toHaveCount(0);
  await page.unroute(measurements);

  // Its Recipe's Reference Shot, behind each curve, and beside them as the previous Shot is.
  await choice.getByRole("radio", { name: "Its Recipe's Reference Shot" }).check();
  for (const name of ["Pressure", "Flow", "Weight", "Weight flow", "Temperature"]) {
    await expect(curves.getByRole("figure", { name, exact: true })).toContainText("Reference Shot");
  }
  await expect(comparison.getByRole("columnheader")).toHaveText(["", "This Shot", "Reference Shot"]);
  await expect(comparison.getByRole("row", { name: /^Yield/ }).getByRole("cell")).toHaveText(["34.2 g", "35.9 g"]);
  await expect(comparison.getByRole("link", { name: "Reference Shot" })).toHaveAttribute("href", `/shots/${SHOT}`);

  // The previous Shot instead, one at a time: here the same Shot, named as the previous one.
  await choice.getByRole("radio", { name: "The previous Shot on Uptown 1" }).check();
  await expect(curves.getByRole("figure", { name: "Pressure", exact: true })).toContainText("Previous Shot");
  await expect(curves.getByRole("figure", { name: "Pressure", exact: true })).not.toContainText("Reference Shot");
  await expect(curves.getByRole("table", { name: "Comparison with the previous Shot" })).toBeVisible();
  await expect(comparison).toHaveCount(0);
  await choice.getByRole("radio", { name: "Nothing" }).check();
  await expect(curves.getByRole("figure", { name: "Pressure", exact: true })).not.toContainText("Previous Shot");

  // Made its Recipe's Reference Shot itself, it has no other to compare with.
  await choice.getByRole("radio", { name: "Its Recipe's Reference Shot" }).check();
  await expect(comparison).toBeVisible();
  await page.getByRole("button", { name: "Make it a Reference Shot" }).click();
  const dialog = page.getByRole("dialog", { name: "Make it a Reference Shot" });
  await expect(dialog.getByRole("combobox", { name: "Recipe" })).toHaveText("Fixture Ethiopia Espresso at Uptown");
  await dialog.getByRole("button", { name: "Make it the Reference Shot" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(choice.getByRole("radio")).toHaveCount(2);
  await expect(choice.getByRole("radio", { name: "Its Recipe's Reference Shot" })).toHaveCount(0);
  await expect(choice.getByRole("radio", { name: "Nothing" })).toBeChecked();
  await expect(comparison).toHaveCount(0);

  // The Recipe's Reference Shot cleared, a Shot of it is offered only the previous one, once its Recipe is read.
  expect((await page.request.put(`/api/recipes/${ethiopiaId}/reference-shot`, { data: { shotId: null } })).status()).toBe(200);
  const recipeRead = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/recipes/${ethiopiaId}`);
  await page.reload();
  await recipeRead;
  await expect(choice.getByRole("radio", { name: "The previous Shot on Uptown 1" })).toBeVisible();
  await expect(choice.getByRole("radio", { name: "Its Recipe's Reference Shot" })).toHaveCount(0);

  // Its Recipe unreadable, the page says why its Reference Shot isn't offered, apart from the comparison it still makes.
  await page.route(`**/api/recipes/${ethiopiaId}`, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Internal server error" }) }));
  await page.reload();
  await expect(curves.getByRole("alert")).toHaveText("Its Recipe's Reference Shot could not be read, so it is not offered here: Internal server error");
  await choice.getByRole("radio", { name: "The previous Shot on Uptown 1" }).check();
  await expect(curves.getByRole("table", { name: "Comparison with the previous Shot" })).toBeVisible();
  await expect(curves.getByRole("alert")).toHaveCount(1);
});

/** The ids of the two Recipes the first test made the Shot the Reference Shot of. */
async function recipes(page: Page): Promise<{ ethiopia: string; belmont: string }> {
  const { locations } = (await (await page.request.get("/api/locations")).json()) as { locations: { id: string; name: string }[] };
  const at = async (name: string) =>
    ((await (await page.request.get(`/api/locations/${locations.find((location) => location.name === name)!.id}/recipes`)).json()) as { recipes: { id: string; name: string }[] }).recipes;
  return {
    ethiopia: (await at("Uptown")).find((recipe) => recipe.name === "Fixture Ethiopia Espresso")!.id,
    belmont: (await at("Belmont")).find((recipe) => recipe.name === "Belmont espresso")!.id,
  };
}

/**
 * Applies the recipe from DYE2's Select Recipe page or its pill, then pulls
 * a Shot with the Workflow as it stands, its samples a tenth of a second
 * apart, once the server has the Recipe loaded on the Machine, and waits for
 * the Shot to be linked to the Recipe, as shot-recipe-links.spec.ts does.
 * `annotations` are those the Shot records other than the fixture's.
 */
async function pullWith(page: Page, tablet: SimulatedTablet, recordId: string, recipeId: string, id: string, serial: number, annotations: Record_ = {}): Promise<void> {
  const dashboard = await openDye2Dashboard(tablet);
  const applied = dashboard.recipePills().some((pill) => pill.id === recordId) ? await dashboard.applyRecipe(recordId) : (await selectRecipeInDye2(tablet, recordId)).applied;
  expect(applied?.workflow?.status).toBe(200);
  await expect.poll(() => dye2RecipeIdOf(tablet.workflow())).toBe(recordId);
  await expect
    .poll(async () => {
      const { machines } = (await (await page.request.get("/api/machines")).json()) as { machines: { loadedRecipe: { recipe: { id: string } } | null }[] };
      return machines.some((machine) => machine.loadedRecipe?.recipe.id === recipeId);
    })
    .toBe(true);
  const fixture = shotFixture();
  const samples = fixture.measurements as Record_[];
  const startedAt = Date.now() - (samples.length - 1) * 100;
  tablet.pullShot({
    ...fixture,
    id,
    timestamp: new Date(startedAt).toISOString(),
    measurements: samples.map((sample, index) => ({ ...sample, machine: { ...(sample.machine as Record_), timestamp: new Date(startedAt + index * 100).toISOString().slice(0, -1) } })),
    workflow: { ...structuredClone(tablet.workflow()), machine: { ...((fixture.workflow as Record_).machine as Record_), serialNumber: String(serial) } },
    annotations: { ...(fixture.annotations as Record_), ...annotations },
  });
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/shots/${id}`);
      return response.ok() ? ((await response.json()) as { shot: { recipe: { id: string } | null } }).shot.recipe?.id : undefined;
    })
    .toBe(recipeId);
}

/** The tablet's DYE2 recipes. */
function recipeRecords(tablet: SimulatedTablet): Record_[] {
  const list = dye2List(tablet, "recipes");
  return Array.isArray(list) ? (list as Record_[]) : [];
}

/** A Machine at the Location, its tablet connected and kept for the file, polling every 5 s of its time, which runs 50 times faster here. */
async function tabletAt(page: Page, name: string, location: { id: string }, api: Record<string, unknown>): Promise<SimulatedTablet> {
  const response = await page.request.post("/api/machines", { data: { name, locationId: location.id } });
  expect(response.status()).toBe(201);
  const { token } = (await response.json()) as { token: string };
  const tablet = server.keep(() => SimulatedTablet.load({ settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 }, api, dye2: new SimulatedDye2(), timeScale: 50 }));
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}

/** Runs `work` with a page signed in as a new Viewer. */
async function asViewer(page: Page, browser: Browser, work: (page: Page) => Promise<void>) {
  const response = await page.request.post("/api/invites", { data: { email: "val@example.com", role: "viewer", locationIds: [] } });
  expect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const context = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await context.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: { name: "Val Viewer", password: "viewer password 1" } });
    expect(accepted.status()).toBe(201);
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}
