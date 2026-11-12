import { expect, type Locator, type Page, test } from "@playwright/test";
import { preheatShotFixture, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { farFromMidnight } from "./support/calendar.js";
import { useFreshServer } from "./support/fresh-server.js";
import { rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// A Recipe's page (#474), as an Admin: today's numbers on each Machine,
// with its Reference Shot's beside them, and its trend over the last 30
// days, a line for each Machine.
//
// Simulated tablets running the built plugin backfill eleven Shots on two
// Machines at the Lab, each derived from one of two Shots Decaid recorded,
// changing only its id, time, recorded hardware, grind setting and what the
// table names. The Recipes are made through the REST API once the tablets
// are unloaded, so none is written to one, and each Shot's Recipe is then
// set in PostgreSQL, with each Machine's Loaded Recipes: how a tablet's map
// and its Workflow make them is shot-recipe-links.spec.ts's to cover. The
// real Shots weighed 0.1 g and 1.3 g under their targets, ran 23.549 s and
// 25.833 s after their Preheat, and stopped on weight. Hardware ids are
// made up.
//
// | Shot | Machine | Pulled, on the Lab's wall clock | Recipe | Grind | What it is |
// |---|---|---|---|---|---|
// | left-today-1 | Lab Left | today 01:00 | House | 8.8 | −0.1 g, 23.549 s |
// | left-today-2 | Lab Left | today 01:10 | House | 9 | −1.3 g, 25.833 s |
// | left-today-unfinished | Lab Left | today 01:20 | House | 9 | stopped at once: an Unfinished Shot |
// | right-today | Lab Right | today 01:05 | House | 8.5 | +2.5 g, 23.549 s, ended by the Machine |
// | right-none | Lab Right | today 02:00 | none | 8.5 | −0.1 g, 23.549 s |
// | left-tea | Lab Left | yesterday 08:00 | Tea | 1.1.0 | −0.1 g, 23.549 s |
// | left-2-days | Lab Left | 2 days ago 08:00 | House | 9.2 | −1.3 g, 25.833 s |
// | right-5-days-1 | Lab Right | 5 days ago 08:00 | House | 8.4 | −0.1 g, 23.549 s |
// | right-5-days-2 | Lab Right | 5 days ago 09:00 | House | 8.6 | −1.3 g, 25.833 s |
// | left-29-days | Lab Left | 29 days ago 08:00 | House | 10 | −0.1 g, 23.549 s: the trend's first day |
// | left-30-days | Lab Left | 30 days ago 08:00 | House | 10 | before the trend |
//
// The days are counted back from today, so the Lab is where no day begins
// while this runs (`farFromMidnight`).
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

const HOUR = 3_600_000;

/** The Lab's time zone, and how many hours it is ahead of UTC. */
const { zone: ZONE, ahead: AHEAD } = farFromMidnight();

const LEFT = "10081";
const RIGHT = "10082";

type Fields = Record<string, unknown>;

/** A day at the Lab, `days` from today there, as a UTC date at its midnight on the wall clock. */
function day(days: number): Date {
  const today = new Date(Date.now() + AHEAD * HOUR);
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days));
}

/** The moment the Lab's wall clock read a time on a day `days` from today. */
function at(days: number, hours: number, minutes = 0): string {
  return new Date(day(days).getTime() + (hours - AHEAD) * HOUR + minutes * 60_000).toISOString();
}

/** A day at the Lab as an address names it, such as 2026-11-11. */
const date = (days: number) => day(days).toISOString().slice(0, 10);

/** A day at the Lab as the Shots list's date fields show it, such as "Nov 11, 2026". */
const dateText = (days: number) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(day(days));

/** A day at the Lab as a trend names it, such as "Wed, Nov 11, 2026". */
const dayTitle = (days: number) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(day(days));

/** What a test changes of a fixture's record. */
interface Changes {
  actualYield?: number;
  stopReason?: string;
  /** Stopped at once, in its preinfusion, before anything poured: its first two samples alone. */
  unfinished?: boolean;
}

/** A Shot pulled at a UTC time on the hardware given, at the grind setting given, derived from `fixture` with the changes given. */
function shotOf(id: string, pulledAt: string, serial: string, grinderSetting: string | number, changes: Changes = {}, fixture = shotFixture()): Fields {
  const workflow = fixture.workflow as Record<string, Fields>;
  return {
    ...fixture,
    id,
    timestamp: pulledAt,
    ...(changes.stopReason !== undefined && { stopReason: changes.stopReason }),
    ...(changes.unfinished && { measurements: (fixture.measurements as Fields[]).slice(0, 2) }),
    workflow: {
      ...workflow,
      context: { ...workflow.context, grinderSetting },
      machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial },
    },
    annotations: { ...(fixture.annotations as Fields), ...(changes.actualYield !== undefined && { actualYield: changes.actualYield }) },
  };
}

/** What the tests after the first read of what it made. */
let machines: Record<"left" | "right", { id: string; token: string }>;
let recipes: Record<"house" | "tea" | "idle", string>;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("today's numbers are each Machine's, as the Shot Summary of its filters gives them, with the Reference Shot's under them where the Recipe has one", async ({ page }) => {
  await seed(page);

  await page.goto(`/library/recipes/${recipes.house}`);
  const today = page.getByRole("region", { name: "Today", exact: true });
  await expectTip(today, "Today", /^How its Shots went today on each Machine that pulled it, today being its Location's day, in its time zone\./);
  const table = today.getByRole("table", { name: "Today by Machine" });
  await expect(table.getByRole("columnheader")).toHaveText(["Machine", "Shots", "Duration", "Yield against target", "Stopped on weight"]);
  // The Left's two Shots, −0.1 g and −1.3 g, 23.549 s and 25.833 s, both stopped on weight, and one unfinished; the
  // Right's one, 2.5 g over and ended by the Machine. The Shot it pulled with no Recipe, and the days before, are in neither.
  await expect(rows(table)).toHaveText(["Lab Left2 Shots · 1 unfinished24.7 s (24.1–25.3)−0.7 g (−1.0 to −0.4)100%", "Lab Right1 Shot23.5 s (23.5–23.5)+2.5 g (+2.5 to +2.5)0%"]);
  await expect(table.getByRole("link", { name: "Lab Left" })).toHaveAttribute("href", `/machines/${machines.left.id}`);

  // Each is what the Shot Summary gives for the Recipe, the Machine and today.
  for (const [machine, counts, duration, against, share] of [
    [machines.left, { shots: 2, unfinished: 1, cleaningAndCalibration: 0 }, 24.691, -0.7, 1],
    [machines.right, { shots: 1, unfinished: 0, cleaningAndCalibration: 0 }, 23.549, 2.5, 0],
  ] as const) {
    const filters = `recipeId=${recipes.house}&machineId=${machine.id}&from=${date(0)}&to=${date(0)}`;
    const summary = (await (await page.request.get(`/api/shots/summary?${filters}`)).json()) as { groups: { counts: Fields; numbers: Record<string, { median?: number; share?: number }> }[] };
    expect(summary.groups[0]!.counts).toMatchObject(counts);
    expect(summary.groups[0]!.numbers.duration!.median).toBeCloseTo(duration, 6);
    expect(summary.groups[0]!.numbers.yieldAgainstTarget!.median).toBeCloseTo(against, 6);
    expect(summary.groups[0]!.numbers.stoppedOnWeight!.share).toBe(share);
  }

  // It has no Reference Shot, and so no row for one.
  await expect(page.getByRole("region", { name: "Reference Shot" }).getByText("None chosen.")).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(3);

  // Read against a Shot pulled two days ago, which ran 25.833 s and weighed 1.3 g under its target.
  expect((await page.request.put(`/api/recipes/${recipes.house}/reference-shot`, { data: { shotId: "left-2-days" } })).status()).toBe(200);
  await page.reload();
  await expect(rows(table)).toHaveText([/^Lab Left2 Shots/, /^Lab Right1 Shot/, "Reference Shot25.8 s−1.3 g"]);
  await expect(table.getByRole("link", { name: "Reference Shot" })).toHaveAttribute("href", "/shots/left-2-days");

  // Cleared on the page, it is gone from under the numbers at once.
  await page.getByRole("button", { name: "Clear its Reference Shot" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Clear it" }).click();
  await expect(page.getByRole("region", { name: "Reference Shot" }).getByText("None chosen.")).toBeVisible();
  await expect(rows(table)).toHaveText([/^Lab Left2 Shots/, /^Lab Right1 Shot/]);
});

test("a Machine's count opens its Shots of the Recipe today in the Shots list, with the Recipe, the Machine and the day as filters", async ({ page }) => {
  await page.goto(`/library/recipes/${recipes.house}`);
  const count = page.getByRole("region", { name: "Today", exact: true }).getByRole("link", { name: "2 Shots" });
  const filters = `recipeId=${recipes.house}&machineId=${machines.left.id}&from=${date(0)}&to=${date(0)}`;
  await expect(count).toHaveAttribute("href", `/shots?${filters}`);
  await count.click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?${filters}$`));
  // The two its numbers cover and the unfinished one.
  await expect(rows(page.getByRole("table", { name: "Shots" }))).toHaveCount(3);
  const chosen = page.getByRole("region", { name: "Filters" });
  await expect(chosen.getByRole("combobox", { name: "Machine", exact: true })).toHaveText("Lab Left");
  await expect(chosen.getByRole("combobox", { name: "Recipe", exact: true })).toHaveText("House, Lab");
  await expect(chosen.getByRole("button", { name: "From", exact: true })).toHaveText(dateText(0));
  await expect(chosen.getByRole("button", { name: "To", exact: true })).toHaveText(dateText(0));
});

test("the trend charts the last 30 days by day, a line for each Machine with its middle half's band, for duration, yield against target and grind setting, one at a time", async ({
  page,
}) => {
  await page.goto(`/library/recipes/${recipes.house}`);
  const trend = page.getByRole("region", { name: "Trend", exact: true });
  await expectTip(trend, "Trend", /^How its Shots moved over the last 30 days, by day, on each Machine that pulled it\./);
  // Duration, until another is chosen.
  await expect(trend.getByRole("tab")).toHaveText(["Duration", "Yield against target", "Grind setting"]);
  await expect(trend.getByRole("tab", { name: "Duration" })).toHaveAttribute("aria-selected", "true");
  const duration = trend.getByRole("figure", { name: "Duration by day" });
  await expect(duration.locator("figcaption")).toHaveText("Duration (s)");
  // A line and a band for each Machine: the Left's three days and the Right's two, each marked.
  await expect(duration.locator(".recharts-line-curve")).toHaveCount(2);
  await expect(duration.locator(".recharts-area-area")).toHaveCount(2);
  await expect(duration.locator(".recharts-line-dot")).toHaveCount(5);
  await expect(trend.getByRole("list", { name: "Lines" }).getByRole("listitem")).toHaveText(["Lab Left", "Lab Right"]);
  // The 30 days end today: the Shot pulled 29 days ago is the first day's, and the one pulled 30 days ago is in none.
  await expect(await numbers(trend, "Duration by day")).toHaveText([
    `${dayTitle(-29)}Lab Left123.5 s23.5–23.5`,
    `${dayTitle(-5)}Lab Right224.7 s24.1–25.3`,
    `${dayTitle(-2)}Lab Left125.8 s25.8–25.8`,
    `${dayTitle(0)}Lab Left224.7 s24.1–25.3`,
    `${dayTitle(0)}Lab Right123.5 s23.5–23.5`,
  ]);
  await expect(trend.getByRole("columnheader")).toHaveText(["Day", "Machine", "Shots", "Median", "Middle half"]);

  // Pointed at, a day gives each Machine's: the Left's last mark is today's, which the Right has one of too.
  await duration.locator(".recharts-line-dot").nth(2).hover();
  await expect(duration.locator(".recharts-tooltip-wrapper")).toHaveText(`${dayTitle(0)}Lab Left24.7 s24.1–25.3 · 2 ShotsLab Right23.5 s23.5–23.5 · 1 Shot`);

  // Yield against target, kept in the page's address.
  await trend.getByRole("tab", { name: "Yield against target" }).click();
  await expect(page).toHaveURL(new RegExp(`/library/recipes/${recipes.house}\\?trend=yieldAgainstTarget$`));
  await expect(trend.getByRole("figure", { name: "Yield against target by day" }).locator("figcaption")).toHaveText("Yield against target (g)");
  await expect(await numbers(trend, "Yield against target by day")).toHaveText([
    `${dayTitle(-29)}Lab Left1−0.1 g−0.1 to −0.1`,
    `${dayTitle(-5)}Lab Right2−0.7 g−1.0 to −0.4`,
    `${dayTitle(-2)}Lab Left1−1.3 g−1.3 to −1.3`,
    `${dayTitle(0)}Lab Left2−0.7 g−1.0 to −0.4`,
    `${dayTitle(0)}Lab Right1+2.5 g+2.5 to +2.5`,
  ]);

  // The grind setting, as each Shot recorded it: 8.8 and 9 on the Left today, 8.4 and 8.6 on the Right five days ago.
  await trend.getByRole("tab", { name: "Grind setting" }).click();
  await expect(page).toHaveURL(new RegExp(`/library/recipes/${recipes.house}\\?trend=grindSetting$`));
  const grind = trend.getByRole("figure", { name: "Grind setting by day" });
  await expect(grind.locator(".recharts-line-curve")).toHaveCount(2);
  await expect(grind.locator(".recharts-line-dot")).toHaveCount(5);
  await expect(await numbers(trend, "Grind setting by day")).toHaveText([
    `${dayTitle(-29)}Lab Left11010–10`,
    `${dayTitle(-5)}Lab Right28.58.45–8.55`,
    `${dayTitle(-2)}Lab Left19.29.2–9.2`,
    `${dayTitle(0)}Lab Left28.98.85–8.95`,
    `${dayTitle(0)}Lab Right18.58.5–8.5`,
  ]);

  // The view is the address's, so a reloaded one is the same.
  await page.reload();
  await expect(trend.getByRole("tab", { name: "Grind setting" })).toHaveAttribute("aria-selected", "true");
  await expect(grind.locator(".recharts-line-dot")).toHaveCount(5);

  // Duration again: the address holds no default.
  await trend.getByRole("tab", { name: "Duration" }).click();
  await expect(page).toHaveURL(new RegExp(`/library/recipes/${recipes.house}$`));
  await expect(duration.locator(".recharts-line-dot")).toHaveCount(5);
});

test("a Machine's name under the chart opens its Shots of the 30 days in the Shots list, whose own trend charts the same number", async ({ page }) => {
  await page.goto(`/library/recipes/${recipes.house}?trend=grindSetting`);
  const trend = page.getByRole("region", { name: "Trend", exact: true });
  const filters = (machine: { id: string }) => `recipeId=${recipes.house}&machineId=${machine.id}&from=${date(-29)}&to=${date(0)}`;
  const lines = trend.getByRole("list", { name: "Lines" });
  await expect(lines.getByRole("link", { name: "Lab Left" })).toHaveAttribute("href", `/shots?${filters(machines.left)}&trend=grindSetting`);
  await lines.getByRole("link", { name: "Lab Right" }).click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?${filters(machines.right)}&trend=grindSetting$`));
  // The Right's Shots of the House: today's and the two of five days ago.
  await expect(rows(page.getByRole("table", { name: "Shots" }))).toHaveCount(3);
  const chosen = page.getByRole("region", { name: "Filters" });
  await expect(chosen.getByRole("combobox", { name: "Machine", exact: true })).toHaveText("Lab Right");
  await expect(chosen.getByRole("combobox", { name: "Recipe", exact: true })).toHaveText("House, Lab");
  await expect(chosen.getByRole("button", { name: "From", exact: true })).toHaveText(dateText(-29));
  await expect(chosen.getByRole("button", { name: "To", exact: true })).toHaveText(dateText(0));
  await expect(page.getByRole("region", { name: "Trend" }).getByRole("figure", { name: "Grind setting by day" }).locator(".recharts-line-dot")).toHaveCount(2);

  // Back on the Recipe's page the number is as it was. Charting duration, the link names no number, the list's default.
  await page.goBack();
  await expect(trend.getByRole("tab", { name: "Grind setting" })).toHaveAttribute("aria-selected", "true");
  await trend.getByRole("tab", { name: "Duration" }).click();
  await expect(lines.getByRole("link", { name: "Lab Left" })).toHaveAttribute("href", `/shots?${filters(machines.left)}`);
});

test("a Recipe with no Shots in the period says so, and one whose grind setting is text has no grind trend", async ({ page }) => {
  // The Tea, pulled once, yesterday, at a grind setting of 1.1.0.
  await page.goto(`/library/recipes/${recipes.tea}`);
  const today = page.getByRole("region", { name: "Today", exact: true });
  await expect(today.getByText("No Shots were pulled with it today.")).toBeVisible();
  await expect(today.getByRole("table")).toHaveCount(0);
  const trend = page.getByRole("region", { name: "Trend", exact: true });
  await expect(trend.getByRole("figure", { name: "Duration by day" }).locator(".recharts-line-dot")).toHaveCount(1);
  await expect(trend.getByRole("list", { name: "Lines" }).getByRole("listitem")).toHaveText(["Lab Left"]);
  await trend.getByRole("tab", { name: "Grind setting" }).click();
  await expect(trend.getByRole("figure", { name: "Grind setting by day" })).toHaveText("Grind setting Nothing to chart: none of these Shots has a grind setting that is a number.");
  await expect(trend.getByRole("button", { name: "Show the numbers" })).toHaveCount(0);

  // A Recipe never pulled.
  await page.goto(`/library/recipes/${recipes.idle}`);
  await expect(today.getByText("No Shots were pulled with it today.")).toBeVisible();
  await expect(trend.getByText("No Shots were pulled with it in the last 30 days.")).toBeVisible();
  await expect(trend.getByRole("figure")).toHaveCount(0);
  // The page's other cards are as before.
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
});

test("numbers that can't be read say so", async ({ page }) => {
  await page.route(/\/api\/shots\/summary\?/, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ statusCode: 500, message: "Internal server error" }) }));
  await page.goto(`/library/recipes/${recipes.house}`);
  await expect(page.getByRole("region", { name: "Today", exact: true }).getByRole("alert")).toHaveText("Could not read today's numbers: Internal server error");
  await expect(page.getByRole("region", { name: "Trend", exact: true }).getByRole("alert")).toHaveText("Could not read the trend: Internal server error");
  await expect(page.getByRole("region", { name: "Trend", exact: true }).getByRole("figure")).toHaveCount(0);
});

/** The rows of the trend's numbers, as its table gives them, opened if it is closed. */
async function numbers(trend: Locator, name: string): Promise<Locator> {
  const table = trend.getByRole("table", { name });
  const show = trend.getByRole("button", { name: "Show the numbers" });
  await expect(show.or(table)).toBeVisible();
  if (await show.isVisible()) await show.click();
  return rows(table);
}

/** The tablet with this serial, its Decaid holding no Library of its own, so the Library is only what the spec makes. */
function emptyLibrary(serial: string) {
  return { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS };
}

/**
 * The Lab and its two Machines, each there since long before its Shots,
 * which its tablet backfills. Then, the tablets unloaded, the Recipes, each
 * Shot's Recipe, and the Recipes each Machine had loaded.
 */
async function seed(page: Page) {
  const post = async <T>(path: string, data: Fields): Promise<T> => {
    const response = await page.request.post(`/api${path}`, { data });
    expect(response.status(), `${path}: ${await response.text()}`).toBe(201);
    return (await response.json()) as T;
  };
  const lab = await createLocation(page, "Lab", ZONE);
  const machine = async (name: string) => {
    const created = await post<{ machine: { id: string }; token: string }>("/machines", { name });
    await post(`/machines/${created.machine.id}/location-history`, { locationId: lab.id, effectiveFrom: "2025-01-01T00:00:00Z" });
    return { id: created.machine.id, token: created.token };
  };
  machines = { left: await machine("Lab Left"), right: await machine("Lab Right") };

  const shots: [{ token: string }, string, Fields[]][] = [
    [
      machines.left,
      LEFT,
      [
        shotOf("left-today-1", at(0, 1), LEFT, 8.8),
        shotOf("left-today-2", at(0, 1, 10), LEFT, "9", {}, preheatShotFixture()),
        shotOf("left-today-unfinished", at(0, 1, 20), LEFT, 9, { unfinished: true }),
        shotOf("left-tea", at(-1, 8), LEFT, "1.1.0"),
        shotOf("left-2-days", at(-2, 8), LEFT, 9.2, {}, preheatShotFixture()),
        shotOf("left-29-days", at(-29, 8), LEFT, 10),
        shotOf("left-30-days", at(-30, 8), LEFT, 10),
      ],
    ],
    [
      machines.right,
      RIGHT,
      [
        shotOf("right-today", at(0, 1, 5), RIGHT, 8.5, { actualYield: 38.5, stopReason: "machineEnded" }),
        shotOf("right-none", at(0, 2), RIGHT, 8.5),
        shotOf("right-5-days-1", at(-5, 8), RIGHT, 8.4),
        shotOf("right-5-days-2", at(-5, 9), RIGHT, 8.6, {}, preheatShotFixture()),
      ],
    ],
  ];
  const tablets = shots.map(([{ token }, serial, pulled]) => SimulatedTablet.load({ settings: settingsFor({ serverUrl: server.url(), token }), api: withShots(emptyLibrary(serial), pulled), timeScale: 50 }));
  const stored = shots.reduce((count, [, , pulled]) => count + pulled.length, 0);
  await expect.poll(async () => ((await (await page.request.get("/api/shots?limit=1")).json()) as { total: number }).total, { timeout: 30_000 }).toBe(stored);
  await Promise.all(tablets.map((tablet) => tablet.unload()));

  const recipe = async (name: string, slot: number | null, content: Fields = {}) => (await post<{ recipe: { id: string } }>("/recipes", { locationId: lab.id, slot, content: { name, ...content } })).recipe.id;
  recipes = { house: await recipe("House", 1, { grindSetting: 9 }), tea: await recipe("Tea", 2, { grindSetting: "1.1.0" }), idle: await recipe("Idle", null) };

  // Each Shot's Recipe, as its tablet's map would resolve the one its Workflow names, and the Recipes each Machine had
  // loaded: the Left the House but for the Tea yesterday morning, the Right the House throughout.
  const pulledWith: Record<string, string> = {
    "left-today-1": recipes.house,
    "left-today-2": recipes.house,
    "left-today-unfinished": recipes.house,
    "left-tea": recipes.tea,
    "left-2-days": recipes.house,
    "left-29-days": recipes.house,
    "left-30-days": recipes.house,
    "right-today": recipes.house,
    "right-5-days-1": recipes.house,
    "right-5-days-2": recipes.house,
  };
  const loaded: [{ id: string }, string, string, string | null][] = [
    [machines.left, recipes.house, at(-31, 0), at(-1, 7)],
    [machines.left, recipes.tea, at(-1, 7), at(-1, 9)],
    [machines.left, recipes.house, at(-1, 9), null],
    [machines.right, recipes.house, at(-31, 0), null],
  ];
  const database = await server.connectDatabase();
  try {
    for (const [id, recipeId] of Object.entries(pulledWith)) await database.query("UPDATE shots SET recipe_id = $2 WHERE id = $1", [id, recipeId]);
    for (const [{ id }, recipeId, loadedAt, unloadedAt] of loaded) {
      await database.query("INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at, unloaded_at) VALUES ($1, $2, $3, $4)", [id, recipeId, loadedAt, unloadedAt]);
    }
  } finally {
    await database.end();
  }
}
