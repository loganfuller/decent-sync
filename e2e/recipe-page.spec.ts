import { type BrowserContextOptions, expect, type Page, test } from "@playwright/test";
import { useFreshServer } from "./support/fresh-server.js";
import { roastDay } from "./support/days.js";
import { type JudgedShots, date, seedJudgedShots } from "./support/judged-shots.js";
import { boxes } from "./support/layout.js";
import { openCard, recipeActions, rows } from "./support/locators.js";
import { signInAsAdmin } from "./support/seed.js";

// A Recipe's page and the Library's Recipes tab (#547), as an Admin: the
// page's order, how it is pulling first; its Reference Shot's card; By
// Machine, marking what the server judged out of spec (GLOSSARY.md); the
// Reference Shot's duration across the trend; its Shots in one line; its
// History closed until opened; every Location's Recipes in the Library and
// on a Location's page, each with its Reference Shot; and the page at a
// phone's width.
//
// The period control, a Machine's links to the Shots list and the trend's
// numbers are recipe-numbers.spec.ts's to cover; the fields a Recipe has
// set, and its actions, recipe-management.spec.ts's; choosing and clearing
// a Reference Shot, reference-shots.spec.ts's; an item's Shots line on
// another kind's page, shot-links.spec.ts's; and what a Viewer may change,
// viewers.spec.ts's.
//
// The Locations, Machines, Recipes and Shots are those of
// support/judged-shots.ts, which describes them.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

/** A phone as wide as the ticket's: 390 px. */
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/** What the tests after the first read of what it made. */
let lab: JudgedShots["lab"];
let recipes: JudgedShots["recipes"];

test.beforeEach(({ page }) => signInAsAdmin(page));

test("a Recipe's page leads with how it is pulling: its Reference Shot beside its numbers by Machine, marked where out of spec, then its trend against the reference, its fields, its Shots and its History", async ({
  page,
}) => {
  ({ lab, recipes } = await seedJudgedShots(page, server));
  // Its History is read only once it is opened.
  const historyReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/history")) historyReads.push(request.url());
  });

  await page.goto(`/library/recipes/${recipes.house}`);
  const main = page.getByRole("main");
  // Its name, Recipe Slot and Location, and then each part in the order a reader asks.
  await expect(main.getByRole("heading")).toHaveText(["House", "How it is pulling", "Reference Shot", "By Machine", "Trend", "Recipe", "Shots", "History"]);
  await expect(main.getByRole("img", { name: "Slot 2", exact: true })).toHaveText("2");
  await expect(main.getByText("at Lab", { exact: true }).getByRole("link", { name: "Lab" })).toHaveAttribute("href", `/locations/${lab.id}`);
  // Edit stays in view, with moving it to a slot on a wide screen; the rest are in a menu.
  await expect(main.getByRole("button", { name: "Edit the Recipe" })).toBeVisible();
  await expect(main.getByRole("button", { name: "Move to a slot" })).toBeVisible();
  expect(await recipeActions(page)).toEqual(["Take out of its slot", "Copy to a Location", "Archive", "Delete"]);

  // Its Reference Shot: the House's own first Shot on the Left, of 23.549 s and 0.1 g under its target, not rated.
  const reference = page.getByRole("region", { name: "Reference Shot" });
  for (const curve of ["Pressure", "Flow", "Weight"]) await expect(reference.getByRole("img", { name: `${curve} curve of the Reference Shot` }).locator(".recharts-line-curve")).toHaveCount(1);
  await expect(reference.getByText("23.5 s · −0.1 g vs target", { exact: true })).toBeVisible();
  await expect(reference.getByText("Not rated", { exact: true })).toBeVisible();
  await expect(reference.getByText(/^Pulled .+ on Lab Left at Lab · grind \S+$/)).toBeVisible();
  await expect(reference.getByRole("link", { name: "Open its Reference Shot" })).toHaveAttribute("href", "/shots/left-house-1");

  // By Machine, today: the Left's five Shots and one unfinished, their median of 27 s 3.5 s over the reference's, which
  // is out of spec and marked; the Right's three, 1.0 s over, within spec and muted; and the two 2.5 s apart, within spec.
  const byMachine = page.getByRole("region", { name: "By Machine", exact: true });
  const table = byMachine.getByRole("table", { name: "By Machine today" });
  await expect(table.getByRole("columnheader")).toHaveText(["Machine", "Shots", "Duration", "vs reference", "Yield against target", "Stopped at target"]);
  await expect(rows(table)).toHaveText([
    "Lab Left5 · 1 unfinished27.0 s (25.8–27.0)Out of spec: +3.5 s−0.1 g100%",
    "Lab Right324.5 s (24.0–24.5)+1.0 s−0.1 g100%",
    "Between Machines2.5 s apart",
  ]);
  await expect(table.locator("[data-slot=spec-mark]")).toHaveText(["Out of spec: +3.5 s"]);
  for (const muted of ["+1.0 s", "2.5 s apart"]) await expect(table.getByText(muted, { exact: true })).toHaveClass(/text-muted-foreground/);
  await expect(table.getByRole("link", { name: "5 Shots on Lab Left" })).toHaveAttribute("href", /^\/shots\?recipeId=[^&]+&machineId=[^&]+&period=today$/);

  // The trend charts duration, with the Reference Shot's as a dashed, labelled line, named under the chart.
  const trend = page.getByRole("region", { name: "Trend", exact: true });
  const duration = trend.getByRole("figure", { name: "Duration by day" });
  await expect(duration.locator(".recharts-reference-line-line")).toHaveCount(1);
  await expect(duration.locator(".recharts-reference-line-line")).toHaveAttribute("stroke-dasharray", "5 4");
  await expect(duration.getByText("Reference 23.5 s", { exact: true })).toBeVisible();
  const lines = trend.getByRole("list", { name: "Lines" });
  await expect(lines.getByRole("listitem")).toHaveText(["Lab Left", "Lab Right", "Reference Shot23.5 s"]);
  await expect(lines.getByRole("link", { name: "Reference Shot" })).toHaveAttribute("href", "/shots/left-house-1");
  // Another number has no such line.
  await trend.getByRole("tab", { name: "Yield against target" }).click();
  await expect(trend.getByRole("figure", { name: "Yield against target by day" }).locator(".recharts-line-curve")).toHaveCount(2);
  await expect(trend.locator(".recharts-reference-line-line")).toHaveCount(0);
  await expect(lines.getByRole("listitem")).toHaveText(["Lab Left", "Lab Right"]);
  await trend.getByRole("tab", { name: "Duration" }).click();

  // Its Shots are one line: how many it has in the period, the unfinished one among them, and a link that opens
  // them in the Shots list, at its preset of the same days. A period with none still opens the list.
  const shots = page.getByRole("region", { name: "Shots" });
  await expect(shots).toHaveText("Shots9 Shots todayOpen in the Shots list");
  await expect(shots.getByRole("table")).toHaveCount(0);
  await expect(shots.getByRole("link", { name: "Open in the Shots list" })).toHaveAttribute("href", `/shots?recipeId=${recipes.house}&period=today`);
  await page.getByRole("tab", { name: "Yesterday" }).click();
  await expect(shots).toHaveText("ShotsNo Shots yesterdayOpen in the Shots list");
  await expect(shots.getByRole("link", { name: "Open in the Shots list" })).toHaveAttribute("href", `/shots?recipeId=${recipes.house}&period=yesterday`);
  await page.getByRole("tab", { name: "7 days" }).click();
  await expect(shots).toHaveText("Shots9 Shots in the last 7 daysOpen in the Shots list");
  await shots.getByRole("link", { name: "Open in the Shots list" }).click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?recipeId=${recipes.house}&period=7days$`));
  await expect(page.getByText("Shots 1–9 of 9")).toBeVisible();
  await page.goBack();

  // Its History is closed until opened, and reads nothing while closed.
  const history = page.getByRole("region", { name: "History", exact: true });
  await expect(history.getByRole("button", { name: "Show History" })).toBeVisible();
  await expect(history.getByRole("table")).toHaveCount(0);
  expect(historyReads).toEqual([]);
  // The Reference Shot chosen, above its Recipe Slot and the Recipe joining the Library.
  await expect(rows((await openCard(page, "History")).getByRole("table", { name: "History" }))).toHaveText([/Reference ShotThe Shot$/, /Slot at Lab2$/, /NameHouse/]);
  expect(historyReads.length).toBeGreaterThan(0);
});

test("a Recipe with no Reference Shot says so, leads to its rated Shots, and sets no duration against one", async ({ page }) => {
  await page.goto(`/library/recipes/${recipes.decaf}`);
  const reference = page.getByRole("region", { name: "Reference Shot" });
  await expect(reference).toContainText("None chosen. Its rated Shots");
  await expect(reference.getByRole("link", { name: "Its rated Shots" })).toHaveAttribute("href", `/shots?recipeId=${recipes.decaf}&rating=rated`);
  await expect(reference.getByRole("img")).toHaveCount(0);

  // The Left's three Shots, 2.5 g over their target and none stopped at it, each out of spec; the Right's three, of 30 s;
  // and the two 6.5 s apart, out of spec between Machines.
  const byMachine = page.getByRole("region", { name: "By Machine", exact: true });
  const table = byMachine.getByRole("table", { name: "By Machine today" });
  await expect(table.getByRole("columnheader")).toHaveText(["Machine", "Shots", "Duration", "Yield against target", "Stopped at target"]);
  await expect(rows(table)).toHaveText([
    "Lab Left323.5 s (23.5–23.5)Out of spec: +2.5 gOut of spec: 0%",
    "Lab Right330.0 s (30.0–30.0)−0.1 g100%",
    "Between MachinesOut of spec: 6.5 s apart",
  ]);
  await expect(table.locator("[data-slot=spec-mark]")).toHaveCount(3);

  const trend = page.getByRole("region", { name: "Trend", exact: true });
  await expect(trend.getByRole("figure", { name: "Duration by day" }).locator(".recharts-line-curve")).toHaveCount(2);
  await expect(trend.locator(".recharts-reference-line-line")).toHaveCount(0);
  await expect(trend.getByRole("list", { name: "Lines" }).getByRole("listitem")).toHaveText(["Lab Left", "Lab Right"]);
});

test("the Library opens on every Location's Recipes, in Recipe Slot order with those in no slot after, each with its Reference Shot, an Archived Recipe on asking, and a Location's page lists its own the same way", async ({
  page,
}) => {
  // The Guest, in no slot at the Lab, is Archived.
  expect((await page.request.put(`/api/recipes/${recipes.guest}/archived`, { data: { archived: true } })).status()).toBe(200);

  await page.goto("/");
  await page.getByRole("banner").getByRole("link", { name: "Library", exact: true }).click();
  await expect(page).toHaveURL(/\/library\/recipes$/);
  await expect(page.getByRole("heading", { name: "Recipes", level: 1 })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Library" });
  await expect(nav.getByRole("link").first()).toHaveText("Recipes");
  await expect(nav.getByRole("link", { name: "Recipes" })).toHaveAttribute("aria-current", "page");

  // A table for each Location, by name, each linked to its page; one with no Recipes says so.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Depot", "Harbor", "Lab"]);
  await expect(page.getByRole("heading", { name: "Lab", level: 2 }).getByRole("link")).toHaveAttribute("href", `/locations/${lab.id}`);
  await expect(page.getByRole("region", { name: "Recipes at Depot" })).toContainText("No Recipes here yet.");
  await expect(rows(page.getByRole("table", { name: "Recipes at Harbor" }))).toHaveText([/^1Harbor House.*No reference$/]);
  const atLab = page.getByRole("table", { name: "Recipes at Lab" });
  // No Status column (#732): what needs attention is said beside what it is about.
  await expect(atLab.getByRole("columnheader")).toHaveText(["Slot", "Recipe", "Bean Batch", "Profile", "Dose and yield", "Grinder", "Reference Shot"]);
  // The Decaf, in slot 1, with no Reference Shot, and the House, in slot 2, with its batch, linked, over its roast day, and its Reference Shot's duration.
  await expect(rows(atLab)).toHaveText([/^1Decaf-+No reference$/, new RegExp(String.raw`^2HouseGujiRoasted ${roastDay(date(-12))}-+23\.5 s$`)]);
  await expect(atLab.getByRole("link", { name: "Guji", exact: true })).toHaveAttribute("href", /^\/library\/bean-batches\//);
  await expect(atLab.getByRole("link", { name: "House" })).toHaveAttribute("href", `/library/recipes/${recipes.house}`);
  await expect(atLab.getByRole("link", { name: "23.5 s" })).toHaveAttribute("href", "/shots/left-house-1");
  await expect(atLab.getByRole("link", { name: "No reference" })).toHaveAttribute("href", `/shots?recipeId=${recipes.decaf}&rating=rated`);

  // The Archived one shows on asking, which the address keeps: in no slot, after those in one.
  const archived = page.getByRole("checkbox", { name: /^Show archived/ });
  await expect(archived).not.toBeChecked();
  await expect(page.getByText("Show archived (1)")).toBeVisible();
  await archived.click();
  await expect(page).toHaveURL(/\/library\/recipes\?archived=1$/);
  // Archived is said beside its name.
  await expect(rows(atLab)).toHaveText([/^1Decaf/, /^2House/, /^-GuestArchived-+No reference$/]);
  await page.reload();
  await expect(archived).toBeChecked();
  await expect(rows(atLab)).toHaveCount(3);
  await archived.click();
  await expect(page).toHaveURL(/\/library\/recipes$/);
  await expect(rows(atLab)).toHaveCount(2);

  // The Lab's own page lists them with the same column.
  await page.goto(`/locations/${lab.id}`);
  const slots = page.getByRole("region", { name: "Recipes" }).getByRole("table", { name: "Recipe Slots" });
  await expect(slots.getByRole("columnheader")).toHaveText(["Slot", "Recipe", "Bean Batch", "Profile", "Dose and yield", "Grinder", "Reference Shot"]);
  await expect(rows(slots)).toHaveText([/^1Decaf-+No reference$/, /^2House.*23\.5 s$/]);
  await expect(slots.getByRole("link", { name: "23.5 s" })).toHaveAttribute("href", "/shots/left-house-1");

  // An Archived Recipe keeps its Reference Shot, which may be cleared, but none is chosen for it until it is restored:
  // its card offers no other.
  expect((await page.request.put(`/api/recipes/${recipes.guest}/archived`, { data: { archived: false } })).status()).toBe(200);
  expect((await page.request.put(`/api/recipes/${recipes.guest}/reference-shot`, { data: { shotId: "right-guest" } })).status()).toBe(200);
  expect((await page.request.put(`/api/recipes/${recipes.guest}/archived`, { data: { archived: true } })).status()).toBe(200);
  await page.goto(`/library/recipes/${recipes.guest}`);
  const reference = page.getByRole("region", { name: "Reference Shot" });
  await expect(reference.getByRole("link", { name: "Open its Reference Shot" })).toHaveAttribute("href", "/shots/right-guest");
  await expect(reference.getByRole("button", { name: "Clear its Reference Shot" })).toBeVisible();
  await expect(reference.getByRole("link", { name: "Choose another" })).toHaveCount(0);
});

test("on a phone the page's cards stack, By Machine is a block for each Machine, the trend's choice of number scrolls within its own row, and nothing else scrolls sideways", async ({ page, browser }) => {
  const context = await browser.newContext({ baseURL: server.url(), ...PHONE, storageState: await page.context().storageState() });
  try {
    const phone = await context.newPage();
    await phone.goto(`/library/recipes/${recipes.house}`);
    const main = phone.getByRole("main");
    await expect(main.getByRole("heading")).toHaveText(["House", "How it is pulling", "Reference Shot", "By Machine", "Trend", "Recipe", "Shots", "History"]);
    // Edit stays in view; moving it to a slot joins the rest in the menu.
    await expect(main.getByRole("button", { name: "Edit the Recipe" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Move to a slot" })).toBeHidden();
    expect(await recipeActions(phone)).toEqual(["Move to a slot", "Take out of its slot", "Copy to a Location", "Archive", "Delete"]);

    // The Reference Shot's card above By Machine's, each as wide as the page.
    const reference = phone.getByRole("region", { name: "Reference Shot" });
    const byMachine = phone.getByRole("region", { name: "By Machine", exact: true });
    await expect(reference.getByRole("img", { name: "Weight curve of the Reference Shot" }).locator(".recharts-line-curve")).toHaveCount(1);
    const blocks = byMachine.getByRole("list", { name: "By Machine today" }).getByRole("listitem");
    await expect(blocks).toHaveText(
      ["Lab Left5 Shots · 27.0 s (25.8–27.0)Out of spec: +3.5 s vs reference−0.1 g vs target·100% stopped at target1 unfinished", "Lab Right3 Shots · 24.5 s (24.0–24.5)+1.0 s vs reference−0.1 g vs target·100% stopped at target", "Between Machines2.5 s apart"],
    );
    await expect(byMachine.getByRole("table")).toBeHidden();
    await expect(blocks.locator("[data-slot=spec-mark]")).toHaveText(["Out of spec: +3.5 s vs reference"]);
    const [above, below] = await boxes(reference, byMachine);
    expect(above!.y + above!.height).toBeLessThanOrEqual(below!.y);
    expect([above!.x, above!.width]).toEqual([below!.x, below!.width]);

    // The trend's three numbers are in a row of their own, which scrolls where they don't fit, as with longer names
    // or a narrower screen; the page doesn't.
    const trend = phone.getByRole("region", { name: "Trend", exact: true });
    await expect(trend.getByRole("figure", { name: "Duration by day" }).locator(".recharts-reference-line-line")).toHaveCount(1);
    const numbers = trend.getByRole("tablist", { name: "Number" });
    expect(await numbers.evaluate((list) => getComputedStyle(list.parentElement!).overflowX)).toBe("auto");
    await trend.getByRole("tab", { name: "Grind setting" }).click();
    await expect(trend.getByRole("tab", { name: "Grind setting" })).toHaveAttribute("aria-selected", "true");
    await expectFits(phone);

    // Its fields not set, shown, and its History, opened, fit too.
    await phone.getByRole("region", { name: "Recipe", exact: true }).getByRole("button", { name: /^Show the \d+ fields not set$/ }).click();
    await openCard(phone, "History");
    await expectFits(phone);

    // The Library's Recipes fit the page: a table wider than it scrolls within its own frame.
    await phone.goto("/library/recipes");
    await expect(rows(phone.getByRole("table", { name: "Recipes at Lab" }))).toHaveCount(2);
    await expectFits(phone);
  } finally {
    await context.close();
  }
});

/** That the page is as wide as the phone, so nothing of it scrolls sideways. */
async function expectFits(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect({ scrollWidth, clientWidth }, `${new URL(page.url()).pathname} fits the screen`).toEqual({ scrollWidth: PHONE.viewport!.width, clientWidth: PHONE.viewport!.width });
}
