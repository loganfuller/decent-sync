import { expect as baseExpect, type Page, test } from "@playwright/test";
import { GLOBAL_ID_KEY, RECIPE_SLOT_FIELD } from "@decent-sync/protocol";
import { DYE2_NAMESPACE, dye2List } from "../server/test/support/simulated-dye2.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, derivedProfile, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { field, rows } from "./support/locators.js";
import { expectTip } from "./support/tooltips.js";

// Recipes in the management interface (ticket #143): each Location's Recipe
// Slots and its Recipes in no slot, a Recipe created and edited with the
// Recipe form, offering slots 1 to 5, moved between slots, taken out of its
// slot, Archived and restored; what the form offers at the Location, and
// when every slot holds a Recipe; a Recipe whose batch is finished there
// flagged; its Conflicts; and what Staff may change; and a
// Recipe copied to another Location (ticket #144); its steam, hot water and
// flush settings, each held or the Machine's own (ticket #173). Simulated tablets running
// the built plugin save Profiles, which have no REST create, and make
// Conflicts; what each Location's tablets are written is
// server/test/library-recipe-management.test.ts's and
// library-recipe-copies.test.ts's. Serials are made up, from 45501.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
const expect = baseExpect.configure({ timeout: 15_000 });

const tablets: SimulatedTablet[] = [];

type Record_ = Record<string, unknown>;

test.beforeEach(({ page }) => signInAsAdmin(page));

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("Staff create a Recipe in slot 3 of the five at their Location with a batch from elsewhere and a hidden Profile, edit it, and can't change another Location's", async ({
  page,
  browser,
}) => {
  const lab = await createLocation(page, "Roastery lab");
  const cafe = await createLocation(page, "Uptown");
  const cafeTablet = await tabletAt(page, "Uptown 1", cafe, "45503");
  // A batch at the cafe only, and a Profile saved on the cafe's tablet, shown there only.
  await createBatch(page, "Guji", cafe);
  const profile = await cafeTablet.addProfile(derivedProfile("Uptown Bloom", 7.25));
  const profileId = String(profile.id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(profileId)}`)).status()).toBe(200);
  const elsewhere = await createRecipe(page, cafe, 1, { name: "Uptown Espresso" });

  const sam = await staffAt(page, browser, "sam@example.com", lab);
  try {
    const samsPage = await sam.newPage();
    await samsPage.goto(`/locations/${lab.id}`);
    const recipes = samsPage.getByRole("region", { name: "Recipes" });
    await expect(recipes).toContainText("No Recipe is in a slot here yet.");
    await expectTip(recipes, "Recipes", /^Its Recipe Slots, 1 to 5, the buttons of Streamline's DYE strip.+ Every Recipe here not Archived is on each tablet here\.$/);
    await recipes.getByRole("button", { name: "New Recipe" }).click();
    const form = samsPage.getByRole("form", { name: "New Recipe" });
    await form.getByLabel("Name", { exact: true }).fill("Lab Guji");
    await form.getByLabel("Beverage").fill("Espresso");
    await form.getByLabel("Bean Batch").click();
    await samsPage.getByRole("option", { name: "Guji, roasted 2026-10-01 (adds it here)" }).click();
    await form.getByLabel("Profile").click();
    await samsPage.getByRole("option", { name: "Uptown Bloom (shows it here)" }).click();
    await form.getByLabel("Dose (g)").fill("18");
    await form.getByLabel("Yield (g)").fill("40");
    await form.getByLabel("Recipe Slot").click();
    await samsPage.getByRole("option", { name: "A slot of my choosing" }).click();
    // The slots offered are the five buttons of Streamline's DYE strip.
    await form.getByLabel("Slot", { exact: true }).click();
    await expect(samsPage.getByRole("option")).toHaveText(["1", "2", "3", "4", "5"]);
    await samsPage.getByRole("option", { name: "3", exact: true }).click();
    // The form says what saving offers at the lab.
    const also = form.getByRole("status", { name: "Saving also" });
    await expect(also).toContainText("adds the Bean Batch Guji, roasted 2026-10-01 at Roastery lab");
    await expect(also).toContainText("shows the Profile Uptown Bloom at Roastery lab");
    await form.getByRole("button", { name: "Create" }).click();

    await expect(samsPage.getByRole("heading", { name: "Lab Guji", level: 1 })).toBeVisible();
    await expect(samsPage.getByText("Slot 3 at Roastery lab")).toBeVisible();
    const main = samsPage.getByRole("main");
    await expectTip(main, "Recipe", "Its dial as saved on tablets or here, with the edits made since, which reach every tablet at its Location.");
    await expectTip(main, "Steam, hot water and flush", "What a Machine loading it takes. A setting it does not hold is left as each Machine has it.");
    const details = samsPage.getByLabel("Recipe", { exact: true });
    await expect(field(details, "Profile")).toHaveText("Uptown Bloom");
    await expect(field(details, "Bean Batch")).toHaveText("Guji, roasted 2026-10-01");
    // A new Recipe holds no steam, hot water or flush setting.
    await expect(field(samsPage.getByLabel("Flush", { exact: true }), "Flush time")).toHaveText("Machine's own");

    await samsPage.getByRole("button", { name: "Edit the Recipe" }).click();
    const edit = samsPage.getByRole("form", { name: "Edit Lab Guji" });
    await edit.getByLabel("Dose (g)").fill("18.5");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(field(details, "Dose")).toHaveText("18.5 g");

    // The lab's page lists it in slot 3.
    await samsPage.getByRole("link", { name: "← Roastery lab" }).click();
    const slot3 = rows(samsPage.getByRole("table", { name: "Recipe Slots" })).filter({ hasText: "Lab Guji" });
    await expect(slot3.getByRole("cell").first()).toHaveText("3");
    await expect(slot3).toContainText("18.5 g → 40 g");

    // At the cafe, where Sam does not work, nothing can be changed.
    await samsPage.goto(`/library/recipes/${elsewhere.id}`);
    await expect(samsPage.getByRole("heading", { name: "Uptown Espresso", level: 1 })).toBeVisible();
    await expect(samsPage.getByText("Only Admins, and Staff working at Uptown, change its Recipes.")).toBeVisible();
    await expect(samsPage.getByRole("button", { name: "Edit the Recipe" })).toHaveCount(0);
    await expect(samsPage.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
    await samsPage.goto(`/locations/${cafe.id}`);
    await expect(samsPage.getByRole("table", { name: "Recipe Slots" })).toContainText("Uptown Espresso");
    await expect(samsPage.getByRole("button", { name: "New Recipe" })).toHaveCount(0);
  } finally {
    await sam.close();
  }
});

test("moving a Recipe from slot 2 to slot 4 swaps the two, keeping its history, and one taken out of its slot is kept, Archived and restored", async ({ page }) => {
  const lab = await createLocation(page, "Slots lab");
  const two = await createRecipe(page, lab, 2, { name: "Slots Brazil", dose: 18 });
  await createRecipe(page, lab, 4, { name: "Slots Ethiopia", dose: 17 });

  await page.goto(`/library/recipes/${two.id}`);
  await expect(page.getByText("Slot 2 at Slots lab")).toBeVisible();
  await page.getByRole("button", { name: "Move to a slot" }).click();
  const move = page.getByRole("form", { name: "Move the Recipe" });
  await move.getByLabel("Slot", { exact: true }).click();
  await page.getByRole("option", { name: "4", exact: true }).click();
  await expect(move.getByRole("list", { name: "About this slot" })).toContainText("Slot 4 holds Slots Ethiopia, which moves to slot 2.");
  await move.getByRole("button", { name: "Move" }).click();
  await expect(page.getByText("Slot 4 at Slots lab")).toBeVisible();
  // The moved Recipe keeps its history: the move above its creation.
  const history = rows(page.getByRole("table", { name: "History" }));
  await expect(history.nth(0)).toContainText("Slot at Slots lab4");
  await expect(history.last()).toContainText("NameSlots Brazil");

  // Taken out of its slot, it is listed in no slot at the lab, and Slots Ethiopia stays in slot 2.
  await page.getByRole("button", { name: "Take out of its slot" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Take it out" }).click();
  await expect(page.getByText("In no slot at Slots lab")).toBeVisible();
  await page.getByRole("link", { name: "← Slots lab" }).click();
  await expect(rows(page.getByRole("table", { name: "Recipes in no slot" }))).toHaveText([/Slots Brazil/]);
  // Where a tablet finds one in no slot stays on the page.
  await expect(page.getByRole("region", { name: "Recipes" })).toContainText("Found on each tablet here in DYE2's Select Recipe page.");
  await expect(rows(page.getByRole("table", { name: "Recipe Slots" }))).toHaveText([/^2Slots Ethiopia/]);

  // Archived and restored, it stays in no slot.
  await page.getByRole("link", { name: "Slots Brazil" }).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("heading", { name: "Slots Brazil", level: 1 })).toContainText("Archived");
  await expect(page.getByRole("button", { name: "Move to a slot" })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("In no slot at Slots lab")).toBeVisible();
  await page.getByRole("button", { name: "Put in a slot" }).click();
  await move.getByLabel("Move it to").click();
  await page.getByRole("option", { name: "The next free slot (1)" }).click();
  await move.getByRole("button", { name: "Move" }).click();
  await expect(page.getByText("Slot 1 at Slots lab")).toBeVisible();
});

test("with every slot holding a Recipe, a new Recipe's next free slot says so and is none, and a move offers only a slot chosen", async ({ page }) => {
  const lab = await createLocation(page, "Full lab");
  for (const slot of [1, 2, 3, 4, 5]) await createRecipe(page, lab, slot, { name: `Full ${slot}` });
  const kept = await createRecipe(page, lab, null, { name: "Full kept" });

  await page.goto(`/locations/${lab.id}`);
  await page.getByRole("region", { name: "Recipes" }).getByRole("button", { name: "New Recipe" }).click();
  const form = page.getByRole("form", { name: "New Recipe" });
  await form.getByLabel("Recipe Slot").click();
  await page.getByRole("option", { name: "The next free slot (none: every slot holds a Recipe)" }).click();
  await expect(form.getByRole("list", { name: "About this slot" })).toHaveText("Every slot here holds a Recipe, so it is kept here in no slot.");

  await page.goto(`/library/recipes/${kept.id}`);
  await page.getByRole("button", { name: "Put in a slot" }).click();
  await page.getByRole("form", { name: "Move the Recipe" }).getByLabel("Move it to").click();
  await expect(page.getByRole("option")).toHaveText(["A slot of my choosing"]);
});

test("a Recipe whose Bean Batch is finished at its Location is flagged", async ({ page }) => {
  const lab = await createLocation(page, "Finished lab");
  const batch = await createBatch(page, "Finished Kenya", lab);
  const recipe = await createRecipe(page, lab, 1, { name: "Finished Kenya Espresso", beanBatchId: batch.id });
  baseExpect((await page.request.put(`/api/bean-batches/${batch.id}/locations/${lab.id}`, { data: { atLocation: false } })).status()).toBe(200);

  await page.goto(`/locations/${lab.id}`);
  await expect(rows(page.getByRole("table", { name: "Recipe Slots" })).filter({ hasText: "Finished Kenya Espresso" })).toContainText("Batch finished here");
  await page.getByRole("link", { name: "Finished Kenya Espresso" }).click();
  await expect(page.getByRole("heading", { name: "Finished Kenya Espresso", level: 1 })).toContainText("Batch finished here");
  await expect(page.getByText("Its Bean Batch, Finished Kenya, roasted 2026-10-01, is no longer at Finished lab: pick the next roast.")).toBeVisible();
  void recipe;
});

test("a Conflict over a Recipe's name, saved on two tablets offline, is shown on its page, and using its value makes it current on every tablet", async ({ page }) => {
  const lab = await createLocation(page, "Conflict lab");
  const one = await tabletAt(page, "Conflict lab 1", lab, "45521");
  const two = await tabletAt(page, "Conflict lab 2", lab, "45522");
  const recipe = await createRecipe(page, lab, 1, { name: "House Espresso" });
  for (const tablet of [one, two]) await expect.poll(() => slotOn(tablet, 1)?.name).toBe("House Espresso");

  // Both offline, each tablet's DYE2 editor saves a name of its own: the later wins on reconnecting, the earlier is kept as a Conflict.
  one.loseNetwork();
  two.loseNetwork();
  await saveName(one, 1, "House Espresso (Brazil)");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await saveName(two, 1, "House Espresso (Kenya)");
  one.restoreNetwork();
  await expect.poll(async () => (await view(page, recipe.id)).name).toBe("House Espresso (Brazil)");
  two.restoreNetwork();
  for (const tablet of [one, two]) await expect.poll(() => slotOn(tablet, 1)?.name).toBe("House Espresso (Kenya)");
  await expect.poll(async () => ((await (await page.request.get(`/api/recipes/${recipe.id}/conflicts`)).json()) as { conflicts: unknown[] }).conflicts.length).toBe(1);

  await page.goto(`/library/recipes/${recipe.id}`);
  const open = page.getByRole("region", { name: "Open Conflicts" });
  const conflict = rows(open.getByRole("table", { name: "Conflicts" }));
  await expect(conflict).toHaveCount(1);
  await expect(conflict.getByRole("cell").nth(0)).toHaveText("Name");
  await expect(conflict.getByRole("cell").nth(1)).toContainText("House Espresso (Brazil)");
  await expect(conflict.getByRole("cell").nth(1)).toContainText("Conflict lab 1");
  await expect(conflict.getByRole("cell").nth(2)).toContainText("House Espresso (Kenya)");

  await open.getByRole("button", { name: "Use the losing value of Name" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Use this value" }).click();
  await expect(open).toBeHidden();
  await expect(page.getByRole("heading", { name: "House Espresso (Brazil)", level: 1 })).toBeVisible();
  for (const tablet of [one, two]) await expect.poll(() => slotOn(tablet, 1)?.name).toBe("House Espresso (Brazil)");
});

test("the form keeps a Tool Archived since as one to uncheck, beside a new one, and offers no batch of an Archived Bean", async ({ page }) => {
  const lab = await createLocation(page, "Form lab");
  const tool = async (name: string) => {
    const response = await page.request.post("/api/tools", { data: { locationId: lab.id, content: { name } } });
    baseExpect(response.status()).toBe(201);
    return ((await response.json()) as { tool: { id: string } }).tool;
  };
  const old = await tool("Form Old WDT");
  await tool("Form New WDT");
  const recipe = await createRecipe(page, lab, 1, { name: "Form Espresso", toolIds: [old.id] });
  baseExpect((await page.request.put(`/api/tools/${old.id}/archived`, { data: { archived: true } })).status()).toBe(200);
  const archivedBatch = await createBatch(page, "Form Retired", lab);
  const { batch: retired } = (await (await page.request.get(`/api/bean-batches/${archivedBatch.id}`)).json()) as { batch: { bean: { id: string } } };
  baseExpect((await page.request.put(`/api/beans/${retired.bean.id}/archived`, { data: { archived: true } })).status()).toBe(200);

  await page.goto(`/library/recipes/${recipe.id}`);
  await page.getByRole("button", { name: "Edit the Recipe" }).click();
  const form = page.getByRole("form", { name: "Edit Form Espresso" });
  await form.getByLabel("Bean Batch").click();
  await expect(page.getByRole("option", { name: /Form Retired/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // A new Tool joins the Archived one, which is kept; saved, the Recipe uses both.
  await form.getByLabel("Form New WDT").check();
  await form.getByRole("button", { name: "Save" }).click();
  const details = page.getByLabel("Recipe", { exact: true });
  await expect(field(details, "Tools")).toContainText("Form New WDT");
  await expect(field(details, "Tools")).toContainText("Form Old WDT");
  // Unchecked, the Archived Tool is dropped, and cannot be checked again.
  await page.getByRole("button", { name: "Edit the Recipe" }).click();
  const kept = form.getByRole("checkbox", { name: /Form Old WDT/ });
  await kept.uncheck();
  await expect(kept).toBeDisabled();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(field(details, "Tools")).not.toContainText("Form Old WDT");
  await expect(field(details, "Tools")).toContainText("Form New WDT");
});

test("the form clears a Recipe's Bean saved on a tablet with no batch of it at its Location", async ({ page }) => {
  const lab = await createLocation(page, "Bean-only lab");
  const tablet = await tabletAt(page, "Bean-only lab 1", lab, "45531");
  const recipe = await createRecipe(page, lab, 1, { name: "Bean-only Espresso" });
  await expect.poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(recipe.id);
  // A Bean added on the tablet, with no batch anywhere, picked in DYE2's editor for the recipe in slot 1.
  const bean = await tablet.addBean({ roaster: "Roux", name: "Bean-only Sidamo" });
  // Picked once the Bean has joined the Library, as a recipe naming a bean the server has not taken in yet names none.
  await expect
    .poll(async () => ((await (await page.request.get("/api/beans")).json()) as { beans: { name: string | null }[] }).beans.some((listed) => listed.name === "Bean-only Sidamo"))
    .toBe(true);
  const list = (dye2List(tablet, "recipes") as Record_[]).map((record) => (record[RECIPE_SLOT_FIELD] === 1 ? { ...record, beanId: bean.id } : record));
  baseExpect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, list)).status).toBe(200);
  await expect.poll(async () => ((await (await page.request.get(`/api/recipes/${recipe.id}`)).json()) as { recipe: { uses: { bean: { name: string } | null } } }).recipe.uses.bean?.name).toBe(
    "Bean-only Sidamo",
  );

  await page.goto(`/library/recipes/${recipe.id}`);
  const details = page.getByLabel("Recipe", { exact: true });
  await expect(field(details, "Bean Batch")).toHaveText("Bean-only Sidamo, no batch");
  await page.getByRole("button", { name: "Edit the Recipe" }).click();
  const form = page.getByRole("form", { name: "Edit Bean-only Espresso" });
  await expect(form.getByLabel("Bean Batch")).toHaveText("Bean-only Sidamo, no batch");
  await form.getByLabel("Bean Batch").click();
  await page.getByRole("option", { name: "None", exact: true }).click();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(field(details, "Bean Batch")).toHaveText("-");
  await expect.poll(() => slotOn(tablet, 1)?.beanId ?? null).toBeNull();
});

test("a Recipe's page shows its steam, hot water and flush settings, each it holds none of as the Machine's own, and the form sets and clears them", async ({ page }) => {
  const lab = await createLocation(page, "Settings lab");
  const recipe = await createRecipe(page, lab, 1, { name: "Settings Cappuccino", steamTemperature: 150, steamStopTemperature: 0, hotWaterVolume: 200 });

  await page.goto(`/library/recipes/${recipe.id}`);
  const steam = page.getByLabel("Steam", { exact: true });
  const hotWater = page.getByLabel("Hot water", { exact: true });
  const flush = page.getByLabel("Flush", { exact: true });
  const shown = async (scope: typeof steam, expected: Record<string, string>) => {
    for (const [term, text] of Object.entries(expected)) await expect(field(scope, term), term).toHaveText(text);
  };
  await shown(steam, { "Steam temperature": "150 °C", "Steam time": "Machine's own", "Steam flow": "Machine's own", "Milk stop": "Off" });
  await shown(hotWater, { "Hot water temperature": "Machine's own", "Hot water time": "Machine's own", "Hot water volume": "200 ml", "Hot water flow": "Machine's own" });
  await shown(flush, { "Flush temperature": "Machine's own", "Flush time": "Machine's own", "Flush flow": "Machine's own" });
  // DYE2's hot water mode is only what its stepper shows: not shown or edited here.
  await expect(page.getByLabel("Recipe", { exact: true }).locator("dt", { hasText: /^Hot water by$/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Edit the Recipe" }).click();
  const form = page.getByRole("form", { name: "Edit Settings Cappuccino" });
  await expect(form.getByLabel("Hot water by")).toHaveCount(0);
  await expect(form.getByLabel("Steam temperature (°C)")).toHaveValue("150");
  await expect(form.getByLabel("Flush time (s)")).toHaveAttribute("placeholder", "Machine's own");
  // An empty input clears a setting; one outside DYE2's range is refused by the server, saying why, and nothing is saved.
  await form.getByLabel("Steam temperature (°C)").fill("");
  await form.getByLabel("Steam time (s)").fill("0");
  await form.getByLabel("Hot water time (s)").fill("3");
  await form.getByLabel("Flush time (s)").fill("10");
  await form.getByLabel("Flush flow (ml/s)").fill("4.5");
  await form.getByRole("button", { name: "Save" }).click();
  // Shown above the form, scrolled into view.
  await expect(form.getByText("hotWaterDuration must be a whole number from 5 to 120")).toBeInViewport();
  await form.getByLabel("Hot water time (s)").fill("30");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();

  await shown(steam, { "Steam temperature": "Machine's own", "Steam time": "0 s", "Milk stop": "Off" });
  await shown(hotWater, { "Hot water time": "30 s", "Hot water volume": "200 ml" });
  await shown(flush, { "Flush temperature": "Machine's own", "Flush time": "10 s", "Flush flow": "4.5 ml/s" });
  const { recipe: saved } = (await (await page.request.get(`/api/recipes/${recipe.id}`)).json()) as { recipe: { content: Record_ } };
  baseExpect(saved.content).not.toHaveProperty("steamTemperature");
  baseExpect(saved.content).toMatchObject({ steamDuration: 0, steamStopTemperature: 0, hotWaterDuration: 30, flushDuration: 10, flushFlow: 4.5, hotWaterMode: "vol" });
});

test("an Admin copies a lab Recipe to Uptown's slot 1 with an Uptown Grinder: the Recipe there leaves its slot, and the copy's history names the original", async ({
  page,
}) => {
  const lab = await createLocation(page, "Copy lab");
  const uptown = await createLocation(page, "Copy Uptown");
  const labTablet = await tabletAt(page, "Copy lab 1", lab, "45541");
  // The lab's batch, Grinder, Profile and Basket; Uptown has two Grinders, one of the lab's model.
  const batch = await createBatch(page, "Copy Guji", lab);
  const labGrinder = await createGrinder(page, lab, "Copy EK43");
  await createGrinder(page, uptown, "Copy EK43");
  await createGrinder(page, uptown, "Copy Mazzer");
  const profile = await labTablet.addProfile(derivedProfile("Copy Bloom", 7.75));
  const profileId = String(profile.id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(profileId)}`)).status()).toBe(200);
  const basketResponse = await page.request.post("/api/baskets", { data: { locationId: lab.id, content: { name: "Copy 20g" } } });
  baseExpect(basketResponse.status()).toBe(201);
  const basket = ((await basketResponse.json()) as { basket: { id: string } }).basket;
  const original = await createRecipe(page, lab, 1, {
    name: "Copy Lab Guji",
    beanBatchId: batch.id,
    profileId,
    dose: 18,
    yield: 40,
    grinderId: labGrinder.id,
    grindSetting: 2.5,
    basketId: basket.id,
    hotWaterTemperature: 85,
  });
  await createRecipe(page, uptown, 1, { name: "Copy Uptown House" });
  const originalBefore = await (await page.request.get(`/api/recipes/${original.id}`)).json();

  await page.goto(`/library/recipes/${original.id}`);
  await page.getByRole("button", { name: "Copy to a Location" }).click();
  const form = page.getByRole("form", { name: "Copy the Recipe" });
  await form.getByLabel("Copy to").click();
  await page.getByRole("option", { name: "Copy Uptown" }).click();
  // The Grinder of the Recipe's model at Uptown is offered first; the Mazzer is chosen instead.
  await expect(form.getByLabel("Grinder")).toHaveText("Copy EK43");
  await expect(form).toContainText("Its grind setting, 2.5, is kept as a starting point.");
  await form.getByLabel("Grinder").click();
  await page.getByRole("option", { name: "Copy Mazzer" }).click();
  await form.getByLabel("Recipe Slot").click();
  await page.getByRole("option", { name: "A slot of my choosing" }).click();
  await form.getByLabel("Slot", { exact: true }).click();
  await page.getByRole("option", { name: "1", exact: true }).click();
  await expect(form.getByRole("list", { name: "About this slot" })).toContainText("Slot 1 holds Copy Uptown House, which is taken out of its slot and kept at Copy Uptown.");
  await expect(form.getByLabel("Bean Batch")).toHaveText("Copy Guji, roasted 2026-10-01 (this Recipe's)");
  // The form says what copying adds and shows at Uptown before saving.
  const also = form.getByRole("status", { name: "Copying also" });
  await expect(also).toContainText("adds the Bean Batch Copy Guji, roasted 2026-10-01 at Copy Uptown");
  await expect(also).toContainText("shows the Profile Copy Bloom at Copy Uptown");
  await expect(also).toContainText("shows the Basket Copy 20g at Copy Uptown");
  await form.getByRole("button", { name: "Copy" }).click();

  // The copy's page: in slot 1 at Uptown, with the Mazzer, its history naming the original.
  await expect(page.getByText("Slot 1 at Copy Uptown")).toBeVisible();
  const copyId = page.url().split("/").pop()!;
  baseExpect(copyId).not.toBe(original.id);
  const details = page.getByLabel("Recipe", { exact: true });
  await expect(field(details, "Grinder")).toHaveText("Copy Mazzer");
  await expect(field(details, "Grind setting")).toHaveText("2.5");
  await expect(field(details, "Bean Batch")).toHaveText("Copy Guji, roasted 2026-10-01");
  const history = rows(page.getByRole("table", { name: "History" }));
  await expect(history.last()).toContainText("Copied from Copy Lab Guji at Copy lab");
  await expect(history.last().getByRole("link", { name: "Copy Lab Guji" })).toHaveAttribute("href", `/library/recipes/${original.id}`);

  // The Recipe that was in slot 1 is kept at Uptown in no slot; the original is unchanged, still in the lab's slot 1.
  await page.getByRole("link", { name: "← Copy Uptown" }).click();
  await expect(rows(page.getByRole("table", { name: "Recipes in no slot" }))).toHaveText([/Copy Uptown House/]);
  await expect(rows(page.getByRole("table", { name: "Recipe Slots" }))).toHaveText([/^1Copy Lab Guji/]);
  baseExpect(await (await page.request.get(`/api/recipes/${original.id}`)).json()).toEqual(originalBefore);
});

test("Staff copy a Recipe only to the Locations they work at", async ({ page, browser }) => {
  const home = await createLocation(page, "Copy Staff home");
  const elsewhere = await createLocation(page, "Copy Staff elsewhere");
  const recipe = await createRecipe(page, elsewhere, 1, { name: "Copy Elsewhere Espresso" });
  const sam = await staffAt(page, browser, "sam.copies@example.com", home);
  try {
    const samsPage = await sam.newPage();
    await samsPage.goto(`/library/recipes/${recipe.id}`);
    await expect(samsPage.getByText("Only Admins, and Staff working at Copy Staff elsewhere, change its Recipes.")).toBeVisible();
    // Sam may copy it, but only to the Location Sam works at.
    await samsPage.getByRole("button", { name: "Copy to a Location" }).click();
    const form = samsPage.getByRole("form", { name: "Copy the Recipe" });
    await form.getByLabel("Copy to").click();
    await expect(samsPage.getByRole("option")).toHaveText(["Copy Staff home"]);
  } finally {
    await sam.close();
  }
});

/** A batch, roasted on 2026-10-01, of a Bean of that name, at the Location. */
async function createBatch(page: Page, name: string, at: { id: string }): Promise<{ id: string }> {
  const bean = await page.request.post("/api/beans", { data: { content: { roaster: "Roux", name } } });
  baseExpect(bean.status()).toBe(201);
  const { id: beanId } = ((await bean.json()) as { bean: { id: string } }).bean;
  const batch = await page.request.post("/api/bean-batches", { data: { beanId, content: { roastDate: "2026-10-01" }, locations: [{ locationId: at.id }] } });
  baseExpect(batch.status()).toBe(201);
  return ((await batch.json()) as { batch: { id: string } }).batch;
}

async function createGrinder(page: Page, at: { id: string }, model: string): Promise<{ id: string }> {
  const response = await page.request.post("/api/grinders", { data: { locationId: at.id, content: { model } } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { grinder: { id: string } }).grinder;
}

async function createRecipe(page: Page, at: { id: string }, slot: number | null, content: Record_): Promise<{ id: string }> {
  const response = await page.request.post("/api/recipes", { data: { locationId: at.id, slot, content } });
  baseExpect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { recipe: { id: string } }).recipe;
}

/** A Machine at the Location, its tablet connected with DYE2's lists empty, polling every 5 s of its time, which runs 50 times faster here. */
async function tabletAt(page: Page, name: string, location: { id: string }, serial: string): Promise<SimulatedTablet> {
  const response = await page.request.post("/api/machines", { data: { name, locationId: location.id } });
  baseExpect(response.status()).toBe(201);
  const { token } = (await response.json()) as { token: string };
  const tablet = SimulatedTablet.load({
    settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 },
    api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS },
    timeScale: 50,
  });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}

/** A browser signed in as Staff at the Location, invited by the Admin. */
async function staffAt(page: Page, browser: import("@playwright/test").Browser, email: string, location: { id: string }) {
  const response = await page.request.post("/api/invites", { data: { email, role: "staff", locationIds: [location.id] } });
  baseExpect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const context = await browser.newContext({ baseURL: server.url() });
  const accepted = await context.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, {
    data: { name: "Sam Staff", email, password: "staff password 1" },
  });
  baseExpect(accepted.status()).toBe(201);
  return context;
}

/** The tablet's recipe in a slot, by its `stripSlot`, if it holds one there. */
function slotOn(tablet: SimulatedTablet, slot: number): Record_ | undefined {
  const list = dye2List(tablet, "recipes");
  return Array.isArray(list) ? (list as Record_[]).find((record) => record[RECIPE_SLOT_FIELD] === slot) : undefined;
}

/** Saves the recipe's name in a slot on the tablet as DYE2's editor does: reads the list, changes the record, posts the list back. */
async function saveName(tablet: SimulatedTablet, slot: number, name: string): Promise<void> {
  const list = (dye2List(tablet, "recipes") as Record_[]).map((record) => (record[RECIPE_SLOT_FIELD] === slot ? { ...record, name } : record));
  baseExpect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, list)).status).toBe(200);
}

async function view(page: Page, id: string): Promise<{ name: string | null }> {
  return ((await (await page.request.get(`/api/recipes/${id}`)).json()) as { recipe: { name: string | null } }).recipe;
}
