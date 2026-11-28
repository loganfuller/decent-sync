import { expect, type Locator, type Page, test } from "@playwright/test";
import { roastDay } from "./support/days.js";
import { useFreshServer } from "./support/fresh-server.js";
import { boxes, expectFits, textContrast } from "./support/layout.js";
import { expectOptions, field, openCard, recipeAction, rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";

// A Bean Batch named one way wherever the management interface mentions one
// (ticket #732): by its Bean and its Batch Code, with its roast date, a day,
// wherever there is a second line or a sentence, and in the code's place on
// a batch that has none. Here: the Recipes lists, a Recipe's card, form,
// copy dialog, finished strip and History, and a Bean's page, each with a
// batch that has a Batch Code, one that has none and one with no roast date,
// as the previous release's server answers them (ADR-0025), in the dark
// theme and at a phone's width. The Shots list, its filter and a Shot's page
// are in shot-links, a Machine's Workflow card and Activity in
// machine-activity, and the batch's own pages and dialogs in batch-pages,
// batch-lists, batch-codes, batch-moves and remaining-weight. Everything is
// made through the REST API, on no tablet.
useFreshServer();

type Record_ = Record<string, unknown>;
type Place = Awaited<ReturnType<typeof createLocation>>;

test.beforeEach(({ page }) => signInAsAdmin(page));

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as T;
}

async function put(page: Page, path: string, data: unknown): Promise<void> {
  const response = await page.request.put(path, { data });
  expect(response.status(), await response.text()).toBe(200);
}

const bean = async (page: Page, name: string) => (await post<{ bean: { id: string } }>(page, "/api/beans", { content: { roaster: "Lantern Coffee Roasters", name } })).bean.id;

/** A batch of the Bean, created at the Location with the weight, or untracked with none given. */
const batch = async (page: Page, beanId: string, at: Place, content: Record_, remainingWeight?: number) =>
  (await post<{ batch: { id: string } }>(page, "/api/bean-batches", { beanId, content, locations: [{ locationId: at.id, ...(remainingWeight !== undefined && { remainingWeight }) }] })).batch.id;

const recipe = async (page: Page, at: Place, slot: number | null, content: Record_) =>
  (await post<{ recipe: { id: string } }>(page, "/api/recipes", { locationId: at.id, slot, content: { dose: 20, yield: 44, ...content } })).recipe.id;

/** A batch's page. */
const batchPage = (id: string) => `/library/bean-batches/${id}`;

/** The chip, or plain monospace text, a Batch Code is set apart in. */
const code = (within: Locator, batchCode: string) => within.getByLabel(`Batch Code ${batchCode}`, { exact: true });

/** What the tests of the Recipes share, made by the first of them. */
let seeded: { downtown: Place; riverside: Place; house: string; coded: string; plain: string; undated: string; finished: string; elsewhere: string; recipes: Record<"coded" | "plain" | "undated" | "finished" | "guest", string> } | undefined;

/**
 * Downtown's Recipes: one for each kind of batch of House Espresso, with a
 * Batch Code, with none, with a code and no roast date, and one finished at
 * Downtown; and the Guest, Archived, which names a Bean with no batch. One
 * more batch of House Espresso is at Riverside alone.
 */
async function seed(page: Page) {
  if (seeded) return seeded;
  const downtown = await createLocation(page, "Downtown");
  const riverside = await createLocation(page, "Riverside");
  const house = await bean(page, "House Espresso");
  const kenya = await bean(page, "Kenya Nyeri AA");
  const coded = await batch(page, house, downtown, { roastDate: "2026-11-17", batchCode: "LR-0411" }, 3240);
  const plain = await batch(page, house, downtown, { roastDate: "2026-11-10" });
  const undated = await batch(page, house, downtown, { batchCode: "LR-0398" });
  const finished = await batch(page, house, downtown, { roastDate: "2026-11-03", batchCode: "LR-0405" });
  const elsewhere = await batch(page, house, riverside, { roastDate: "2026-11-20", batchCode: "LR-0420" });
  const recipes = {
    coded: await recipe(page, downtown, 1, { name: "House", beanBatchId: coded }),
    plain: await recipe(page, downtown, 2, { name: "House Plain", beanBatchId: plain }),
    undated: await recipe(page, downtown, 3, { name: "House Undated", beanBatchId: undated }),
    finished: await recipe(page, downtown, 4, { name: "House Ristretto", beanBatchId: finished }),
    guest: await recipe(page, downtown, null, { name: "Guest Kenya", beanId: kenya }),
  };
  await put(page, `/api/bean-batches/${finished}/locations/${downtown.id}`, { atLocation: false });
  await put(page, `/api/recipes/${recipes.guest}/archived`, { archived: true });
  seeded = { downtown, riverside, house, coded, plain, undated, finished, elsewhere, recipes };
  return seeded;
}

test("Recipes lists name each Recipe's batch by its Bean and Batch Code over its roast day, linked, with Batch finished here beside it, and Archived beside a Recipe's name, with no Status column", async ({ page }) => {
  const { downtown, coded, plain, undated, finished } = await seed(page);

  // A Location's Recipes card.
  await page.goto(`/locations/${downtown.id}`);
  const slots = page.getByRole("region", { name: "Recipes" }).getByRole("table", { name: "Recipe Slots" });
  await expect(slots.getByRole("columnheader")).toHaveText(["Slot", "Recipe", "Bean Batch", "Profile", "Dose and yield", "Grinder", "Reference Shot"]);
  const batchCell = (table: Locator, name: string) => rows(table).filter({ has: page.getByRole("link", { name, exact: true }) }).getByRole("cell").nth(2);
  // With a Batch Code: its Bean, the link to the batch, and its code in a chip, over the day it was roasted.
  await expect(batchCell(slots, "House")).toHaveText(`House EspressoLR-0411Roasted ${roastDay("2026-11-17")}`);
  await expect(batchCell(slots, "House").getByRole("link", { name: `House Espresso LR-0411, roasted ${roastDay("2026-11-17")}`, exact: true })).toHaveAttribute("href", batchPage(coded));
  await expect(code(batchCell(slots, "House"), "LR-0411")).toHaveText("LR-0411");
  await expect(code(batchCell(slots, "House"), "LR-0411")).toHaveCSS("font-family", /mono/i);
  // With none: its Bean over its roast day, which stands in for the code.
  await expect(batchCell(slots, "House Plain")).toHaveText(`House EspressoRoasted ${roastDay("2026-11-10")}`);
  await expect(batchCell(slots, "House Plain").getByRole("link")).toHaveAttribute("href", batchPage(plain));
  await expect(batchCell(slots, "House Plain").getByLabel(/^Batch Code/)).toHaveCount(0);
  // With a code and no roast date.
  await expect(batchCell(slots, "House Undated")).toHaveText("House EspressoLR-0398No roast date");
  await expect(batchCell(slots, "House Undated").getByRole("link")).toHaveAttribute("href", batchPage(undated));
  // Finished at Downtown: said beside the batch's name, in its cell, not in a column of its own.
  await expect(batchCell(slots, "House Ristretto")).toHaveText(`House EspressoLR-0405Batch finished hereRoasted ${roastDay("2026-11-03")}`);
  await expect(batchCell(slots, "House Ristretto").getByRole("link")).toHaveAttribute("href", batchPage(finished));
  const [name, badge] = await boxes(batchCell(slots, "House Ristretto").getByRole("link"), batchCell(slots, "House Ristretto").getByText("Batch finished here"));
  expect(Math.abs(name!.y + name!.height / 2 - (badge!.y + badge!.height / 2))).toBeLessThan(6);
  // The badge reads in both themes with the pointer over its row, whose shade on the card is the ground nearest its text.
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveClass(colorScheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    await rows(slots).filter({ has: page.getByRole("link", { name: "House Ristretto", exact: true }) }).hover();
    expect(await textContrast(batchCell(slots, "House Ristretto").getByText("Batch finished here", { exact: true })), `${colorScheme}: the badge on a hovered row`).toBeGreaterThanOrEqual(4.5);
  }
  await page.mouse.move(0, 0);
  await page.emulateMedia({ colorScheme: "light" });
  // No ISO date is left in the list.
  await expect(slots).not.toContainText(/\d{4}-\d\d-\d\d/);

  // The Library's Recipes tab lists them the same way; its Archived Recipe, shown on asking, reads Archived beside its
  // name, and names its Bean, linked, over "No batch".
  await page.goto("/library/recipes?archived=1");
  const atDowntown = page.getByRole("table", { name: "Recipes at Downtown" });
  await expect(atDowntown.getByRole("columnheader")).toHaveText(["Slot", "Recipe", "Bean Batch", "Profile", "Dose and yield", "Grinder", "Reference Shot"]);
  await expect(rows(atDowntown)).toHaveText([
    new RegExp(String.raw`^1HouseHouse EspressoLR-0411Roasted ${roastDay("2026-11-17")}-20 g → 44 g-No reference$`),
    new RegExp(String.raw`^2House PlainHouse EspressoRoasted ${roastDay("2026-11-10")}-`),
    /^3House UndatedHouse EspressoLR-0398No roast date-/,
    new RegExp(String.raw`^4House RistrettoHouse EspressoLR-0405Batch finished hereRoasted ${roastDay("2026-11-03")}-`),
    /^-Guest KenyaArchivedKenya Nyeri AANo batch-20 g → 44 g-No reference$/,
  ]);
  const guest = rows(atDowntown).last();
  await expect(guest.getByRole("link", { name: "Kenya Nyeri AA" })).toHaveAttribute("href", /^\/library\/beans\//);
  const [guestName, archived] = await boxes(guest.getByRole("link", { name: "Guest Kenya" }), guest.getByText("Archived", { exact: true }));
  expect(archived!.x).toBeGreaterThan(guestName!.x + guestName!.width);

  // In the dark theme the code's chip still reads on its ground, and so does the day under it.
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveClass(colorScheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    expect(await textContrast(code(rows(atDowntown).first(), "LR-0411")), `${colorScheme}: the code`).toBeGreaterThanOrEqual(4.5);
    expect(await textContrast(rows(atDowntown).first().getByText(`Roasted ${roastDay("2026-11-17")}`)), `${colorScheme}: the roast day`).toBeGreaterThanOrEqual(4.5);
  }
  await page.emulateMedia({ colorScheme: "light" });

  // At a phone's width the table scrolls in its own box, and nothing is wider than the screen.
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(rows(atDowntown).first()).toBeVisible();
  await expectFits(page, 393);
  await page.goto(`/locations/${downtown.id}`);
  await expect(rows(slots).first()).toBeVisible();
  await expectFits(page, 393);
});

test("a Recipe's card, its finished strip, its form, its copy dialog and its History name a batch by the rule: in a line on its card, and in words wherever it can't be a link", async ({ page }) => {
  const { downtown, coded, finished, recipes } = await seed(page);
  const inWords = {
    coded: `House Espresso LR-0411, roasted ${roastDay("2026-11-17")}`,
    plain: `House Espresso, roasted ${roastDay("2026-11-10")}`,
    undated: "House Espresso LR-0398, no roast date",
    finished: `House Espresso LR-0405, roasted ${roastDay("2026-11-03")}`,
    elsewhere: `House Espresso LR-0420, roasted ${roastDay("2026-11-20")}`,
  };

  // Its card: the batch in a line, its Bean the link, its code in a chip, then its roast date.
  await page.goto(`/library/recipes/${recipes.coded}`);
  const details = page.getByRole("region", { name: "Recipe", exact: true });
  await expect(field(details, "Bean Batch")).toHaveText(`House Espresso LR-0411 roasted ${roastDay("2026-11-17")}`);
  await expect(field(details, "Bean Batch").getByRole("link", { name: `House Espresso LR-0411, roasted ${roastDay("2026-11-17")}`, exact: true })).toHaveAttribute("href", batchPage(coded));
  await expect(code(field(details, "Bean Batch"), "LR-0411")).toBeVisible();
  // One with no code has its roast date in the code's place, and one with no roast date says so.
  await page.goto(`/library/recipes/${recipes.plain}`);
  await expect(field(details, "Bean Batch")).toHaveText(`House Espresso, roasted ${roastDay("2026-11-10")}`);
  await page.goto(`/library/recipes/${recipes.undated}`);
  await expect(field(details, "Bean Batch")).toHaveText("House Espresso LR-0398 no roast date");

  // The strip of a Recipe whose batch is finished at its Location (#733) names the batch as a cell does, its Bean the link, named in words.
  await page.goto(`/library/recipes/${recipes.finished}`);
  const strip = page.getByRole("region", { name: "Bean Batch", exact: true });
  await expect(strip).toContainText("Its Bean Batch is finished at Downtown");
  await expect(strip.getByRole("link", { name: inWords.finished, exact: true })).toHaveAttribute("href", batchPage(finished));
  await expect(code(strip, "LR-0405")).toBeVisible();
  await expect(field(details, "Bean Batch").getByRole("link")).toHaveAttribute("href", batchPage(finished));

  // Its form: the picker (#733) names each option in words, the latest roasted first, with its weight at Downtown, and
  // those elsewhere under a heading that says saving adds them.
  await page.goto(`/library/recipes/${recipes.coded}`);
  await page.getByRole("button", { name: "Edit the Recipe" }).click();
  const form = page.getByRole("form", { name: "Edit House" });
  await expect(form.getByLabel("Bean Batch")).toHaveValue(`${inWords.coded} (this Recipe's batch now)`);
  await form.getByLabel("Bean Batch").click();
  await expectOptions(page.getByRole("group", { name: "At Downtown", exact: true }), [`${inWords.coded}, this Recipe's batch now, 3240 g here`, `${inWords.plain}, Not tracked`, `${inWords.undated}, Not tracked`]);
  // A batch finished at Downtown is one from elsewhere there now, at no Location.
  await expectOptions(page.getByRole("group", { name: "Elsewhere: saving adds it at Downtown" }), [`${inWords.elsewhere}, at Riverside, Not tracked`, `${inWords.finished}, at no Location`]);
  await page.getByRole("option", { name: `${inWords.elsewhere}, at Riverside, Not tracked`, exact: true }).click();
  await expect(form.getByLabel("Bean Batch")).toHaveValue(`${inWords.elsewhere} (at Riverside)`);
  await expect(form.getByRole("status", { name: "Saving also" })).toContainText(`adds the Bean Batch ${inWords.elsewhere} at Downtown`);
  // Saved with the batch that has no code instead, which its History then names in words, with the one it replaced.
  await form.getByLabel("Bean Batch").click();
  await page.getByRole("option", { name: `${inWords.plain}, Not tracked`, exact: true }).click();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(field(details, "Bean Batch")).toHaveText(`House Espresso, roasted ${roastDay("2026-11-10")}`);
  const history = (await openCard(page, "History")).getByRole("table", { name: "History" });
  await expect(rows(history).first()).toContainText(`Bean Batch${inWords.plain}`);
  await expect(rows(history).last()).toContainText(`Bean Batch${inWords.coded}`);
  await expect(history).not.toContainText(/\d{4}-\d\d-\d\d/);

  // Its copy dialog: the Recipe's own batch in words, and what copying adds at the Location.
  await page.goto(`/library/recipes/${recipes.undated}`);
  await recipeAction(page, "Copy to a Location");
  const copy = page.getByRole("form", { name: "Copy the Recipe" });
  await copy.getByLabel("Copy to").click();
  await page.getByRole("option", { name: "Riverside" }).click();
  await expect(copy.getByLabel("Bean Batch")).toHaveValue(`${inWords.undated} (this Recipe's)`);
  await expect(copy.getByRole("status", { name: "Copying also" })).toContainText(`adds the Bean Batch ${inWords.undated} at Riverside`);
  await copy.getByLabel("Bean Batch").click();
  await expectOptions(page.getByRole("group", { name: "At Riverside", exact: true }), [`${inWords.elsewhere}, Not tracked`]);
  // Escape closes the picker's list alone, and the dialog stays.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(copy).toBeVisible();
  void downtown;
});

test("a Bean's page leads with its Batches card: New Batch in its heading, how many are at a Location and what they hold beside its title, and each batch by its roast day, Batch Code, Locations and remaining weight", async ({ page }) => {
  const downtown = seeded?.downtown ?? (await createLocation(page, "Bean Downtown"));
  const riverside = seeded?.riverside ?? (await createLocation(page, "Bean Riverside"));
  const guji = await bean(page, "Ethiopia Guji Natural");
  // At two Locations, each with a weight; at one, with none entered; with no roast date, at no Location now; and Archived.
  const both = await batch(page, guji, downtown, { roastDate: "2026-11-17", batchCode: "LR-0412" }, 3240);
  await put(page, `/api/bean-batches/${both}/locations/${riverside.id}`, { atLocation: true, remainingWeight: 1850 });
  const untracked = await batch(page, guji, downtown, { roastDate: "2026-11-10" });
  const nowhere = await batch(page, guji, downtown, { batchCode: "LR-0399" });
  await put(page, `/api/bean-batches/${nowhere}/locations/${downtown.id}`, { atLocation: false });
  const retired = await batch(page, guji, downtown, { roastDate: "2026-11-03", batchCode: "LR-0390" }, 500);
  await put(page, `/api/bean-batches/${retired}/archived`, { archived: true });

  await page.goto(`/library/beans/${guji}`);
  await expect(page.getByRole("heading", { name: "Ethiopia Guji Natural", level: 1 })).toBeVisible();
  const batches = page.getByRole("region", { name: "Batches", exact: true });
  // The card leads the page, above In the Library and Coffee, with New Batch in its heading; Archive and Delete stay above it.
  const [card, library, coffee, newBatch, archive, title] = await boxes(
    batches,
    page.getByLabel("In the Library", { exact: true }),
    page.getByLabel("Coffee", { exact: true }),
    batches.getByRole("button", { name: "New Batch" }),
    page.getByRole("main").getByRole("button", { name: "Archive", exact: true }),
    batches.getByRole("heading", { name: "Batches", level: 2 }),
  );
  expect(card!.y + card!.height).toBeLessThanOrEqual(Math.min(library!.y, coffee!.y));
  expect(archive!.y + archive!.height).toBeLessThanOrEqual(card!.y);
  expect(Math.abs(newBatch!.y + newBatch!.height / 2 - (title!.y + title!.height / 2))).toBeLessThan(16);
  expect(newBatch!.x).toBeGreaterThan(title!.x + title!.width);
  await expect(page.getByRole("main").getByRole("button", { name: "New Batch" })).toHaveCount(1);
  await expect(page.getByRole("main").getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  // Beside its title: the batches at a Location, and what the Locations that track them hold. The Archived one is counted in neither.
  await expect(batches.getByText("2 at a Location, 5090 g in all")).toBeVisible();

  const table = batches.getByRole("table", { name: "Batches" });
  await expect(table.getByRole("columnheader")).toHaveText(["Roasted", "Batch Code", "At", "Remaining in all"]);
  await expect(table.getByRole("columnheader", { name: "Remaining in all" })).toHaveCSS("text-align", "right");
  const row = (name: string) => rows(table).filter({ has: page.getByRole("link", { name, exact: true }) }).getByRole("cell");
  // Each by the day it was roasted, which is the link to it, named for a screen reader with its code too.
  await expect(row(`LR-0412 roasted ${roastDay("2026-11-17")}`)).toHaveText([roastDay("2026-11-17"), "LR-0412", "Downtown 3240 gRiverside 1850 g", "5090 g"]);
  await expect(table.getByRole("link", { name: `LR-0412 roasted ${roastDay("2026-11-17")}`, exact: true })).toHaveAttribute("href", batchPage(both));
  await expect(row(`Roasted ${roastDay("2026-11-10")}`)).toHaveText([roastDay("2026-11-10"), "-", "Downtown", "Not tracked"]);
  await expect(table.getByRole("link", { name: `Roasted ${roastDay("2026-11-10")}`, exact: true })).toHaveAttribute("href", batchPage(untracked));
  await expect(row("LR-0399 no roast date")).toHaveText(["No roast date", "LR-0399", "At no Location", "-"]);
  await expect(row(`LR-0390 roasted ${roastDay("2026-11-03")}`)).toHaveText([`${roastDay("2026-11-03")}Archived`, "LR-0390", "-", "-"]);
  await expect(row(`LR-0412 roasted ${roastDay("2026-11-17")}`).nth(3)).toHaveCSS("text-align", "right");
  // The Bean is said once, by the page: no row repeats it, and none holds an ISO date.
  await expect(table).not.toContainText("Ethiopia Guji Natural");
  await expect(table).not.toContainText(/\d{4}-\d\d-\d\d/);

  // New Batch, from the card's heading, creates one of this Bean.
  await batches.getByRole("button", { name: "New Batch" }).click();
  await expect(page.getByRole("dialog", { name: "New Batch of Ethiopia Guji Natural" })).toBeVisible();
  await page.keyboard.press("Escape");

  // In the dark theme the count and a Location's weight still read.
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveClass(colorScheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    expect(await textContrast(batches.getByText("2 at a Location, 5090 g in all")), `${colorScheme}: the count`).toBeGreaterThanOrEqual(4.5);
    expect(await textContrast(table.getByText("3240 g", { exact: true })), `${colorScheme}: a Location's weight`).toBeGreaterThanOrEqual(4.5);
  }
  await page.emulateMedia({ colorScheme: "light" });

  // At a phone's width the table scrolls in its own box, and nothing is wider than the screen.
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(rows(table).first()).toBeVisible();
  await expectFits(page, 393);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Its Bean Archived, its batches are at no Location, though each keeps its own state; restored, they are back where they were.
  await put(page, `/api/beans/${guji}/archived`, { archived: true });
  await page.reload();
  await expect(batches.getByText("None at a Location")).toBeVisible();
  await expect(row(`LR-0412 roasted ${roastDay("2026-11-17")}`)).toHaveText([roastDay("2026-11-17"), "LR-0412", "-", "-"]);
  await expect(row(`Roasted ${roastDay("2026-11-10")}`)).toHaveText([roastDay("2026-11-10"), "-", "-", "-"]);
  await put(page, `/api/beans/${guji}/archived`, { archived: false });
  await page.reload();
  await expect(batches.getByText("2 at a Location, 5090 g in all")).toBeVisible();
  await expect(row(`LR-0412 roasted ${roastDay("2026-11-17")}`)).toHaveText([roastDay("2026-11-17"), "LR-0412", "Downtown 3240 gRiverside 1850 g", "5090 g"]);

  // A Bean with no batch says so, and still offers New Batch; an Archived one offers none.
  const bare = await bean(page, "Bare Bean");
  await page.goto(`/library/beans/${bare}`);
  const none = page.getByRole("region", { name: "Batches", exact: true });
  await expect(none).toContainText("No batches yet.");
  await expect(none.getByText(/at a Location/)).toHaveCount(0);
  await expect(none.getByRole("button", { name: "New Batch" })).toBeVisible();
  await put(page, `/api/beans/${bare}/archived`, { archived: true });
  await page.reload();
  await expect(none).toContainText("No batches yet.");
  await expect(none.getByRole("button", { name: "New Batch" })).toHaveCount(0);
});

test("each page reads the previous release's server, as during a deploy: with no Batch Code sent, a batch is named by its Bean and roast date", async ({ page }) => {
  const { downtown, house, recipes } = await seed(page);
  // The previous release answers a Recipe's batch, and a Bean's batches, with no Batch Code, and a batch with no total.
  const olderRecipe = (found: Record_) => {
    const uses = found.uses as Record_;
    const { batchCode: _code, ...beanBatch } = (uses.beanBatch ?? {}) as Record_;
    return { ...found, uses: { ...uses, beanBatch: uses.beanBatch === null ? null : beanBatch } };
  };
  await page.route("**/api/locations/*/recipes", async (route) => {
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { recipes: ((await answer.json()) as { recipes: Record_[] }).recipes.map(olderRecipe) } });
  });
  await page.route("**/api/recipes/*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { recipe: olderRecipe(((await answer.json()) as { recipe: Record_ }).recipe) } });
  });
  const olderBatch = ({ batchCode: _code, totalRemainingWeight: _total, ...found }: Record_) => found;
  await page.route("**/api/bean-batches", async (route) => {
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { batches: ((await answer.json()) as { batches: Record_[] }).batches.map(olderBatch) } });
  });
  await page.route(`**/api/beans/${house}`, async (route) => {
    const answer = await route.fetch();
    const { bean: found } = (await answer.json()) as { bean: Record_ & { batches: Record_[] } };
    await route.fulfill({ response: answer, json: { bean: { ...found, batches: found.batches.map(olderBatch) } } });
  });

  // A Recipes list: each batch by its Bean over its roast day, with no code, still linked, and still marked finished.
  await page.goto(`/locations/${downtown.id}`);
  const slots = page.getByRole("region", { name: "Recipes" }).getByRole("table", { name: "Recipe Slots" });
  const batchCell = (name: string) => rows(slots).filter({ has: page.getByRole("link", { name, exact: true }) }).getByRole("cell").nth(2);
  await expect(batchCell("House Undated")).toHaveText("House EspressoNo roast date");
  await expect(batchCell("House Ristretto")).toHaveText(`House EspressoBatch finished hereRoasted ${roastDay("2026-11-03")}`);
  await expect(slots.getByLabel(/^Batch Code/)).toHaveCount(0);
  await expect(batchCell("House Ristretto").getByRole("link")).toHaveAttribute("href", /^\/library\/bean-batches\//);

  // A Recipe's card and finished strip: by its Bean and roast date, and its form's options the same, with no code.
  await page.goto(`/library/recipes/${recipes.finished}`);
  const details = page.getByRole("region", { name: "Recipe", exact: true });
  await expect(field(details, "Bean Batch")).toHaveText(`House Espresso, roasted ${roastDay("2026-11-03")}`);
  const strip = page.getByRole("region", { name: "Bean Batch", exact: true });
  await expect(strip.getByRole("link", { name: `House Espresso, roasted ${roastDay("2026-11-03")}`, exact: true })).toBeVisible();
  await expect(strip.getByLabel(/^Batch Code/)).toHaveCount(0);
  await page.getByRole("button", { name: "Edit the Recipe" }).click();
  await page.getByRole("form", { name: "Edit House Ristretto" }).getByLabel("Bean Batch").click();
  const atDowntown = page.getByRole("group", { name: "At Downtown", exact: true });
  // An earlier test of this file may have added one more of another Bean there: those of House Espresso are these.
  await expect
    .poll(async () => (await atDowntown.getByRole("option").evaluateAll((options) => options.map((option) => option.getAttribute("aria-label") ?? ""))).filter((name) => name.startsWith("House Espresso")))
    .toEqual([`House Espresso, roasted ${roastDay("2026-11-17")}, 3240 g here`, `House Espresso, roasted ${roastDay("2026-11-10")}, Not tracked`, "House Espresso, no roast date, Not tracked"]);
  await expect(atDowntown.getByLabel(/^Batch Code/)).toHaveCount(0);
  // Escape closes the list, and again the form.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A Bean's page: each batch by its roast day, a dash for its code, and its weights added up.
  await page.goto(`/library/beans/${house}`);
  const batches = page.getByRole("region", { name: "Batches", exact: true });
  const table = batches.getByRole("table", { name: "Batches" });
  await expect(rows(table).filter({ has: page.getByRole("link", { name: `Roasted ${roastDay("2026-11-17")}`, exact: true }) }).getByRole("cell")).toHaveText([roastDay("2026-11-17"), "-", "Downtown 3240 g", "3240 g"]);
  await expect(table.getByLabel(/^Batch Code/)).toHaveCount(0);
  await expect(batches.getByText(/^\d at a Location, 3240 g in all$/)).toBeVisible();
});
