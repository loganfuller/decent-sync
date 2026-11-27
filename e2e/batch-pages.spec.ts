import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { globalIdOf } from "@decent-sync/protocol";
import { shotFixture } from "../server/test/support/shot-fixtures.js";
import { useFreshServer } from "./support/fresh-server.js";
import { boxes } from "./support/layout.js";
import { batchAt, batchLeft, batchLocations, field, rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";

// A Bean Batch's pages as the v1.15.0 mockups lay them out (ticket #726): a
// batch's page in two columns, leading with what is left of it in all and at
// each Location, a bar for each, and a line for each Location it has left;
// Archive and Delete under More; a confirmation before Finish here; Enter
// weight on a Location's page, for those who may use it there; and each page
// as the previous release's server answers it (ADR-0025), in the dark theme
// and at a phone's width. What these pages already did, in their new places,
// is in batch-moves, remaining-weight, batch-lists and batch-codes. Serials
// are made up, from 72601.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

/** What the Machine's tablet holds over derivedDe1Pro()'s: no library. */
const tabletApi = { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] };

type Record_ = Record<string, unknown>;
type Place = Awaited<ReturnType<typeof createLocation>>;

test.beforeEach(({ page }) => signInAsAdmin(page));

/** The Locations every test here uses, made once: the first test of the spec creates them. */
async function locations(page: Page): Promise<Record<"lab" | "downtown" | "riverside" | "belmont", Place>> {
  const { locations: listed } = (await (await page.request.get("/api/locations")).json()) as { locations: Place[] };
  const named = async (name: string) => listed.find((location) => location.name === name) ?? (await createLocation(page, name));
  return { lab: await named("Roastery Lab"), downtown: await named("Downtown"), riverside: await named("Riverside"), belmont: await named("Belmont") };
}

async function post<T>(page: Page, path: string, data: unknown, status = 201): Promise<T> {
  const response = await page.request.post(path, { data });
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()) as T;
}

async function put(page: Page, path: string, data: unknown): Promise<void> {
  const response = await page.request.put(path, { data });
  expect(response.status(), await response.text()).toBe(200);
}

/** A batch of a new Bean of that name, created at the Location with the weight, or untracked with null. */
async function batchOf(page: Page, name: string, location: Place, remainingWeight: number | null, content: Record_ = {}): Promise<string> {
  const { bean } = await post<{ bean: { id: string } }>(page, "/api/beans", { content: { roaster: "Lantern Coffee Roasters", name } });
  const { batch } = await post<{ batch: { id: string } }>(page, "/api/bean-batches", {
    beanId: bean.id,
    content: { roastDate: "2026-11-18", ...content },
    locations: [{ locationId: location.id, remainingWeight }],
  });
  return batch.id;
}

const recipe = (page: Page, location: Place, name: string, beanBatchId: string, slot: number | null) => post(page, "/api/recipes", { locationId: location.id, slot, content: { name, beanBatchId, dose: 20, yield: 46 } });

/** A page signed in as a new account, Staff working at the Location or a Viewer, for `work`. */
async function asNew(page: Page, browser: Browser, role: "staff" | "viewer", location: Place | undefined, work: (page: Page) => Promise<void>) {
  const { link } = await post<{ link: string }>(page, "/api/invites", { email: `${role}-${Date.now()}@example.com`, role, locationIds: location ? [location.id] : [] });
  const context = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await context.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: { name: `New ${role}`, password: "a new account's password" } });
    expect(accepted.status()).toBe(201);
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}

/** How much of a Location's bar is drawn, from 0 to 1, and the name a screen reader gives it. */
async function bar(block: Locator): Promise<{ drawn: number; name: string | null }> {
  const drawn = block.getByRole("img");
  const [whole, filled] = await boxes(drawn, drawn.locator("div"));
  return { drawn: filled!.width / whole!.width, name: await drawn.getAttribute("aria-label") };
}

/** The page is no wider than the screen: what is wider, such as a table, scrolls within it. */
async function expectFits(page: Page, width: number) {
  const measured = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(measured, `${new URL(page.url()).pathname} fits the screen`).toEqual({ scrollWidth: width, clientWidth: width });
}

/** The contrast of two colours as the browser computed them, by WCAG's formula. */
async function contrast(page: Page, first: string, second: string): Promise<number> {
  return page.evaluate(
    ([a, b]) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const luminance = (colour: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = colour;
        context.fillRect(0, 0, 1, 1);
        const [red, green, blue] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((channel) => {
          const value = channel / 255;
          return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
      };
      const [lighter, darker] = [luminance(a!), luminance(b!)].sort((x, y) => y - x);
      return (lighter! + 0.05) / (darker! + 0.05);
    },
    [first, second],
  );
}

test("a batch's page is in two columns on a wide screen and one on a phone, leading with what is left in all and at each Location, with a bar of what stayed there and a line for each Location it has left", async ({ page }) => {
  const { lab, downtown, riverside, belmont } = await locations(page);
  const tablet = await tabletAt(page, server, "Bar Left", downtown, "72601", tabletApi);
  const { bean } = await post<{ bean: { id: string } }>(page, "/api/beans", { content: { roaster: "Lantern Coffee Roasters", name: "Ethiopia Guji Natural" } });
  const { batch } = await post<{ batch: { id: string } }>(page, "/api/bean-batches", {
    beanId: bean.id,
    content: { roastDate: "2026-11-18", batchCode: "LR-0412", weight: 6000, roastLevel: "Light", frozen: false },
    locations: [{ locationId: lab.id, remainingWeight: 6000 }],
  });
  const id = batch.id;
  const move = (from: Place, to: Place, amount: number | "all") => post(page, `/api/bean-batches/${id}/moves`, { fromLocationId: from.id, toLocationId: to.id, amount }, 200);
  // Most of it goes downtown, where two Shots are pulled with it, then part of that on to Riverside; it is added at Belmont and finished there.
  await move(lab, downtown, 5700);
  const local = () => tablet.batches().find((record) => globalIdOf(record) === id)?.id;
  await expect.poll(local).toBeTruthy();
  tablet.pullShot(shotWith("paged-1", "72601", local(), 18.5));
  tablet.pullShot(shotWith("paged-2", "72601", local(), 20));
  await expect.poll(async () => ((await (await page.request.get(`/api/shots?beanBatchId=${id}`)).json()) as { total: number }).total).toBe(2);
  await move(downtown, riverside, 500);
  await put(page, `/api/bean-batches/${id}/locations/${belmont.id}`, { atLocation: true });
  await put(page, `/api/bean-batches/${id}/locations/${belmont.id}`, { atLocation: false });
  await recipe(page, downtown, "Guji Espresso", id, 2);
  await recipe(page, riverside, "Guji Cupping", id, 5);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/library/bean-batches/${id}`);
  const main = page.getByRole("main");
  const whereItIs = page.getByRole("region", { name: "Where it is" });

  // Under the title, the Bean, linked, and its roaster.
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Ethiopia Guji Natural, roasted 2026-11-18LR-0412");
  await expect(main.getByText("Ethiopia Guji Natural, by Lantern Coffee Roasters", { exact: true })).toBeVisible();
  await expect(main.getByText(/A batch of/)).toHaveCount(0);
  await expect(main.getByRole("link", { name: "Ethiopia Guji Natural", exact: true })).toHaveAttribute("href", `/library/beans/${bean.id}`);

  // Two columns: Where it is, Recipes and History in the wider left one, and Roast, Shots and In the Library in the right one.
  const cards = [whereItIs, page.getByRole("region", { name: "Recipes", exact: true }), card(page, "History"), card(page, "Roast"), page.getByRole("region", { name: "Shots" }), card(page, "In the Library")];
  await expect(rows(page.getByRole("table", { name: "History" })).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Shots" })).toContainText("2 Shots");
  const [where, recipes, history, roast, shots, library] = await boxes(...cards);
  for (const left of [recipes, history]) expect(left!.x).toBe(where!.x);
  for (const right of [shots, library]) expect(right!.x).toBe(roast!.x);
  expect(roast!.x).toBeGreaterThan(where!.x + where!.width);
  expect(where!.width).toBeGreaterThan(roast!.width * 1.8);
  expect(roast!.y).toBe(where!.y);
  expect([where!.y < recipes!.y, recipes!.y < history!.y, roast!.y < shots!.y, shots!.y < library!.y]).toEqual([true, true, true, true]);
  await expectFits(page, 1280);

  // It leads with the total, the largest text on the page, and how many Locations it is at, of what was roasted.
  await expect(field(whereItIs, "Remaining in all")).toHaveText("5961.5 g");
  await expect(field(whereItIs, "Total remaining")).toHaveCount(0);
  await expect(whereItIs).toContainText("At 3 Locations, of 6000 g roasted.");
  const size = (locator: Locator) => locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  const total = await size(field(whereItIs, "Remaining in all"));
  expect(total).toBeGreaterThan(await size(main.getByRole("heading", { level: 1 })));
  expect(total).toBeGreaterThan(await size(batchAt(page, "Downtown").getByText("5161.5 g", { exact: true })));

  // Each Location is a block: its name, linked to its page, its weight, its three buttons with Enter weight the filled one, and its line.
  const buttons = "Move to…Enter weightFinish here";
  await expect(batchLocations(page).getByRole("listitem")).toHaveText([
    new RegExp(`^Downtown5161\\.5 g${buttons}5700 g arrived from Roastery Lab .+\\. Since: 2 Shots used 38\\.5 g, 500 g moved to Riverside\\.$`),
    new RegExp(`^Riverside500 g${buttons}500 g arrived from Downtown .+\\. No Shots since\\.$`),
    new RegExp(`^Roastery Lab300 g${buttons}6000 g entered .+ by you\\. Since: 5700 g moved to Downtown\\.$`),
  ]);
  await expect(batchAt(page, "Downtown").getByRole("link", { name: "Downtown", exact: true })).toHaveAttribute("href", `/locations/${downtown.id}`);
  const ground = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).backgroundColor);
  const enter = batchAt(page, "Downtown").getByRole("button", { name: "Enter its weight at Downtown" });
  expect(await ground(enter)).not.toBe(await ground(batchAt(page, "Downtown").getByRole("button", { name: "Finish it at Downtown" })));
  expect(await ground(batchAt(page, "Downtown").getByRole("button", { name: "Move it from Downtown" }))).toBe(await ground(batchAt(page, "Downtown").getByRole("button", { name: "Finish it at Downtown" })));
  const [enterBox, editBox] = await boxes(enter, page.getByRole("button", { name: "Edit the roast" }));
  expect(enterBox!.height).toBe(editBox!.height);

  // The bar is what is left over that plus what Shots there have used: 5161.5 g of 5200 g downtown, the 500 g moved on to Riverside not drawn as used,
  // and full where no Shot has been pulled since, at Riverside, which received its coffee, and at the lab, which sent 5700 g of its 6000 g away.
  const downtownBar = await bar(batchAt(page, "Downtown"));
  expect(downtownBar.name).toBe("5161.5 g left at Downtown, 38.5 g used by Shots there");
  expect(downtownBar.drawn).toBeCloseTo(5161.5 / 5200, 2);
  expect(await bar(batchAt(page, "Riverside"))).toEqual({ drawn: 1, name: "500 g left at Riverside, 0 g used by Shots there" });
  expect(await bar(batchAt(page, "Roastery Lab"))).toEqual({ drawn: 1, name: "300 g left at Roastery Lab, 0 g used by Shots there" });

  // The Location it was finished at has one muted line, its name linked.
  await expect(batchLeft(page)).toHaveText([/^BelmontFinished \S/]);
  await expect(batchLeft(page).getByRole("link", { name: "Belmont" })).toHaveAttribute("href", `/locations/${belmont.id}`);

  // The line's count of Shots opens the batch's Shots at that Location in the Shots list.
  await batchAt(page, "Downtown").getByRole("link", { name: "2 Shots", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?beanBatchId=${id}&locationId=${downtown.id}$`));
  await expect(rows(page.getByRole("table", { name: "Shots" }))).toHaveCount(2);
  await page.goBack();

  // The Roast card: its Batch Code and roast date always, each other field only where it has a value, Frozen only when yes, and the roasted weight so named.
  const roastCard = page.getByLabel("Roast", { exact: true });
  await expect(roastCard.getByRole("term")).toHaveText(["Batch Code", "Roast date", "Roast level", "Roasted weight"]);
  await expect(field(roastCard, "Roasted weight")).toHaveText("6000 g");
  // Edit opens every field, and what it saves shows.
  await page.getByRole("button", { name: "Edit the roast" }).click();
  const form = page.getByRole("form", { name: "Edit the roast" });
  for (const label of ["Batch Code", "Roast date", "Roast level", "Harvest", "Quality score", "Price", "Currency", "Roasted weight (g)", "Bought", "Opened", "Best before", "Frozen", "Frozen on", "Thawed on", "Notes"]) {
    await expect(form.getByLabel(label, { exact: true }), label).toBeVisible();
  }
  await form.getByLabel("Frozen", { exact: true }).check();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(roastCard.getByRole("term")).toHaveText(["Batch Code", "Roast date", "Roast level", "Roasted weight", "Frozen"]);
  await expect(field(roastCard, "Frozen")).toHaveText("Yes");
  // Shots and In the Library read as they did.
  await expect(page.getByRole("region", { name: "Shots" }).getByRole("link", { name: "Open in the Shots list" })).toHaveAttribute("href", `/shots?beanBatchId=${id}`);
  await expect(card(page, "In the Library").getByRole("term")).toHaveText(["Created at", "Joined"]);
  // Created here, on no tablet, it names no Location it was created at.
  await expect(field(card(page, "In the Library"), "Created at")).toHaveText("-");

  // In the dark theme the bar still tells what is left from what is used, and the total reads on its card.
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveClass(colorScheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    const drawn = batchAt(page, "Downtown").getByRole("img");
    expect(await contrast(page, await ground(drawn.locator("div")), await ground(drawn)), `${colorScheme}: the bar`).toBeGreaterThanOrEqual(3);
    const totalColour = await field(whereItIs, "Remaining in all").evaluate((element) => getComputedStyle(element).color);
    expect(await contrast(page, totalColour, await ground(whereItIs)), `${colorScheme}: the total`).toBeGreaterThanOrEqual(4.5);
  }
  await page.emulateMedia({ colorScheme: "light" });

  // Moved away from Riverside entirely, its line says the move took it and where to, and its Recipe there is marked beside the Location's name.
  await move(riverside, downtown, "all");
  await page.reload();
  await expect(batchLeft(page)).toHaveText([/^BelmontFinished \S/, /^RiversideMoved to Downtown \S/]);
  await expect(whereItIs).toContainText("At 2 Locations, of 6000 g roasted.");
  const naming = page.getByRole("table", { name: "Recipes naming this batch" });
  await expect(naming.getByRole("columnheader")).toHaveText(["Recipe", "Location", "Recipe Slot", "Dose and yield"]);
  await expect(rows(naming)).toHaveText(["Guji EspressoDowntown220 g → 46 g", "Guji CuppingRiversideBatch finished there520 g → 46 g"]);
  // The History card is the table it was, a move one line of it.
  await expect(page.getByRole("table", { name: "History" }).getByRole("columnheader")).toHaveText(["Made", "By", "Changed"]);
  await expect(rows(page.getByRole("table", { name: "History" })).first()).toContainText("Batch MoveMoved all, 500 g, from Riverside to Downtown");

  // At a phone's width they are one column, the left column's cards first, the buttons wrapped under the weight, and nothing wider than the screen.
  await page.setViewportSize({ width: 393, height: 852 });
  const stacked = await boxes(...cards);
  for (const each of stacked) expect(each!.x).toBe(stacked[0]!.x);
  expect(stacked.map((each) => each!.y)).toEqual([...stacked.map((each) => each!.y)].sort((a, b) => a - b));
  const [weightBox, moveBox] = await boxes(batchAt(page, "Downtown").getByText("5661.5 g", { exact: true }), batchAt(page, "Downtown").getByRole("button", { name: "Move it from Downtown" }));
  expect(moveBox!.y).toBeGreaterThanOrEqual(weightBox!.y + weightBox!.height);
  await expectFits(page, 393);
  // Its History scrolls sideways in its card there, what each row changed keeping a width it can be read in.
  const changed = await rows(page.getByRole("table", { name: "History" })).first().getByRole("cell").nth(2).boundingBox();
  expect(changed!.width).toBeGreaterThanOrEqual(256);
  // So are the list of batches, whose toolbar wraps, and a Location's page with its batches.
  await page.goto("/library/bean-batches");
  await expect(rows(page.getByRole("table", { name: "Bean Batches" })).first()).toBeVisible();
  await expectFits(page, 393);
  await page.goto(`/locations/${downtown.id}`);
  await expect(rows(page.getByRole("table", { name: "Bean Batches here" })).first()).toBeVisible();
  await expectFits(page, 393);
});

test("Archive and Delete are under More beside a batch's name, each asking first: an Admin has both, Staff only Archive, and a Viewer no menu", async ({ page, browser }) => {
  const { downtown, riverside } = await locations(page);
  const id = await batchOf(page, "Menu Kenya", downtown, 1000, { batchCode: "LR-0500" });
  const menu = async (of: Page) => {
    await of.getByRole("main").getByRole("button", { name: "More", exact: true }).click();
    await expect(of.getByRole("menu")).toBeVisible();
    return of.getByRole("menuitem");
  };

  await page.goto(`/library/bean-batches/${id}`);
  // No row of buttons of their own: both are in the menu, at the right of the title.
  await expect(page.getByRole("main").getByRole("button", { name: /^(Archive|Delete)$/ })).toHaveCount(0);
  const [title, more] = await boxes(page.getByRole("heading", { level: 1 }), page.getByRole("main").getByRole("button", { name: "More", exact: true }));
  expect(more!.x).toBeGreaterThan(title!.x + title!.width);
  expect(more!.y).toBeLessThan(title!.y + title!.height);
  await expect(await menu(page)).toHaveText(["Archive", "Delete"]);

  // Archive asks first; cancelled, nothing changes, and the focus is back on More.
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  const archiving = page.getByRole("alertdialog", { name: "Archive Menu Kenya, roasted 2026-11-18?" });
  await expect(archiving).toContainText("It is offered nowhere from now on, and archived on every tablet that holds it, but kept, so past Shots still name it. It can be restored.");
  await archiving.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("main").getByRole("button", { name: "More", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { level: 1 })).not.toContainText("Archived");
  // Confirmed, it is Archived, and the menu restores it.
  await (await menu(page)).filter({ hasText: "Archive" }).click();
  await archiving.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Archived");
  await expect(await menu(page)).toHaveText(["Restore", "Delete"]);
  await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).not.toContainText("Archived");

  // Staff, working at any Location, have Archive and no Delete; a Viewer has no menu.
  await asNew(page, browser, "staff", riverside, async (samsPage) => {
    await samsPage.goto(`/library/bean-batches/${id}`);
    await expect(await menu(samsPage)).toHaveText(["Archive"]);
  });
  await asNew(page, browser, "viewer", undefined, async (valsPage) => {
    await valsPage.goto(`/library/bean-batches/${id}`);
    await expect(batchAt(valsPage, "Downtown")).toBeVisible();
    await expect(valsPage.getByRole("main").getByRole("button", { name: "More", exact: true })).toHaveCount(0);
  });

  // Delete asks first too, and, confirmed, leaves for the list, which no longer has the batch.
  await (await menu(page)).filter({ hasText: "Delete" }).click();
  const deleting = page.getByRole("alertdialog", { name: "Delete Menu Kenya, roasted 2026-11-18?" });
  await expect(deleting).toContainText("It is deleted from every tablet that holds it, now or once it connects, and cannot be restored. Only an item no Shot names can be deleted; Archive any other.");
  await deleting.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Menu Kenya");
  await (await menu(page)).filter({ hasText: "Delete" }).click();
  await deleting.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/library\/bean-batches$/);
  expect((await page.request.get(`/api/bean-batches/${id}`)).status()).toBe(404);
});

test("Finish here asks first, naming the batch and what finishing does, and changes nothing when cancelled", async ({ page }) => {
  const { downtown, riverside } = await locations(page);
  const id = await batchOf(page, "Finish Guji", downtown, 2920, { batchCode: "LR-0412F" });
  await put(page, `/api/bean-batches/${id}/locations/${riverside.id}`, { atLocation: true });
  await recipe(page, downtown, "Finish Espresso", id, 3);
  await recipe(page, downtown, "Finish Long", id, null);

  await page.goto(`/library/bean-batches/${id}`);
  const whereItIs = page.getByRole("region", { name: "Where it is" });
  await whereItIs.getByRole("button", { name: "Finish it at Downtown" }).click();
  const asking = page.getByRole("alertdialog", { name: "Finish this batch at Downtown?" });
  // It names the batch, with its Batch Code, and what Downtown has of it, then what finishing does, in a move of all's lines.
  await expect(asking).toContainText("Finish Guji, roasted 2026-11-18 (LR-0412F). Downtown has 2920 g of it.");
  await expect(asking.getByRole("listitem")).toHaveText([
    "Downtown stops listing the batch, and its tablets stop offering it.",
    "The 2920 g there goes with it. No other Location's weight changes.",
    '2 Recipes at Downtown name it and will go on naming it. The one in a Recipe Slot will read "Batch finished here".',
  ]);
  await expect(asking).toContainText("To send what is left to another Location, cancel and use Move to… instead.");
  await expect(asking.getByRole("button")).toHaveText(["Cancel", "Finish at Downtown"]);

  // Cancelled, the batch is where it was, with its weight, and its history has no finish.
  await asking.getByRole("button", { name: "Cancel" }).click();
  await expect(asking).toHaveCount(0);
  await expect(batchAt(page, "Downtown")).toContainText("Downtown2920 g");
  await expect(field(whereItIs, "Remaining in all")).toHaveText("2920 g");
  const { batch } = (await (await page.request.get(`/api/bean-batches/${id}`)).json()) as { batch: { locations: { location: Place }[]; finished: unknown[] } };
  expect([batch.locations.map((here) => here.location.name), batch.finished]).toEqual([["Downtown", "Riverside"], []]);

  // An untracked batch that no Recipe names there: the weight and the Recipes lines are left out.
  await whereItIs.getByRole("button", { name: "Finish it at Riverside" }).click();
  const untracked = page.getByRole("alertdialog", { name: "Finish this batch at Riverside?" });
  await expect(untracked).toContainText("Finish Guji, roasted 2026-11-18 (LR-0412F). It is at Riverside, with no weight entered there.");
  await expect(untracked.getByRole("listitem")).toHaveText(["Riverside stops listing the batch, and its tablets stop offering it."]);
  await untracked.getByRole("button", { name: "Cancel" }).click();

  // Confirmed, it finishes the batch there, as it did.
  await whereItIs.getByRole("button", { name: "Finish it at Downtown" }).click();
  await asking.getByRole("button", { name: "Finish at Downtown" }).click();
  await expect(batchAt(page, "Downtown")).toHaveCount(0);
  await expect(batchLeft(page)).toHaveText([/^DowntownFinished \S/]);
  await expect(field(whereItIs, "Remaining in all")).toHaveText("Not tracked");
  await expect(whereItIs).toContainText("At 1 Location, none with a weight.");
  await expect(rows(page.getByRole("table", { name: "History" })).first()).toContainText("At DowntownNo");
  await expect(rows(page.getByRole("table", { name: "Recipes naming this batch" }))).toHaveText([/^Finish EspressoDowntownBatch finished there3/, /^Finish LongDowntownBatch finished thereNo slot/]);
});

test("a Location's Bean Batches card has Enter weight on each row for an Admin and Staff who work there, which starts tracking, corrects a weight and finishes with zero, and not for a Viewer or Staff of another Location", async ({ page, browser }) => {
  const { belmont, riverside } = await locations(page);
  const tracked = await batchOf(page, "Row Kenya", belmont, 2920, { batchCode: "LR-0416" });
  await batchOf(page, "Row House", belmont, null);

  await page.goto(`/locations/${belmont.id}`);
  const here = page.getByRole("region", { name: "Bean Batches", exact: true });
  const listed = here.getByRole("table", { name: "Bean Batches here" });
  const row = (bean: string) => rows(listed).filter({ hasText: bean });
  await expect(listed.getByRole("columnheader")).toHaveText(["Batch", "Batch Code", "Remaining here", "Since then", "Recipes here", "Enter its weight"]);
  await expect(row("Row Kenya")).toHaveText(/^Row KenyaRoasted 2026-11-18LR-04162920 gof 2920 g entered .+No Shots sinceNothing movedNoneEnter weight$/);
  await expect(row("Row House")).toHaveText("Row HouseRoasted 2026-11-18-Not trackedNo weight enteredShotsNoneEnter weight");
  // Move to… and Finish here stay on the batch's page.
  await expect(listed.getByRole("button")).toHaveText(["Enter weight", "Enter weight"]);

  // On an untracked row it is how tracking starts here: the same dialog, naming the batch and the Location.
  await listed.getByRole("button", { name: "Enter the weight of Row House, roasted 2026-11-18" }).click();
  const entering = page.getByRole("dialog", { name: "Enter weight at Belmont" });
  await expect(entering).toContainText("Row House, roasted 2026-11-18. What is left of it at Belmont now, as weighed.");
  await expect(entering.getByRole("status")).toHaveText("Left empty, the batch is not tracked at Belmont.");
  await entering.getByLabel("Remaining weight (g)", { exact: true }).fill("750");
  await entering.getByRole("button", { name: "Save" }).click();
  await expect(row("Row House")).toHaveText(/^Row HouseRoasted 2026-11-18-750 gof 750 g entered .+No Shots sinceNothing movedNoneEnter weight$/);
  await expect(here).toContainText("2 batches here, 2 with a weight");

  // A weight that differs from the one worked out says by how much before it is saved, and the weight saved shows in the row.
  await listed.getByRole("button", { name: "Enter the weight of Row Kenya, roasted 2026-11-18" }).click();
  await expect(entering).toContainText("Row Kenya, roasted 2026-11-18 (LR-0416). What is left of it at Belmont now, as weighed.");
  await expect(entering.getByLabel("Remaining weight (g)", { exact: true })).toHaveValue("2920");
  await entering.getByLabel("Remaining weight (g)", { exact: true }).fill("292");
  await expect(entering.getByRole("status")).toHaveText("2628 g less than the 2920 g worked out.");
  await entering.getByLabel("Remaining weight (g)", { exact: true }).fill("2780");
  await expect(entering.getByRole("status")).toHaveText("140 g less than the 2920 g worked out.");
  await entering.getByRole("button", { name: "Save" }).click();
  await expect(row("Row Kenya")).toContainText("2780 gof 2780 g entered");

  // Staff who work here have it, and Staff who work elsewhere and a Viewer read the table without the column.
  await asNew(page, browser, "staff", belmont, async (samsPage) => {
    await samsPage.goto(`/locations/${belmont.id}`);
    const sams = samsPage.getByRole("table", { name: "Bean Batches here" });
    await expect(sams.getByRole("button", { name: /^Enter the weight of / })).toHaveCount(2);
    // A weight of zero finishes the batch here, with no second confirmation, and its row leaves the list.
    await sams.getByRole("button", { name: "Enter the weight of Row House, roasted 2026-11-18" }).click();
    const samsDialog = samsPage.getByRole("dialog", { name: "Enter weight at Belmont" });
    await samsDialog.getByLabel("Remaining weight (g)", { exact: true }).fill("0");
    await expect(samsDialog.getByRole("status")).toHaveText("A weight of 0 finishes the batch at Belmont.");
    await samsDialog.getByRole("button", { name: "Finish here" }).click();
    await expect(samsDialog).toHaveCount(0);
    await expect(samsPage.getByRole("alertdialog")).toHaveCount(0);
    await expect(rows(sams)).toHaveText([/^Row Kenya/]);
  });
  for (const [role, location] of [["staff", riverside], ["viewer", undefined]] as const) {
    await asNew(page, browser, role, location, async (othersPage) => {
      await othersPage.goto(`/locations/${belmont.id}`);
      const others = othersPage.getByRole("region", { name: "Bean Batches", exact: true });
      await expect(rows(others.getByRole("table", { name: "Bean Batches here" }))).toHaveText([/^Row KenyaRoasted 2026-11-18LR-04162780 gof 2780 g entered .+No Shots sinceNothing movedNone$/]);
      await expect(others.getByRole("columnheader")).toHaveText(["Batch", "Batch Code", "Remaining here", "Since then", "Recipes here"]);
      await expect(others.getByRole("button", { name: /Enter/ })).toHaveCount(0);
    });
  }
  // Left empty, it clears the weight, and the row stays, not tracked.
  await page.reload();
  await listed.getByRole("button", { name: "Enter the weight of Row Kenya, roasted 2026-11-18" }).click();
  await entering.getByLabel("Remaining weight (g)", { exact: true }).fill("");
  await entering.getByRole("button", { name: "Save" }).click();
  await expect(rows(listed)).toHaveText(["Row KenyaRoasted 2026-11-18LR-0416Not trackedNo weight enteredShotsNoneEnter weight"]);
  expect(((await (await page.request.get(`/api/bean-batches/${tracked}`)).json()) as { batch: { locations: { remainingWeight: number | null }[] } }).batch.locations.map((at) => at.remainingWeight)).toEqual([null]);
});

test("each page reads the previous release's server, as during a deploy: a batch's page with no bar, line or Recipes card, its weights summed, and a Location's page without its batches", async ({ page }) => {
  const { downtown, riverside } = await locations(page);
  const id = await batchOf(page, "Deploy Sidra", downtown, 800, { batchCode: "LR-0600", weight: 1000 });
  await post(page, `/api/bean-batches/${id}/moves`, { fromLocationId: downtown.id, toLocationId: riverside.id, amount: 300 }, 200);
  await put(page, `/api/bean-batches/${id}/locations/${riverside.id}`, { atLocation: false });

  // The previous release answers a batch with no total, and each Location with no count of what its weight starts from, what was used or what was moved;
  // it lists no Recipes, its history names no move, and it has no list of a Location's batches.
  const older = ({ entered: _entered, used: _used, moved: _moved, ...here }: Record_) => here;
  const stripped = ({ totalRemainingWeight: _total, recipes: _recipes, locations, ...batch }: Record_) => ({ ...batch, locations: (locations as Record_[]).map(older) });
  await page.route(`**/api/bean-batches/${id}`, async (route) => {
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { batch: stripped(((await answer.json()) as { batch: Record_ }).batch) } });
  });
  await page.route("**/api/bean-batches", async (route) => {
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { batches: ((await answer.json()) as { batches: Record_[] }).batches.map(stripped) } });
  });
  await page.route(`**/api/bean-batches/${id}/history`, async (route) => {
    const answer = await route.fetch();
    const { versions } = (await answer.json()) as { versions: Record_[] };
    await route.fulfill({ response: answer, json: { versions: versions.map(({ move: _move, ...version }) => version) } });
  });
  await page.route("**/api/locations/*/bean-batches", (route) => route.fulfill({ status: 404, json: { statusCode: 404, message: "Cannot GET /api/locations/x/bean-batches", error: "Not Found" } }));

  await page.goto(`/library/bean-batches/${id}`);
  const whereItIs = page.getByRole("region", { name: "Where it is" });
  // The total is the sum of the weights it gave; the block has its weight and buttons, and no bar and no line.
  await expect(field(whereItIs, "Remaining in all")).toHaveText("500 g");
  await expect(whereItIs).toContainText("At 1 Location, of 1000 g roasted.");
  await expect(batchLocations(page).getByRole("listitem")).toHaveText(["Downtown500 gMove to…Enter weightFinish here"]);
  await expect(batchAt(page, "Downtown").getByRole("img")).toHaveCount(0);
  await expect(batchLeft(page)).toHaveText([/^RiversideFinished \S/]);
  await expect(page.getByRole("region", { name: "Recipes", exact: true })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "History" })).toBeVisible();
  // The confirmation before Finish here says nothing of Recipes it was not told of.
  await whereItIs.getByRole("button", { name: "Finish it at Downtown" }).click();
  const asking = page.getByRole("alertdialog", { name: "Finish this batch at Downtown?" });
  await expect(asking.getByRole("listitem")).toHaveText(["Downtown stops listing the batch, and its tablets stop offering it.", "The 500 g there goes with it. No other Location's weight changes."]);
  await asking.getByRole("button", { name: "Cancel" }).click();
  // Enter weight still says how far a weight typed is from the one it reads.
  await whereItIs.getByRole("button", { name: "Enter its weight at Downtown" }).click();
  const entering = page.getByRole("dialog", { name: "Enter weight at Downtown" });
  await entering.getByLabel("Remaining weight (g)", { exact: true }).fill("50");
  await expect(entering.getByRole("status")).toHaveText("450 g less than the 500 g worked out.");
  await entering.getByRole("button", { name: "Cancel" }).click();

  // The list sums the weights too, and a Location's page goes without its Bean Batches card.
  await page.goto("/library/bean-batches");
  await expect(rows(page.getByRole("table", { name: "Bean Batches" })).filter({ hasText: "Deploy Sidra" })).toHaveText("Deploy Sidra, roasted 2026-11-18LR-0600Lantern Coffee RoastersDowntown 500 g500 g");
  await page.goto(`/locations/${downtown.id}`);
  await expect(page.getByRole("region", { name: "Recipes", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Bean Batches", exact: true })).toHaveCount(0);
});

/** A card of a batch's page that is no region, by its heading. */
function card(page: Page, heading: string): Locator {
  return page.locator('[data-slot="card"]').filter({ has: page.getByRole("heading", { name: heading, exact: true, level: 2 }) });
}

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
