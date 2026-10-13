import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import { GLOBAL_ID_KEY } from "@decent-sync/protocol";
import { DYE2_NAMESPACE, dye2List } from "../server/test/support/simulated-dye2.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, derivedProfile, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// Recipes in the management interface (ticket #143): each Location's Recipe
// Slots and its Recipes in no slot, a Recipe created and edited with the
// Recipe form, moved between slots, taken out of its slot, Archived and
// restored, which reaches the DYE2 recipes of the simulated tablets running
// the built plugin there; what the form offers at the Location; a Recipe
// whose batch is finished there flagged; its Conflicts; and what Staff may
// change. Serials are made up, from 45501.
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

test("Staff create a Recipe in slot 6 at their Location with a batch from elsewhere and a hidden Profile, edit it, and can't change another Location's", async ({
  page,
  browser,
}) => {
  const lab = await createLocation(page, "Roastery lab");
  const cafe = await createLocation(page, "Uptown");
  const labTablets = [await tabletAt(page, "Lab 1", lab, "45501"), await tabletAt(page, "Lab 2", lab, "45502")];
  const cafeTablet = await tabletAt(page, "Uptown 1", cafe, "45503");
  // A batch at the cafe only, and a Profile saved on the cafe's tablet, shown there only.
  const batch = await createBatch(page, "Guji", cafe);
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
    await form.getByLabel("Slot", { exact: true }).fill("6");
    // The form says what saving offers at the lab, and that slot 6 isn't editable in DYE2's recipe editor.
    await expect(form.getByRole("list", { name: "About this slot" })).toContainText("Slot 6 is not editable in DYE2's recipe editor");
    const also = form.getByRole("status", { name: "Saving also" });
    await expect(also).toContainText("adds the Bean Batch Guji, roasted 2026-10-01 at Roastery lab");
    await expect(also).toContainText("shows the Profile Uptown Bloom at Roastery lab");
    await form.getByRole("button", { name: "Create" }).click();

    await expect(samsPage.getByRole("heading", { name: "Lab Guji", level: 1 })).toContainText("Not editable in DYE2's recipe editor");
    await expect(samsPage.getByText("Slot 6 at Roastery lab")).toBeVisible();
    const id = samsPage.url().split("/").pop()!;
    const details = samsPage.getByLabel("Recipe", { exact: true });
    await expect(field(details, "Profile")).toHaveText("Uptown Bloom");
    await expect(field(details, "Bean Batch")).toHaveText("Guji, roasted 2026-10-01");
    for (const tablet of labTablets) await expect.poll(() => slotOn(tablet, 6)?.[GLOBAL_ID_KEY]).toBe(id);
    expect(slotOn(labTablets[0]!, 6)).toMatchObject({ name: "Lab Guji", profileId, dashboardVariables: { dose: 18, drink: 40 } });
    expect(slotOn(cafeTablet, 6)).toBeUndefined();
    // As the form said, the batch is at the lab now, and the Profile shown there.
    const batchNow = (await (await page.request.get(`/api/bean-batches/${batch.id}`)).json()) as { batch: { locations: { location: { id: string } }[] } };
    baseExpect(batchNow.batch.locations.map((here) => here.location.id)).toContain(lab.id);
    const profileNow = (await (await page.request.get(`/api/profiles/${encodeURIComponent(profileId)}`)).json()) as { profile: { shownAt: { location: { id: string } }[] } };
    baseExpect(profileNow.profile.shownAt.map((here) => here.location.id)).toContain(lab.id);

    await samsPage.getByRole("button", { name: "Edit the Recipe" }).click();
    const edit = samsPage.getByRole("form", { name: "Edit Lab Guji" });
    await edit.getByLabel("Dose (g)").fill("18.5");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(field(details, "Dose")).toHaveText("18.5 g");
    for (const tablet of labTablets) await expect.poll(() => (slotOn(tablet, 6)?.dashboardVariables as Record_ | undefined)?.dose).toBe(18.5);

    // The lab's page lists it in slot 6, marked.
    await samsPage.getByRole("link", { name: "← Roastery lab" }).click();
    const slot6 = rows(samsPage.getByRole("table", { name: "Recipe Slots" })).filter({ hasText: "Lab Guji" });
    await expect(slot6.getByRole("cell").first()).toHaveText("6");
    await expect(slot6).toContainText("Not editable in DYE2's recipe editor");
    await expect(slot6).toContainText("18.5 g → 40 g");

    // At the cafe, where Sam does not work, nothing can be changed.
    await samsPage.goto(`/library/recipes/${elsewhere.id}`);
    await expect(samsPage.getByRole("heading", { name: "Uptown Espresso", level: 1 })).toBeVisible();
    await expect(samsPage.getByText("Only Admins, and Staff working at Uptown, change its Recipes.")).toBeVisible();
    await expect(samsPage.getByRole("button", { name: "Edit the Recipe" })).toHaveCount(0);
    await expect(samsPage.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
    await samsPage.goto(`/locations/${cafe.id}`);
    await expect(samsPage.getByRole("table", { name: "Recipe Slots" })).toContainText("Uptown Espresso");
    await expect(samsPage.getByRole("button", { name: "New Recipe" })).toHaveCount(0);
    baseExpect((await samsPage.request.patch(`/api/recipes/${elsewhere.id}`, { data: { content: { dose: 20 } } })).status()).toBe(403);
    baseExpect((await samsPage.request.put(`/api/recipes/${elsewhere.id}/slot`, { data: { slot: 2 } })).status()).toBe(403);
  } finally {
    await sam.close();
  }
});

test("moving a Recipe from slot 2 to slot 4 swaps the two on the tablets, keeping its history, and one taken out of its slot is kept, Archived and restored", async ({
  page,
}) => {
  const lab = await createLocation(page, "Slots lab");
  const tablet = await tabletAt(page, "Slots lab 1", lab, "45511");
  const two = await createRecipe(page, lab, 2, { name: "Slots Brazil", dose: 18 });
  const four = await createRecipe(page, lab, 4, { name: "Slots Ethiopia", dose: 17 });
  await expect.poll(() => slotsOn(tablet)).toEqual(["2:Slots Brazil", "4:Slots Ethiopia"]);

  await page.goto(`/library/recipes/${two.id}`);
  await expect(page.getByText("Slot 2 at Slots lab")).toBeVisible();
  await page.getByRole("button", { name: "Move to a slot" }).click();
  const move = page.getByRole("form", { name: "Move the Recipe" });
  await move.getByLabel("Slot", { exact: true }).fill("4");
  await expect(move.getByRole("list", { name: "About this slot" })).toContainText("Slot 4 holds Slots Ethiopia, which moves to slot 2.");
  await move.getByRole("button", { name: "Move" }).click();
  await expect(page.getByText("Slot 4 at Slots lab")).toBeVisible();
  await expect.poll(() => slotsOn(tablet)).toEqual(["2:Slots Ethiopia", "4:Slots Brazil"]);
  baseExpect(slotOn(tablet, 4)![GLOBAL_ID_KEY]).toBe(two.id);
  // The moved Recipe keeps its history: the move above its creation.
  const history = rows(page.getByRole("table", { name: "History" }));
  await expect(history.nth(0)).toContainText("Slot at Slots lab4");
  await expect(history.last()).toContainText("NameSlots Brazil");

  // Taken out of its slot, it is listed in no slot at the lab, and the slot is emptied on the tablet.
  await page.getByRole("button", { name: "Take out of its slot" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Take it out" }).click();
  await expect(page.getByText("In no slot at Slots lab")).toBeVisible();
  await expect.poll(() => slotsOn(tablet)).toEqual(["2:Slots Ethiopia"]);
  await page.getByRole("link", { name: "← Slots lab" }).click();
  await expect(rows(page.getByRole("table", { name: "Recipes in no slot" }))).toHaveText([/Slots Brazil/]);
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
  await expect.poll(() => slotsOn(tablet)).toEqual(["1:Slots Brazil", "2:Slots Ethiopia"]);
  void four;
});

test("a slotted Recipe whose Bean Batch is finished at its Location is flagged", async ({ page }) => {
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
  await saveName(one, "1", "House Espresso (Brazil)");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await saveName(two, "1", "House Espresso (Kenya)");
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

async function createLocation(page: Page, name: string): Promise<{ id: string; name: string }> {
  const response = await page.request.post("/api/locations", { data: { name, timeZone: "America/Chicago" } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string; name: string } }).location;
}

/** A batch, roasted on 2026-10-01, of a Bean of that name, at the Location. */
async function createBatch(page: Page, name: string, at: { id: string }): Promise<{ id: string }> {
  const bean = await page.request.post("/api/beans", { data: { content: { roaster: "Roux", name } } });
  baseExpect(bean.status()).toBe(201);
  const { id: beanId } = ((await bean.json()) as { bean: { id: string } }).bean;
  const batch = await page.request.post("/api/bean-batches", { data: { beanId, content: { roastDate: "2026-10-01" }, locations: [{ locationId: at.id }] } });
  baseExpect(batch.status()).toBe(201);
  return ((await batch.json()) as { batch: { id: string } }).batch;
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

/** The tablet's recipe in a slot, if it holds one there. */
function slotOn(tablet: SimulatedTablet, slot: number): Record_ | undefined {
  const list = dye2List(tablet, "recipes");
  return Array.isArray(list) ? (list as Record_[]).find((record) => record.id === String(slot)) : undefined;
}

/** The tablet's recipes, each as its slot and name, in its list's order. */
function slotsOn(tablet: SimulatedTablet): string[] {
  const list = dye2List(tablet, "recipes");
  return Array.isArray(list) ? (list as Record_[]).map((record) => `${String(record.id)}:${String(record.name)}`) : [];
}

/** Saves the recipe's name in a slot on the tablet as DYE2's editor does: reads the list, changes the record, posts the list back. */
async function saveName(tablet: SimulatedTablet, slot: string, name: string): Promise<void> {
  const list = (dye2List(tablet, "recipes") as Record_[]).map((record) => (record.id === slot ? { ...record, name } : record));
  baseExpect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, list)).status).toBe(200);
}

async function view(page: Page, id: string): Promise<{ name: string | null }> {
  return ((await (await page.request.get(`/api/recipes/${id}`)).json()) as { recipe: { name: string | null } }).recipe;
}

/** A table's rows below its header. */
function rows(table: Locator) {
  return table.getByRole("row").filter({ hasNot: table.page().getByRole("columnheader") });
}

function field(within: Locator, term: string) {
  return within.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}
