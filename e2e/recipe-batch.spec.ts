import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { farFromMidnight } from "./support/calendar.js";
import { roastDay } from "./support/days.js";
import { useFreshServer } from "./support/fresh-server.js";
import { boxes, expectFits, textContrast } from "./support/layout.js";
import { expectOptions, field, openCard, recipeAction, rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";

// A Recipe's Bean Batch on its page (ticket #733): the strip under its
// title, with what is left of the batch at the Recipe's Location; the batch
// picker, a field typed into over a list of the batches that match, in the
// Recipe form, the copy dialog and the Change batch dialog; and the strip
// of a Recipe whose batch is finished at its Location, with the next roast
// of the same Bean one press away. The picker in the Shots list's filter is
// shot-links.spec.ts's to cover, the Overview's line overview.spec.ts's, and
// the Trend's marks recipe-numbers.spec.ts's. Everything is made through
// the REST API, on no tablet.
//
// Downtown's batches of House Espresso, of Lantern Coffee Roasters, each
// roasted so many days ago by Downtown's days:
//
// | Batch | Roasted | Batch Code | Where |
// |---|---|---|---|
// | next | 3 days ago | LR-0419 | Downtown, 6000 g |
// | now | 10 days ago | LR-0411 | Downtown, 3240 g |
// | plain | 17 days ago | none | Downtown, no weight entered |
// | moved | 20 days ago | LR-0407 | all 800 g moved from Downtown to Riverside |
// | old | 24 days ago | LR-0405 | finished at Downtown |
// | lab | yesterday | LR-0423 | Roastery Lab, 6000 g |
//
// with House Decaf, of Roux, LR-0418, roasted 4 days ago, at Riverside,
// 1850 g; and Guest Kenya, roasted 30 days ago, finished at Riverside, the
// only batch of its Bean.
//
// The days are counted back from today, so the Locations are where no day
// begins while this runs (`farFromMidnight`).
const server = useFreshServer();

type Record_ = Record<string, unknown>;
type Place = Awaited<ReturnType<typeof createLocation>>;

const { zone: ZONE, ahead: AHEAD } = farFromMidnight();

/** A day at the Locations, `days` from today there, as a date, such as 2026-11-17. */
function date(days: number): string {
  const today = new Date(Date.now() + AHEAD * 3_600_000);
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days)).toISOString().slice(0, 10);
}

/** A day `days` from today as a page writes one: "Nov 17". */
const day = (days: number) => roastDay(date(days));

/** A day as the browser's own clock writes one a batch was finished or moved on: today's, or either side of it where the day turns meanwhile. */
const TODAY = String.raw`\w{3} \d{1,2}`;

test.beforeEach(({ page }) => signInAsAdmin(page));

async function post<T>(page: Page, path: string, data: unknown, status = 201): Promise<T> {
  const response = await page.request.post(path, { data });
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()) as T;
}

async function put(page: Page, path: string, data: unknown): Promise<void> {
  const response = await page.request.put(path, { data });
  expect(response.status(), await response.text()).toBe(200);
}

const bean = async (page: Page, roaster: string, name: string) => (await post<{ bean: { id: string } }>(page, "/api/beans", { content: { roaster, name } })).bean.id;

/** A batch of the Bean, roasted `days` from today, created at the Location with the weight, or untracked with none given. */
const batch = async (page: Page, beanId: string, at: Place, days: number, batchCode?: string, remainingWeight?: number) =>
  (
    await post<{ batch: { id: string } }>(page, "/api/bean-batches", {
      beanId,
      content: { roastDate: date(days), ...(batchCode !== undefined && { batchCode }) },
      locations: [{ locationId: at.id, ...(remainingWeight !== undefined && { remainingWeight }) }],
    })
  ).batch.id;

const recipe = async (page: Page, at: Place, slot: number | null, content: Record_) =>
  (await post<{ recipe: { id: string } }>(page, "/api/recipes", { locationId: at.id, slot, content: { dose: 20, yield: 44, ...content } })).recipe.id;

const batchPage = (id: string) => `/library/bean-batches/${id}`;

/** The strip under a Recipe's title. */
const stripOf = (page: Page) => page.getByRole("region", { name: "Bean Batch", exact: true });

/** The chip a Batch Code is set apart in. */
const code = (within: Locator, batchCode: string) => within.getByLabel(`Batch Code ${batchCode}`, { exact: true });

/** The Recipe's batch, as the REST API gives it. */
const batchOf = async (page: Page, recipeId: string) => ((await (await page.request.get(`/api/recipes/${recipeId}`)).json()) as { recipe: { uses: { beanBatch: { id: string } | null } } }).recipe.uses.beanBatch?.id ?? null;

/** Each batch in words, as a link, an option or a button names it. */
const words = {
  next: () => `House Espresso LR-0419, roasted ${day(-3)}`,
  now: () => `House Espresso LR-0411, roasted ${day(-10)}`,
  plain: () => `House Espresso, roasted ${day(-17)}`,
  moved: () => `House Espresso LR-0407, roasted ${day(-20)}`,
  old: () => `House Espresso LR-0405, roasted ${day(-24)}`,
  lab: () => `House Espresso LR-0423, roasted ${day(-1)}`,
  decaf: () => `House Decaf LR-0418, roasted ${day(-4)}`,
  kenya: () => `Guest Kenya, roasted ${day(-30)}`,
};

type Seeded = {
  downtown: Place;
  riverside: Place;
  house: string;
  batches: Record<keyof typeof words, string>;
  recipes: Record<"espresso" | "cortado" | "ristretto" | "lungo" | "filter" | "guest" | "bare" | "kenya", string>;
};
let seeded: Seeded | undefined;

/**
 * Downtown's Recipes: the Espresso and the Cortado name the batch in use;
 * the Ristretto one finished at Downtown, and the Lungo one moved from it
 * whole; the Filter one with no weight entered; the Guest a Bean with no
 * batch, and the Bare neither. Riverside's Kenya Filter names its Bean's
 * only batch, finished there.
 */
async function seed(page: Page): Promise<Seeded> {
  if (seeded) return seeded;
  const downtown = await createLocation(page, "Downtown", ZONE);
  const riverside = await createLocation(page, "Riverside", ZONE);
  const lab = await createLocation(page, "Roastery Lab", ZONE);
  const house = await bean(page, "Lantern Coffee Roasters", "House Espresso");
  const decaf = await bean(page, "Roux", "House Decaf");
  const kenya = await bean(page, "Lantern Coffee Roasters", "Guest Kenya");
  const batches = {
    next: await batch(page, house, downtown, -3, "LR-0419", 6000),
    now: await batch(page, house, downtown, -10, "LR-0411", 3240),
    plain: await batch(page, house, downtown, -17),
    moved: await batch(page, house, downtown, -20, "LR-0407", 800),
    old: await batch(page, house, downtown, -24, "LR-0405", 500),
    lab: await batch(page, house, lab, -1, "LR-0423", 6000),
    decaf: await batch(page, decaf, riverside, -4, "LR-0418", 1850),
    kenya: await batch(page, kenya, riverside, -30),
  };
  const recipes = {
    espresso: await recipe(page, downtown, 1, { name: "House Espresso", beanBatchId: batches.now }),
    ristretto: await recipe(page, downtown, 2, { name: "House Ristretto", beanBatchId: batches.old }),
    lungo: await recipe(page, downtown, 3, { name: "House Lungo", beanBatchId: batches.moved }),
    filter: await recipe(page, downtown, 4, { name: "House Filter", beanBatchId: batches.plain }),
    cortado: await recipe(page, downtown, 5, { name: "House Cortado", beanBatchId: batches.now }),
    guest: await recipe(page, downtown, null, { name: "Guest", beanId: house }),
    bare: await recipe(page, downtown, null, { name: "Bare" }),
    kenya: await recipe(page, riverside, 1, { name: "Kenya Filter", beanBatchId: batches.kenya }),
  };
  await put(page, `/api/bean-batches/${batches.old}/locations/${downtown.id}`, { atLocation: false });
  await put(page, `/api/bean-batches/${batches.kenya}/locations/${riverside.id}`, { atLocation: false });
  await post(page, `/api/bean-batches/${batches.moved}/moves`, { fromLocationId: downtown.id, toLocationId: riverside.id, amount: "all" }, 200);
  seeded = { downtown, riverside, house, batches, recipes };
  return seeded;
}

/** Runs `work` with a page signed in as a new account: Staff working at the Location, or a Viewer. */
async function asNew(page: Page, browser: Browser, role: "staff" | "viewer", locationId: string | undefined, work: (page: Page) => Promise<void>) {
  const email = `${role}-${Date.now()}@example.com`;
  const { link } = await post<{ link: string }>(page, "/api/invites", { email, role, locationIds: locationId ? [locationId] : [] });
  const context = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await context.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: { name: role === "staff" ? "Sam Staff" : "Val Viewer", password: "account password 1" } });
    expect(accepted.status(), await accepted.text()).toBe(201);
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}

/** The requests that change a Recipe, as the page sends them from here on: each one's body. */
function recipeEdits(page: Page): unknown[] {
  const edits: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && /\/api\/recipes\/[^/]+$/.test(new URL(request.url()).pathname)) edits.push(request.postDataJSON());
  });
  return edits;
}

test("a Recipe's page has a strip under its title with its batch, its roast day and age, its roaster, and what is left of it at the Recipe's Location, a plain weight, or Not tracked", async ({ page }) => {
  const { batches, recipes, house } = await seed(page);

  await page.goto(`/library/recipes/${recipes.espresso}`);
  const strip = stripOf(page);
  // The batch in large text: its Bean, the link to the batch, named in words, with its code in a chip.
  await expect(strip.getByText("Bean Batch", { exact: true })).toBeVisible();
  const name = strip.getByRole("link", { name: words.now(), exact: true });
  await expect(name).toHaveText("House Espresso");
  await expect(name).toHaveAttribute("href", batchPage(batches.now));
  await expect(code(strip, "LR-0411")).toBeVisible();
  expect(Number.parseFloat(await name.evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(20);
  // Under it, its roast day, how long ago that was, and its roaster.
  await expect(strip.getByText(`Roasted ${day(-10)}, 10 days ago · Lantern Coffee Roasters`, { exact: true })).toBeVisible();
  // At its right, what is left of it at Downtown: a plain number, with no mark, colour or alert for a low one.
  await expect(field(strip, "Remaining at Downtown")).toHaveText("3240 g");
  await expect(strip.locator('[data-slot="spec-mark"], [role="alert"], [data-slot="badge"]')).toHaveCount(0);
  await expect(strip).not.toContainText(/low|Shots left/i);
  await expect(strip.getByRole("button")).toHaveText(["Change batch"]);
  // It stands between the title and how the Recipe is pulling, and its weight right of its batch.
  const [title, box, pulling, weight] = await boxes(page.getByRole("heading", { name: "House Espresso", level: 1 }), strip, page.getByRole("heading", { name: "How it is pulling" }), field(strip, "Remaining at Downtown"));
  expect(box!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
  expect(box!.y + box!.height).toBeLessThanOrEqual(pulling!.y);
  expect(weight!.x).toBeGreaterThan((await boxes(name))[0]!.x + 200);
  // The Recipe card keeps its Bean Batch field.
  await expect(field(page.getByRole("region", { name: "Recipe", exact: true }), "Bean Batch")).toHaveText(`House Espresso LR-0411 roasted ${day(-10)}`);

  // Its weight is in the page's own colour, as its title is, whatever it is.
  const colours = await Promise.all([field(strip, "Remaining at Downtown"), page.getByRole("heading", { name: "House Espresso", level: 1 })].map((element) => element.evaluate((node) => getComputedStyle(node).color)));
  expect(colours[0]).toBe(colours[1]);

  // A batch with no Batch Code and no weight entered: its Bean over its roast day, and Not tracked.
  await page.goto(`/library/recipes/${recipes.filter}`);
  await expect(strip.getByRole("link", { name: words.plain(), exact: true })).toHaveAttribute("href", batchPage(batches.plain));
  await expect(strip.getByLabel(/^Batch Code/)).toHaveCount(0);
  await expect(strip.getByText(`Roasted ${day(-17)}, 17 days ago · Lantern Coffee Roasters`, { exact: true })).toBeVisible();
  await expect(field(strip, "Remaining at Downtown")).toHaveText("Not tracked");

  // A Recipe naming a Bean with no batch: the Bean's name, linked to the Bean, over "No batch", with no weight.
  await page.goto(`/library/recipes/${recipes.guest}`);
  await expect(strip.getByRole("link", { name: "House Espresso", exact: true })).toHaveAttribute("href", `/library/beans/${house}`);
  await expect(strip.getByText("No batch · Lantern Coffee Roasters", { exact: true })).toBeVisible();
  await expect(strip.getByRole("term")).toHaveCount(0);
  await expect(strip.getByRole("button")).toHaveText(["Change batch"]);

  // One naming neither.
  await page.goto(`/library/recipes/${recipes.bare}`);
  await expect(strip.getByText("No Bean Batch", { exact: true })).toBeVisible();
  await expect(strip.getByRole("link")).toHaveCount(0);
  await expect(strip.getByRole("button")).toHaveText(["Change batch"]);
});

test("the Recipe form picks a batch from a field that is typed into: each word matched in the Bean's name, its roaster and the Batch Code, the batches grouped by where they are with their weights, from the keyboard too", async ({ page }) => {
  const { downtown, batches, recipes } = await seed(page);
  const edits = recipeEdits(page);

  await page.goto(`/library/recipes/${recipes.espresso}`);
  await page.getByRole("button", { name: "Edit the Recipe" }).click();
  const form = page.getByRole("form", { name: "Edit House Espresso" });
  const picker = form.getByRole("combobox", { name: "Bean Batch", exact: true });
  // A combo box, which reads the Recipe's batch until it is typed into, its list closed.
  await expect(picker).toHaveValue(`${words.now()} (this Recipe's batch now)`);
  await expect(picker).toHaveAttribute("placeholder", "Bean, roaster or Batch Code");
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  // Under it, what picking a batch from elsewhere does.
  await expect(form.getByText("A batch picked from elsewhere is added at Downtown with no weight. To bring its weight, move it on the batch's page.", { exact: true })).toBeVisible();

  // Pressed, it lists every batch it offers: those at Downtown, the latest roasted first, each with its weight there;
  // then those elsewhere, each with where it is and its weight over them; then No batch. None Archived or finished
  // everywhere is left out of reach: one at no Location is still offered, as before.
  await picker.click();
  await expect(picker).toHaveAttribute("aria-expanded", "true");
  const list = page.getByRole("listbox", { name: "Batches", exact: true });
  await expect(list.getByRole("group")).toHaveCount(3);
  const here = list.getByRole("group", { name: "At Downtown", exact: true });
  const elsewhere = list.getByRole("group", { name: "Elsewhere: saving adds it at Downtown", exact: true });
  await expectOptions(here, [`${words.next()}, 6000 g here`, `${words.now()}, this Recipe's batch now, 3240 g here`, `${words.plain()}, Not tracked`]);
  await expectOptions(elsewhere, [
    `${words.lab()}, at Roastery Lab, 6000 g there`,
    `${words.decaf()}, at Riverside, 1850 g there`,
    `${words.moved()}, at Riverside, 800 g there`,
    `${words.old()}, at no Location`,
    `${words.kenya()}, at no Location`,
  ]);
  await expectOptions(list.getByRole("group").last(), ["No batch"]);
  // Each option is two lines: the Bean and its code, over its roast day, with its weight at its right. The Recipe's
  // batch now says so on its second line, and is the one marked as chosen.
  const now = list.getByRole("option", { name: `${words.now()}, this Recipe's batch now, 3240 g here`, exact: true });
  await expect(now).toHaveText(`House EspressoLR-0411Roasted ${day(-10)} · this Recipe's batch now3240 g here`);
  await expect(code(now, "LR-0411")).toBeVisible();
  await expect(list.getByRole("option", { selected: true })).toHaveText([/this Recipe's batch now/]);
  const [bean_, roasted, weight] = await boxes(now.getByText("House Espresso", { exact: true }), now.getByText(`Roasted ${day(-10)} · this Recipe's batch now`), now.getByText("3240 g here"));
  expect(roasted!.y).toBeGreaterThanOrEqual(bean_!.y + bean_!.height - 2);
  expect(weight!.x).toBeGreaterThan(roasted!.x + roasted!.width);
  await expect(list.getByRole("option", { name: `${words.plain()}, Not tracked`, exact: true })).toHaveText(`House EspressoRoasted ${day(-17)}Not tracked`);
  await expect(list.getByRole("option", { name: `${words.lab()}, at Roastery Lab, 6000 g there`, exact: true })).toHaveText(`House EspressoLR-0423Roasted ${day(-1)} · at Roastery Lab6000 g there`);

  // Typed into, it lists the batches that match: each word in the Bean's name, its roaster or the Batch Code, ignoring
  // case, in any order. No batch stays in reach whatever is typed.
  await picker.fill("lantern 0419");
  await expect(page.getByRole("listbox", { name: "Batches matching lantern 0419", exact: true })).toBeVisible();
  await expectOptions(page.getByRole("listbox"), [`${words.next()}, 6000 g here`, "No batch"]);
  await picker.fill("DECAF");
  await expectOptions(page.getByRole("listbox"), [`${words.decaf()}, at Riverside, 1850 g there`, "No batch"]);
  await expect(page.getByRole("group", { name: "At Downtown", exact: true })).toHaveCount(0);
  await picker.fill("roux");
  await expectOptions(page.getByRole("listbox"), [`${words.decaf()}, at Riverside, 1850 g there`, "No batch"]);
  await picker.fill("house lr-04");
  await expectOptions(page.getByRole("listbox"), [
    `${words.next()}, 6000 g here`,
    `${words.now()}, this Recipe's batch now, 3240 g here`,
    `${words.lab()}, at Roastery Lab, 6000 g there`,
    `${words.decaf()}, at Riverside, 1850 g there`,
    `${words.moved()}, at Riverside, 800 g there`,
    `${words.old()}, at no Location`,
    "No batch",
  ]);
  await picker.fill("yirgacheffe");
  await expectOptions(page.getByRole("listbox"), ["No batch"]);
  await expect(page.getByRole("listbox").getByText("No batch matches.", { exact: true })).toBeVisible();
  // Enter on words that find no batch chooses nothing, not No batch, and sends nothing.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(picker).toHaveValue("yirgacheffe");
  await expect(form).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveValue(`${words.now()} (this Recipe's batch now)`);
  // Typed into with the caret left after what the field reads, as Safari may leave it on a click, the words typed are
  // taken alone.
  await picker.click();
  await picker.evaluate((input: HTMLInputElement) => input.setSelectionRange(input.value.length, input.value.length));
  await page.keyboard.type("0419");
  await expect(picker).toHaveValue("0419");
  await expectOptions(page.getByRole("listbox", { name: "Batches matching 0419", exact: true }), [`${words.next()}, 6000 g here`, "No batch"]);
  await page.keyboard.press("Escape");

  // From the keyboard: Enter chooses the first match, which leaves the form open and unsent; the arrows move through
  // the options, the field naming the one they are on to a screen reader.
  await picker.fill("0419");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveValue(words.next());
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(form).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("option", { selected: true })).toHaveAccessibleName(`${words.next()}, 6000 g here`);
  await page.keyboard.press("ArrowDown");
  const active = await picker.getAttribute("aria-activedescendant");
  expect(await page.locator(`[id="${active}"]`).getAttribute("aria-label")).toBe(`${words.now()}, this Recipe's batch now, 3240 g here`);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveValue(`${words.now()} (this Recipe's batch now)`);
  // Escape closes the list alone, and what was typed is put back to the batch chosen.
  await picker.fill("lr");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(form).toBeVisible();
  await expect(picker).toHaveValue(`${words.now()} (this Recipe's batch now)`);
  // So does leaving the field.
  await picker.fill("lr");
  await form.getByLabel("Name", { exact: true }).focus();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(picker).toHaveValue(`${words.now()} (this Recipe's batch now)`);

  // A batch from elsewhere, pressed: the form says what saving adds, before it is saved.
  await picker.click();
  await page.getByRole("option", { name: `${words.lab()}, at Roastery Lab, 6000 g there`, exact: true }).click();
  await expect(picker).toHaveValue(`${words.lab()} (at Roastery Lab)`);
  await expect(form.getByRole("status", { name: "Saving also" })).toContainText(`adds the Bean Batch ${words.lab()} at Downtown`);
  // Closed unsaved, nothing was sent.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(edits).toEqual([]);
  expect(await batchOf(page, recipes.espresso)).toBe(batches.now);

  // A new Recipe's picker offers the same, with no batch chosen, and none of them its batch now.
  await page.goto(`/locations/${downtown.id}`);
  await page.getByRole("region", { name: "Recipes" }).getByRole("button", { name: "New Recipe" }).click();
  const fresh = page.getByRole("form", { name: "New Recipe" }).getByRole("combobox", { name: "Bean Batch", exact: true });
  await expect(fresh).toHaveValue("No batch");
  await fresh.click();
  await expectOptions(page.getByRole("group", { name: "At Downtown", exact: true }), [`${words.next()}, 6000 g here`, `${words.now()}, 3240 g here`, `${words.plain()}, Not tracked`]);
  await expect(page.getByRole("option", { selected: true })).toHaveText(["No batch"]);

  // At a phone's width the open list is no wider than the form, and nothing is wider than the screen.
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(page.getByRole("listbox")).toBeVisible();
  await expectFits(page, 393);
  const [options, dialog] = await boxes(page.getByRole("listbox"), page.getByRole("dialog"));
  expect(options!.x).toBeGreaterThanOrEqual(dialog!.x);
  expect(options!.x + options!.width).toBeLessThanOrEqual(dialog!.x + dialog!.width);
  expect(await page.getByRole("listbox").evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Typed into from No batch, which no word hides, Enter chooses the batch the words find, and the arrows move on from it.
  await fresh.fill("0419");
  await page.keyboard.press("Enter");
  await expect(fresh).toHaveValue(words.next());
  await fresh.fill("house lr");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(fresh).toHaveValue(words.now());
});

test("the copy dialog picks the copy's batch with the same picker: the entry that keeps the Recipe's batch first, then None, then the batches at the Location copied to", async ({ page }) => {
  const { recipes, batches } = await seed(page);
  await page.goto(`/library/recipes/${recipes.espresso}`);
  await recipeAction(page, "Copy to a Location");
  const copy = page.getByRole("form", { name: "Copy the Recipe" });
  await copy.getByLabel("Copy to").click();
  await page.getByRole("option", { name: "Riverside" }).click();
  const picker = copy.getByRole("combobox", { name: "Bean Batch", exact: true });
  await expect(picker).toHaveValue(`${words.now()} (this Recipe's)`);
  await expect(picker).toHaveAttribute("placeholder", "Bean, roaster or Batch Code");
  await picker.click();
  const list = page.getByRole("listbox", { name: "Batches", exact: true });
  await expectOptions(list.getByRole("group").first(), [`${words.now()}, this Recipe's`, "None"]);
  // Riverside's batches, the latest roasted first, each with what Riverside has of it.
  await expectOptions(list.getByRole("group", { name: "At Riverside", exact: true }), [`${words.decaf()}, 1850 g there`, `${words.moved()}, 800 g there`]);
  await expect(list.getByRole("option", { selected: true })).toHaveAccessibleName(`${words.now()}, this Recipe's`);
  // Typed into, it finds one of them by its code; None stays in reach.
  await picker.fill("lr-0407");
  await expectOptions(page.getByRole("listbox"), ["None", `${words.moved()}, 800 g there`]);
  await page.getByRole("option", { name: `${words.moved()}, 800 g there`, exact: true }).click();
  await expect(picker).toHaveValue(words.moved());
  await expect(page.getByRole("listbox")).toHaveCount(0);
  // Copied, the copy names the batch picked.
  await copy.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByText("at Riverside", { exact: true })).toBeVisible();
  expect(await batchOf(page, page.url().split("/").pop()!)).toBe(batches.moved);
  await expect(field(stripOf(page), "Remaining at Riverside")).toHaveText("800 g");
});

test("a Recipe whose batch is finished at its Location shows the finished strip in place of the alert: the same Bean's other batches there, each with Use this batch, which changes the batch at once, and Another batch…", async ({ page }) => {
  const { batches, recipes } = await seed(page);
  const edits = recipeEdits(page);

  await page.goto(`/library/recipes/${recipes.ristretto}`);
  const strip = stripOf(page);
  // "Batch finished here" stays beside the title, and the strip says where, with the batch and when it was finished.
  await expect(page.getByRole("heading", { name: "House Ristretto", level: 1 })).toContainText("Batch finished here");
  await expect(strip.getByText("Its Bean Batch is finished at Downtown", { exact: true })).toBeVisible();
  await expect(strip.getByRole("link", { name: words.old(), exact: true })).toHaveAttribute("href", batchPage(batches.old));
  await expect(code(strip, "LR-0405")).toBeVisible();
  await expect(strip.getByText(new RegExp(`^Roasted ${day(-24)} · finished here ${TODAY}$`))).toBeVisible();
  // It is where the alert was, between the title and how the Recipe is pulling, and no alert is left.
  const [title, box, pulling] = await boxes(page.getByRole("heading", { name: "House Ristretto", level: 1 }), strip, page.getByRole("heading", { name: "How it is pulling" }));
  expect(box!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
  expect(box!.y + box!.height).toBeLessThanOrEqual(pulling!.y);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(/is no longer at Downtown/)).toHaveCount(0);

  // The next roasts of House Espresso at Downtown, the latest roasted first: its code, its roast day, its weight there.
  await expect(strip.getByText("Pick the next roast of House Espresso here", { exact: true })).toBeVisible();
  const next = strip.getByRole("list", { name: "Other batches of House Espresso at Downtown" }).getByRole("listitem");
  await expect(next).toHaveText([`LR-0419roasted ${day(-3)}6000 g hereUse this batch`, `LR-0411roasted ${day(-10)}3240 g hereUse this batch`, `roasted ${day(-17)}not tracked hereUse this batch`]);
  // Each button names its batch in words, and the first is the filled one.
  const use = strip.getByRole("button", { name: /^Use / });
  await expect(use).toHaveCount(3);
  await expect(use.nth(0)).toHaveAccessibleName(`Use ${words.next()}`);
  await expect(use.nth(2)).toHaveAccessibleName(`Use ${words.plain()}`);
  const grounds = await use.evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor));
  expect(grounds[0]).not.toBe(grounds[1]);
  expect(grounds[1]).toBe(grounds[2]);
  await expect(strip.getByText("The change reaches every tablet at Downtown, as an edit does.", { exact: true })).toBeVisible();
  // Its weights are plain numbers here too.
  await expect(strip.locator('[data-slot="spec-mark"]')).toHaveCount(0);

  // Another batch… opens the Change batch dialog, its own batch marked among those elsewhere; Cancel changes nothing.
  await strip.getByRole("button", { name: "Another batch…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change the Bean Batch of House Ristretto" });
  await expect(dialog.getByRole("option", { selected: true })).toHaveAccessibleName(`${words.old()}, this Recipe's batch now · at no Location`);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(strip.getByRole("button", { name: "Another batch…", exact: true })).toBeFocused();
  await expect(strip.getByText("Its Bean Batch is finished at Downtown", { exact: true })).toBeVisible();
  expect(edits).toEqual([]);

  // A failure is shown in the strip, and changes nothing.
  await page.route(
    (url) => url.pathname === `/api/recipes/${recipes.ristretto}`,
    async (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 503, json: { message: "The Library is not answering" } }) : route.continue()),
  );
  await strip.getByRole("button", { name: `Use ${words.now()}`, exact: true }).click();
  await expect(strip.getByRole("alert")).toHaveText("The Library is not answering");
  await expect(strip.getByText("Its Bean Batch is finished at Downtown", { exact: true })).toBeVisible();
  expect(await batchOf(page, recipes.ristretto)).toBe(batches.old);
  await page.unrouteAll({ behavior: "wait" });
  edits.length = 0;

  // Use this batch changes the Recipe's batch at once, with no confirmation: an edit of its batch and nothing else.
  await strip.getByRole("button", { name: `Use ${words.now()}`, exact: true }).click();
  await expect(strip.getByRole("link", { name: words.now(), exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(edits).toEqual([{ content: { beanBatchId: batches.now } }]);
  // The strip is the one of a batch at its Location again, and the title's badge is gone.
  await expect(strip.getByText("Its Bean Batch is finished at Downtown")).toHaveCount(0);
  await expect(field(strip, "Remaining at Downtown")).toHaveText("3240 g");
  await expect(strip.getByRole("button")).toHaveText(["Change batch"]);
  // The button pressed is gone with the strip it was in: the keyboard's focus goes to the new strip's button.
  await expect(strip.getByRole("button", { name: "Change batch", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "House Ristretto", level: 1 })).not.toContainText("Batch finished here");
  // Its History keeps the change, as an edit's.
  const history = (await openCard(page, "History")).getByRole("table", { name: "History" });
  await expect(rows(history).first()).toContainText(`Bean Batch${words.now()}`);

  // A batch a Batch Move of all took to another Location reads as moved there, as the batch's own page says it.
  await page.goto(`/library/recipes/${recipes.lungo}`);
  await expect(strip.getByText("Its Bean Batch is finished at Downtown", { exact: true })).toBeVisible();
  await expect(strip.getByText(new RegExp(`^Roasted ${day(-20)} · moved to Riverside ${TODAY}$`))).toBeVisible();
  await page.goto(batchPage(batches.moved));
  await expect(page.getByRole("region", { name: "Where it is" }).getByRole("list", { name: "Locations it has left" })).toContainText(new RegExp(`Moved to Riverside ${TODAY}`));

  // With no other batch of the Bean at the Location, one line says so, and Another batch… is still there.
  await page.goto(`/library/recipes/${recipes.kenya}`);
  await expect(strip.getByText("Its Bean Batch is finished at Riverside", { exact: true })).toBeVisible();
  await expect(strip.getByText("Pick the next roast of Guest Kenya here", { exact: true })).toBeVisible();
  await expect(strip.getByText("No other batch of Guest Kenya is at Riverside.", { exact: true })).toBeVisible();
  await expect(strip.getByRole("list")).toHaveCount(0);
  await expect(strip.getByRole("button")).toHaveText(["Another batch…"]);
});

test("Change batch opens the picker in a dialog titled for the Recipe: Cancel changes nothing, and Save changes the Recipe's batch as an edit does, adding one from elsewhere at its Location with no weight", async ({ page }) => {
  const { downtown, batches, recipes } = await seed(page);
  const edits = recipeEdits(page);

  await page.goto(`/library/recipes/${recipes.cortado}`);
  const strip = stripOf(page);
  await strip.getByRole("button", { name: "Change batch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change the Bean Batch of House Cortado" });
  await expect(dialog.getByText("A Recipe at Downtown. The change reaches every tablet there.", { exact: true })).toBeVisible();
  // The picker is the whole of it: the field, empty over its list, which is in view at once, the Recipe's batch marked.
  const picker = dialog.getByRole("combobox", { name: "Bean Batch", exact: true });
  await expect(picker).toBeFocused();
  await expect(picker).toHaveValue("");
  await expect(picker).toHaveAttribute("placeholder", "Bean, roaster or Batch Code");
  const list = dialog.getByRole("listbox", { name: "Batches", exact: true });
  await expectOptions(list.getByRole("group", { name: "At Downtown", exact: true }), [`${words.next()}, 6000 g here`, `${words.now()}, this Recipe's batch now, 3240 g here`, `${words.plain()}, Not tracked`]);
  await expect(list.getByRole("group", { name: "Elsewhere: saving adds it at Downtown", exact: true }).getByRole("option")).toHaveCount(5);
  await expect(list.getByRole("option", { selected: true })).toHaveAccessibleName(`${words.now()}, this Recipe's batch now, 3240 g here`);
  await expect(dialog.getByText("A batch picked from elsewhere is added at Downtown with no weight. To bring its weight, move it on the batch's page.", { exact: true })).toBeVisible();
  // Cancel and Save at the right of its foot, Save the last.
  const [cancel, save, frame] = await boxes(dialog.getByRole("button", { name: "Cancel", exact: true }), dialog.getByRole("button", { name: "Save", exact: true }), dialog);
  expect(cancel!.x).toBeGreaterThan(frame!.x + frame!.width / 2);
  expect(save!.x).toBeGreaterThan(cancel!.x + cancel!.width);
  expect(cancel!.y).toBeGreaterThan((await boxes(list))[0]!.y);

  // Typed into, the list is of the batches that match; Escape clears what was typed, and the dialog stays.
  await picker.fill("house 041");
  await expectOptions(dialog.getByRole("listbox"), [`${words.next()}, 6000 g here`, `${words.now()}, this Recipe's batch now, 3240 g here`, `${words.decaf()}, at Riverside, 1850 g there`, "No batch"]);
  await page.keyboard.press("Escape");
  await expect(picker).toHaveValue("");
  await expect(dialog).toBeVisible();
  await expect(list.getByRole("option")).toHaveCount(9);

  // A choice marks its option, and Cancel changes nothing.
  await list.getByRole("option", { name: `${words.next()}, 6000 g here`, exact: true }).click();
  await expect(list.getByRole("option", { selected: true })).toHaveAccessibleName(`${words.next()}, 6000 g here`);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // The keyboard's focus goes back to the button that opened it.
  await expect(strip.getByRole("button", { name: "Change batch", exact: true })).toBeFocused();
  await expect(strip.getByRole("link", { name: words.now(), exact: true })).toBeVisible();
  expect(edits).toEqual([]);
  expect(await batchOf(page, recipes.cortado)).toBe(batches.now);
  // Opened again, it starts from the Recipe as it is; saved unchanged, it sends nothing.
  await strip.getByRole("button", { name: "Change batch", exact: true }).click();
  await expect(list.getByRole("option", { selected: true })).toHaveAccessibleName(`${words.now()}, this Recipe's batch now, 3240 g here`);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(edits).toEqual([]);

  // Save, with a batch from elsewhere found from the keyboard: an edit of the Recipe's batch and nothing else.
  await strip.getByRole("button", { name: "Change batch", exact: true }).click();
  await picker.fill("lr-0423");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("option", { selected: true })).toHaveAccessibleName(`${words.lab()}, at Roastery Lab, 6000 g there`);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(edits).toEqual([{ content: { beanBatchId: batches.lab } }]);
  await expect(strip.getByRole("button", { name: "Change batch", exact: true })).toBeFocused();
  // The strip names the batch, which is at Downtown now, with no weight there.
  await expect(strip.getByRole("link", { name: words.lab(), exact: true })).toHaveAttribute("href", batchPage(batches.lab));
  await expect(strip.getByText(`Roasted ${day(-1)}, 1 day ago · Lantern Coffee Roasters`, { exact: true })).toBeVisible();
  await expect(field(strip, "Remaining at Downtown")).toHaveText("Not tracked");
  const { batch: added } = (await (await page.request.get(`/api/bean-batches/${batches.lab}`)).json()) as { batch: { locations: { location: { id: string }; remainingWeight: number | null }[] } };
  expect(added.locations.find((at) => at.location.id === downtown.id)?.remainingWeight).toBeNull();
  // Its History keeps the edit, the batch named in words with the one it replaced.
  const history = (await openCard(page, "History")).getByRole("table", { name: "History" });
  await expect(rows(history).first()).toContainText(`Bean Batch${words.lab()}`);
  // The picker now lists it at Downtown.
  await strip.getByRole("button", { name: "Change batch", exact: true }).click();
  await expect(list.getByRole("group", { name: "At Downtown", exact: true }).getByRole("option").first()).toHaveAccessibleName(`${words.lab()}, this Recipe's batch now, Not tracked`);

  // No batch, saved, clears it.
  edits.length = 0;
  await list.getByRole("option", { name: "No batch", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(strip.getByText("No Bean Batch", { exact: true })).toBeVisible();
  expect(edits).toEqual([{ content: { beanBatchId: null } }]);

  // A Recipe naming a Bean with no batch keeps that Bean unless another is picked: its entry leads the list.
  await page.goto(`/library/recipes/${recipes.guest}`);
  await strip.getByRole("button", { name: "Change batch", exact: true }).click();
  const guest = page.getByRole("dialog", { name: "Change the Bean Batch of Guest" });
  await expect(guest.getByRole("option").first()).toHaveAccessibleName("House Espresso, no batch");
  await expect(guest.getByRole("option", { selected: true })).toHaveAccessibleName("House Espresso, no batch");
  await guest.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("a failed read of what a Recipe may use is said where its batches would be: in the Change batch dialog, whose Save waits for them, and in the finished strip; the dialog opened again reads them again", async ({ page }) => {
  const { recipes } = await seed(page);
  // Any one of the Library's lists failing leaves the batches unread, even one that names no batch.
  const tools = (url: URL) => url.pathname === "/api/tools";
  await page.route(tools, (route) => route.fulfill({ status: 503, json: { message: "The Library is not answering" } }));

  // Seeded finished at Riverside, which no other test changes.
  await page.goto(`/library/recipes/${recipes.kenya}`);
  const strip = stripOf(page);
  await expect(strip.getByText("Its Bean Batch is finished at Riverside", { exact: true })).toBeVisible();
  await expect(strip.getByText("The Library is not answering", { exact: true })).toBeVisible();
  await expect(strip.getByText("No other batch of Guest Kenya is at Riverside.", { exact: true })).toHaveCount(0);

  await strip.getByRole("button", { name: "Another batch…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change the Bean Batch of Kenya Filter" });
  await expect(dialog.getByRole("alert")).toHaveText("The Library is not answering");
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.unroute(tools);
  await strip.getByRole("button", { name: "Another batch…", exact: true }).click();
  await expect(dialog.getByRole("group", { name: "At Riverside", exact: true }).getByRole("option").first()).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  // The finished strip has the batches it was waiting for too.
  await expect(strip.getByText("No other batch of Guest Kenya is at Riverside.", { exact: true })).toBeVisible();
  await expect(strip.getByText("The Library is not answering", { exact: true })).toHaveCount(0);
});

test("someone who may not change the Recipe sees the strip without Change batch, Use this batch or Another batch…: a Viewer, and Staff of another Location", async ({ page, browser }) => {
  const { riverside, recipes } = await seed(page);
  const reads = async (theirs: Page, mayChangeRiverside: boolean) => {
    const strip = stripOf(theirs);
    // A batch at its Location: the strip, with its weight, and no button.
    await theirs.goto(`/library/recipes/${recipes.espresso}`);
    await expect(field(strip, "Remaining at Downtown")).toHaveText("3240 g");
    await expect(strip.getByRole("link", { name: words.now(), exact: true })).toBeVisible();
    await expect(strip.getByRole("button")).toHaveCount(0);
    // A batch finished there: the strip and the Bean's other batches there, with no button and no line about a change.
    await theirs.goto(`/library/recipes/${recipes.lungo}`);
    await expect(strip.getByText("Its Bean Batch is finished at Downtown", { exact: true })).toBeVisible();
    await expect(strip.getByRole("listitem").filter({ hasText: "LR-0419" })).toHaveText(`LR-0419roasted ${day(-3)}6000 g here`);
    await expect(strip.getByRole("button")).toHaveCount(0);
    await expect(strip.getByText(/The change reaches every tablet/)).toHaveCount(0);
    // Riverside's Recipe, which Staff working there may change.
    await theirs.goto(`/library/recipes/${recipes.kenya}`);
    await expect(strip.getByText("No other batch of Guest Kenya is at Riverside.", { exact: true })).toBeVisible();
    await expect(strip.getByRole("button")).toHaveText(mayChangeRiverside ? ["Another batch…"] : []);
  };
  await asNew(page, browser, "viewer", undefined, (theirs) => reads(theirs, false));
  await asNew(page, browser, "staff", riverside.id, async (theirs) => {
    await reads(theirs, true);
    // And they pick with it there: the dialog opens for them.
    await stripOf(theirs).getByRole("button", { name: "Another batch…", exact: true }).click();
    await expect(theirs.getByRole("dialog", { name: "Change the Bean Batch of Kenya Filter" }).getByRole("listbox")).toBeVisible();
  });
});

test("the strip, the finished strip and the Change batch dialog read in the dark theme and fit a phone's width", async ({ page }) => {
  const { recipes } = await seed(page);
  const strip = stripOf(page);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto(`/library/recipes/${recipes.espresso}`);
    await expect(page.locator("html")).toHaveClass(colorScheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    for (const [what, text] of [
      ["its label", strip.getByText("Bean Batch", { exact: true })],
      ["its batch", strip.getByRole("link", { name: words.now(), exact: true })],
      ["its code", code(strip, "LR-0411")],
      ["its roast day", strip.getByText(/^Roasted .+ days ago/)],
      ["its weight's label", strip.getByText("Remaining at Downtown", { exact: true })],
      ["its weight", field(strip, "Remaining at Downtown")],
    ] as const) {
      expect(await textContrast(text), `${colorScheme}: ${what}`).toBeGreaterThanOrEqual(4.5);
    }
    // The dialog: its options' lines, the one chosen and its weight.
    await strip.getByRole("button", { name: "Change batch", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const chosen = dialog.getByRole("option", { selected: true });
    const other = dialog.getByRole("option", { name: `${words.plain()}, Not tracked`, exact: true });
    for (const [what, text] of [
      ["a group's heading", dialog.getByText("At Downtown", { exact: true })],
      ["an option's Bean", other.getByText("House Espresso", { exact: true })],
      ["an option's roast day", other.getByText(/^Roasted/)],
      ["an option's weight", other.getByText("Not tracked", { exact: true })],
      ["the chosen option's code", code(chosen, "LR-0411")],
      ["the line under the list", dialog.getByText(/^A batch picked from elsewhere/)],
    ] as const) {
      expect(await textContrast(text), `${colorScheme}: ${what}`).toBeGreaterThanOrEqual(4.5);
    }
    await page.keyboard.press("Escape");

    await page.goto(`/library/recipes/${recipes.lungo}`);
    for (const [what, text] of [
      ["that it is finished", strip.getByText("Its Bean Batch is finished at Downtown", { exact: true })],
      ["when", strip.getByText(/moved to Riverside/)],
      ["what to do", strip.getByText("Pick the next roast of House Espresso here", { exact: true })],
      ["a next roast's day", strip.getByRole("listitem").first().getByText(/^roasted/)],
      ["a next roast's weight", strip.getByRole("listitem").first().getByText(/ here$/)],
      ["the line beside Another batch…", strip.getByText(/^The change reaches every tablet/)],
    ] as const) {
      expect(await textContrast(text), `${colorScheme}: ${what}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });

  // At a phone's width each strip's parts stack, and nothing is wider than the screen, the open dialog included.
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(strip.getByRole("button", { name: "Another batch…", exact: true })).toBeVisible();
  await expectFits(page, 393);
  await page.goto(`/library/recipes/${recipes.espresso}`);
  await expect(field(strip, "Remaining at Downtown")).toBeVisible();
  await expectFits(page, 393);
  expect(await strip.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  await strip.getByRole("button", { name: "Change batch", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("listbox")).toBeVisible();
  await expectFits(page, 393);
  expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  const [frame, save] = await boxes(dialog, dialog.getByRole("button", { name: "Save", exact: true }));
  expect(frame!.x).toBeGreaterThanOrEqual(0);
  expect(frame!.x + frame!.width).toBeLessThanOrEqual(393);
  expect(save!.x + save!.width).toBeLessThanOrEqual(frame!.x + frame!.width);
});
