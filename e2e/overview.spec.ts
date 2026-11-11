import { expect, type Locator, type Page, test } from "@playwright/test";
import { preheatShotFixture, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { farFromMidnight } from "./support/calendar.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// The Overview (#471), as an Admin: the home page's block for each Location
// and each Location's page's own, with a column for each Machine and a row
// for each Recipe pulled in the period.
//
// Simulated tablets running the built plugin backfill twelve Shots on two
// Machines at the Lab and one at the Harbor, each derived from one of two
// Shots Decaid recorded, changing only its id, time, recorded hardware and
// what the table names. The Recipes are made through the REST API once the
// tablets are unloaded, so none is written to one, and each Shot's Recipe
// is then set in PostgreSQL, with each Machine's Loaded Recipes: how a
// tablet's map and its Workflow make them is shot-recipe-links.spec.ts's to
// cover. The real Shots weighed 0.1 g and 1.3 g under their targets, ran
// 23.549 s and 25.833 s after their Preheat, and stopped on weight. Hardware
// ids are made up.
//
// | Shot | Machine | Pulled, on its Location's wall clock | Recipe | What it is |
// |---|---|---|---|---|
// | left-house-1 | Lab Left | today 01:00 | House, slot 2 | −0.1 g, 23.549 s |
// | left-house-2 | Lab Left | today 01:10 | House | −1.3 g, 25.833 s |
// | left-house-unfinished | Lab Left | today 01:20 | House | stopped at once: an Unfinished Shot |
// | left-decaf | Lab Left | today 01:40 | Decaf, slot 1 | +2.5 g, ended by the Machine |
// | left-none | Lab Left | today 02:00 | none | −0.1 g, 23.549 s |
// | left-cleaning | Lab Left | today 02:10 | none | a cleaning Shot |
// | right-house | Lab Right | today 01:05 | House | −0.1 g, 23.549 s |
// | right-decaf | Lab Right | yesterday 08:00 | Decaf | −1.3 g, 25.833 s |
// | right-guest | Lab Right | 3 days ago 08:00 | Guest, no slot | −0.1 g, 23.549 s |
// | right-old | Lab Right | 8 days ago 08:00 | House | before every period |
// | harbor-house | Harbor 1 | today 00:30 | Harbor House, slot 1 | −0.1 g, 23.549 s |
// | depot-none | Depot 1 | today 00:45, stored by the last test | none | −0.1 g, 23.549 s |
//
// The days are counted back from today, so the Locations are where no day
// begins while this runs (`farFromMidnight`): the Harbor an hour or two ahead
// of the Lab, so its Shot, half an hour into its day, was pulled on the
// Lab's yesterday.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

const HOUR = 3_600_000;

/** The Lab's and the Depot's time zone, and how many hours it is ahead of UTC. */
const { zone: ZONE, ahead: AHEAD } = farFromMidnight();
/** The Harbor's: Regina, 6 hours behind UTC all year, beside Phoenix, or Tokyo, 9 ahead, beside Bangkok, each as far from its midnight. */
const HARBOR = ZONE === "America/Phoenix" ? { zone: "America/Regina", ahead: -6 } : { zone: "Asia/Tokyo", ahead: 9 };

const LEFT = "10071";
const RIGHT = "10072";
const HARBOR_1 = "10073";
const DEPOT_1 = "10074";

type Fields = Record<string, unknown>;

/** A day where the clocks are `ahead` of UTC, `days` from today there, as a UTC date at its midnight on the wall clock. */
function day(days: number, ahead = AHEAD): Date {
  const today = new Date(Date.now() + ahead * HOUR);
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days));
}

/** The moment the wall clock there read a time on a day `days` from today. */
function at(days: number, hours: number, minutes = 0, ahead = AHEAD): string {
  return new Date(day(days, ahead).getTime() + (hours - ahead) * HOUR + minutes * 60_000).toISOString();
}

/** A day at the Lab as an address names it, such as 2026-11-11. */
const date = (days: number) => day(days).toISOString().slice(0, 10);

/** A day at the Lab as the Shots list's date fields show it, such as "Nov 11, 2026". */
const dateText = (days: number) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(day(days));

/** What a test changes of a fixture's record. */
interface Changes {
  actualYield?: number;
  stopReason?: string;
  /** Its profile's type. */
  type?: string;
  /** Stopped at once, in its preinfusion, before anything poured: its first two samples alone. */
  unfinished?: boolean;
}

/** A Shot pulled at a UTC time on the hardware given, derived from `fixture` with the changes given. */
function shotOf(id: string, pulledAt: string, serial: string, changes: Changes = {}, fixture = shotFixture()): Fields {
  const workflow = fixture.workflow as Record<string, Fields>;
  return {
    ...fixture,
    id,
    timestamp: pulledAt,
    ...(changes.stopReason !== undefined && { stopReason: changes.stopReason }),
    ...(changes.unfinished && { measurements: (fixture.measurements as Fields[]).slice(0, 2) }),
    workflow: {
      ...workflow,
      profile: { ...workflow.profile, ...(changes.type !== undefined && { beverage_type: changes.type }) },
      machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial },
    },
    annotations: { ...(fixture.annotations as Fields), ...(changes.actualYield !== undefined && { actualYield: changes.actualYield }) },
  };
}

/** What the tests after the first read of what it made. */
let lab: { id: string };
let harbor: { id: string };
let machines: Record<"left" | "right" | "harbor1" | "depot1", { id: string; token: string }>;
let recipes: Record<"house" | "decaf" | "guest" | "harborHouse", string>;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("the home page shows a block for each Location: a column for each Machine there, with its status, and a row for each Recipe pulled today, in Recipe Slot order, the Shots with no Recipe last", async ({
  page,
}) => {
  await seed(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expectTip(page.getByRole("main"), "Overview", /^Each Location's Machines, and the Recipes pulled there today, yesterday or in the last 7 days, which are that Location's own days, in its time zone\./);
  await expect(page.getByRole("tab", { name: "Today" })).toHaveAttribute("aria-selected", "true");
  // Every Location, by name, each linked to its page. The Machine at no Location is in none.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Depot", "Harbor", "Lab"]);
  await expect(page.getByRole("heading", { name: "Lab", level: 2 }).getByRole("link")).toHaveAttribute("href", `/locations/${lab.id}`);
  await expect(page.getByText("Spare")).toHaveCount(0);

  // The Lab's two Machines, each as the Machines page gives it: its tablet gone, the Machine State it last reported, if
  // any, the Recipe it has loaded and its last Shot, in this browser's time zone.
  const labTable = table(page, "Lab");
  await expect(labTable.getByRole("columnheader")).toHaveText([
    "Recipe",
    /^Lab LeftOfflineIdleNo Recipe loadedLast Shot: \w+ \d+, \d{4}, .+$/,
    /^Lab RightOfflineState not reportedHouseSlot 2Last Shot: \w+ \d+, \d{4}, .+$/,
  ]);
  await labTable.getByRole("columnheader").nth(1).getByRole("link", { name: "Lab Left" }).click();
  await expect(page).toHaveURL(new RegExp(`/machines/${machines.left.id}$`));
  await page.goBack();

  // Decaf, in slot 1, before House, in slot 2, each with its Bean Batch now and its days since roast, where it names one;
  // then the Shots pulled with no Recipe loaded.
  await expect(labTable.getByRole("rowheader")).toHaveText(["DecafSlot 1", `HouseSlot 2Guji, roasted ${date(-12)} · 12 days since roast`, "No Recipe loaded"]);
  await labTable.getByRole("rowheader").getByRole("link", { name: "House" }).click();
  await expect(page).toHaveURL(new RegExp(`/library/recipes/${recipes.house}$`));
  await page.goBack();

  // The Harbor's Machine and its Recipe, pulled half an hour into its day there.
  const harborTable = table(page, "Harbor");
  await expect(harborTable.getByRole("columnheader")).toHaveText(["Recipe", /^Harbor 1OfflineState not reportedHarbor HouseSlot 1Last Shot: /]);
  await expect(harborTable.getByRole("rowheader")).toHaveText(["Harbor HouseSlot 1"]);
  await expect(cell(harborTable, "Harbor House", 0)).toHaveText("1 Shot23.5 s · −0.1 g vs target · 100% on weight");

  // A Location where nothing was pulled shows its Machine, which never connected, and says so.
  const depot = page.getByRole("region", { name: "Depot", exact: true });
  await expect(table(page, "Depot").getByRole("columnheader")).toHaveText(["Recipe", "Depot 1OfflineState not reportedNo Recipe loadedLast Shot: None"]);
  await expect(depot.getByText("No Shots were pulled here today.")).toBeVisible();
});

test("a cell gives a Machine's Shots of a Recipe as the Shot Summary of its filters does, with its Unfinished Shots beside the count, and opens them in the Shots list", async ({
  page,
}) => {
  await page.goto("/");
  const labTable = table(page, "Lab");
  // House on the Left: two Shots, −0.1 g and −1.3 g, 23.549 s and 25.833 s, both stopped on weight, and one unfinished.
  const house = cell(labTable, "House", 0);
  await expect(house).toHaveText("2 Shots · 1 unfinished24.7 s · −0.7 g vs target · 100% on weight");
  // Decaf, 2.5 g over and ended by the Machine; on the Right, which pulled none today, nothing.
  await expect(cell(labTable, "Decaf", 0)).toHaveText("1 Shot23.5 s · +2.5 g vs target · 0% on weight");
  await expect(cell(labTable, "Decaf", 1)).toHaveText("");
  await expect(cell(labTable, "House", 1)).toHaveText("1 Shot23.5 s · −0.1 g vs target · 100% on weight");
  // With no Recipe, one Shot and a cleaning Shot, left out of the numbers.
  const none = cell(labTable, "No Recipe loaded", 0);
  await expect(none).toHaveText("1 Shot · 1 cleaning or calibration23.5 s · −0.1 g vs target · 100% on weight");
  await expect(cell(labTable, "No Recipe loaded", 1)).toHaveText("");

  // The cell's link holds its filters: its Location, Machine, Recipe and today there. The Shot Summary of those filters
  // gives the cell's numbers, and the Shots list finds its Shots, the unfinished one among them.
  const filters = `locationId=${lab.id}&machineId=${machines.left.id}&recipeId=${recipes.house}&from=${date(0)}&to=${date(0)}`;
  await expect(house.getByRole("link")).toHaveAttribute("href", `/shots?${filters}`);
  const summary = (await (await page.request.get(`/api/shots/summary?${filters}`)).json()) as { groups: { counts: Fields; numbers: Record<string, { median?: number; share?: number }> }[] };
  expect(summary.groups[0]!.counts).toMatchObject({ shots: 2, unfinished: 1, cleaningAndCalibration: 0 });
  expect(summary.groups[0]!.numbers.duration!.median).toBeCloseTo(24.691, 6);
  expect(summary.groups[0]!.numbers.yieldAgainstTarget!.median).toBeCloseTo(-0.7, 6);
  expect(summary.groups[0]!.numbers.stoppedOnWeight!.share).toBe(1);

  await house.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?${filters}$`));
  await expect(shotRows(page)).toHaveCount(3);
  const chosen = page.getByRole("region", { name: "Filters" });
  await expect(chosen.getByRole("combobox", { name: "Location", exact: true })).toHaveText("Lab");
  await expect(chosen.getByRole("combobox", { name: "Machine", exact: true })).toHaveText("Lab Left");
  await expect(chosen.getByRole("combobox", { name: "Recipe", exact: true })).toHaveText("House, Lab");
  await expect(chosen.getByRole("button", { name: "From", exact: true })).toHaveText(dateText(0));
  await expect(chosen.getByRole("button", { name: "To", exact: true })).toHaveText(dateText(0));
  await expect(field(page.getByRole("region", { name: "Summary" }), "Shots")).toHaveText("21 Unfinished Shot left out");

  // The Shots with no Recipe open as the list's filter for none.
  await page.goBack();
  await none.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?locationId=${lab.id}&machineId=${machines.left.id}&recipeId=none&from=${date(0)}&to=${date(0)}$`));
  await expect(shotRows(page)).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: "Recipe", exact: true })).toHaveText("Pulled with no Recipe loaded");
});

test("the period switches to yesterday and to the last 7 days, and stays in the address", async ({ page }) => {
  await page.goto("/");
  const labTable = table(page, "Lab");
  await expect(labTable.getByRole("rowheader")).toHaveCount(3);

  // Yesterday the Right alone pulled a Decaf, and the Left stays, as it is here. Nothing was pulled at the Harbor.
  await page.getByRole("tab", { name: "Yesterday" }).click();
  await expect(page).toHaveURL(/\/\?period=yesterday$/);
  await expect(labTable.getByRole("rowheader")).toHaveText(["DecafSlot 1"]);
  await expect(labTable.getByRole("columnheader")).toHaveText(["Recipe", /^Lab Left/, /^Lab Right/]);
  await expect(cell(labTable, "Decaf", 0)).toHaveText("");
  await expect(cell(labTable, "Decaf", 1)).toHaveText("1 Shot25.8 s · −1.3 g vs target · 100% on weight");
  await expect(page.getByRole("region", { name: "Harbor", exact: true }).getByText("No Shots were pulled here yesterday.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Depot", exact: true }).getByText("No Shots were pulled here yesterday.")).toBeVisible();

  // The last 7 days, today the last: the Recipes in slots, then the one in none, then the Shots with no Recipe. The
  // House pulled 8 days ago is in none of them.
  await page.getByRole("tab", { name: "Last 7 days" }).click();
  await expect(page).toHaveURL(/\/\?period=week$/);
  await expect(labTable.getByRole("rowheader")).toHaveText(["DecafSlot 1", /^HouseSlot 2/, "GuestNo slot", "No Recipe loaded"]);
  await expect(cell(labTable, "Decaf", 0)).toHaveText("1 Shot23.5 s · +2.5 g vs target · 0% on weight");
  await expect(cell(labTable, "Decaf", 1)).toHaveText("1 Shot25.8 s · −1.3 g vs target · 100% on weight");
  await expect(cell(labTable, "House", 1)).toHaveText("1 Shot23.5 s · −0.1 g vs target · 100% on weight");
  await expect(cell(labTable, "Guest", 0)).toHaveText("");
  const guest = cell(labTable, "Guest", 1);
  await expect(guest).toHaveText("1 Shot23.5 s · −0.1 g vs target · 100% on weight");
  await expect(page.getByRole("region", { name: "Harbor", exact: true }).getByRole("rowheader")).toHaveText(["Harbor HouseSlot 1"]);

  // A cell opens the seven days' Shots, and coming back from them the period is as it was, as after a reload.
  await expect(guest.getByRole("link")).toHaveAttribute("href", `/shots?locationId=${lab.id}&machineId=${machines.right.id}&recipeId=${recipes.guest}&from=${date(-6)}&to=${date(0)}`);
  await guest.getByRole("link").click();
  await expect(shotRows(page)).toHaveCount(1);
  await page.goBack();
  await expect(page.getByRole("tab", { name: "Last 7 days" })).toHaveAttribute("aria-selected", "true");
  await expect(labTable.getByRole("rowheader")).toHaveCount(4);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Last 7 days" })).toHaveAttribute("aria-selected", "true");
  await expect(labTable.getByRole("rowheader")).toHaveCount(4);

  await page.getByRole("tab", { name: "Today" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(labTable.getByRole("rowheader")).toHaveCount(3);
});

test("a Machine moved away in the period keeps its column where it pulled Shots, and has one where it is now", async ({ page }) => {
  // From now, by the server's clock: a time of this process's could be ahead of it, and refused as in the future.
  const moved = await page.request.post(`/api/machines/${machines.right.id}/location-history`, { data: { locationId: harbor.id } });
  expect(moved.status()).toBe(201);

  await page.goto("/");
  // At the Lab after the Machine here now, saying where it is, with the Shots it pulled here.
  const labTable = table(page, "Lab");
  await expect(labTable.getByRole("columnheader")).toHaveText(["Recipe", /^Lab Left/, /^Lab RightOffline.*Now at Harbor$/]);
  await expect(cell(labTable, "House", 1)).toHaveText("1 Shot23.5 s · −0.1 g vs target · 100% on weight");
  // At the Harbor, where it has pulled none.
  const harborTable = table(page, "Harbor");
  await expect(harborTable.getByRole("columnheader")).toHaveText(["Recipe", /^Harbor 1/, /^Lab RightOffline(?!.*Now at)/]);
  await expect(cell(harborTable, "Harbor House", 0)).toHaveText("1 Shot23.5 s · −0.1 g vs target · 100% on weight");
  await expect(cell(harborTable, "Harbor House", 1)).toHaveText("");
});

test("a Location's page shows its own block, with its own choice of period", async ({ page }) => {
  await page.goto(`/locations/${lab.id}`);
  const overview = page.getByRole("region", { name: "Overview", exact: true });
  await expectTip(overview, "Overview", /A cell opens its Shots in the Shots list\. The status is read again every 5 seconds, and the numbers every 30\.$/);
  const labTable = overview.getByRole("table", { name: "Recipes by Machine at Lab" });
  await expect(labTable.getByRole("columnheader")).toHaveText(["Recipe", /^Lab Left/, /^Lab Right.*Now at Harbor$/]);
  await expect(labTable.getByRole("rowheader")).toHaveText(["DecafSlot 1", /^HouseSlot 2/, "No Recipe loaded"]);
  await expect(cell(labTable, "House", 0)).toHaveText("2 Shots · 1 unfinished24.7 s · −0.7 g vs target · 100% on weight");

  await overview.getByRole("tab", { name: "Yesterday" }).click();
  await expect(page).toHaveURL(new RegExp(`/locations/${lab.id}\\?period=yesterday$`));
  await expect(labTable.getByRole("rowheader")).toHaveText(["DecafSlot 1"]);
  await expect(cell(labTable, "Decaf", 1)).toHaveText("1 Shot25.8 s · −1.3 g vs target · 100% on weight");
  // The page's other cards are as before.
  await expect(page.getByRole("region", { name: "Recipes", exact: true })).toBeVisible();
});

test("the Machines' status is read again every 5 seconds, and the numbers every 30", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  const depot = page.getByRole("region", { name: "Depot", exact: true });
  const depotTable = table(page, "Depot");
  await expect(depotTable.getByRole("columnheader").nth(1)).toHaveText(/^Depot 1Offline/);
  await expect(depot.getByText("No Shots were pulled here today.")).toBeVisible();
  // From here the page's clock moves only as the test moves it, so nothing is read again until then.
  await page.clock.pauseAt(Date.now() + 1_000);
  let summariesRead = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/shots/summary") summariesRead++;
  });

  // Its tablet connects, with a Shot pulled today.
  SimulatedTablet.load({
    settings: settingsFor({ serverUrl: server.url(), token: machines.depot1.token }),
    api: withShots(emptyLibrary(DEPOT_1), [shotOf("depot-none", at(0, 0, 45), DEPOT_1)]),
    timeScale: 50,
  });
  await expect
    .poll(async () => {
      const { machine } = (await (await page.request.get(`/api/machines/${machines.depot1.id}`)).json()) as { machine: { online: boolean } };
      const { total } = (await (await page.request.get(`/api/shots?limit=1&machineId=${machines.depot1.id}`)).json()) as { total: number };
      return machine.online && total === 1;
    })
    .toBe(true);
  await expect(depotTable.getByRole("columnheader").nth(1)).toHaveText(/^Depot 1Offline/);

  // Five seconds on, the status is read again, and the numbers are not.
  await page.clock.fastForward(5_000);
  await expect(depotTable.getByRole("columnheader").nth(1)).toHaveText(/^Depot 1Online/);
  await expect(depot.getByText("No Shots were pulled here today.")).toBeVisible();
  expect(summariesRead).toBe(0);

  // Thirty seconds after they were read, the numbers are too.
  await page.clock.fastForward(25_000);
  await expect(cell(depotTable, "No Recipe loaded", 0)).toHaveText("1 Shot23.5 s · −0.1 g vs target · 100% on weight");
  await expect(depot.getByText("No Shots were pulled here today.")).toHaveCount(0);
});

/** The tablet with this serial, its Decaid holding no Library of its own, so the Library is only what the spec makes. */
function emptyLibrary(serial: string) {
  return { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS };
}

/** A Location's block's table on the home page. */
function table(page: Page, location: string): Locator {
  return page.getByRole("region", { name: location, exact: true }).getByRole("table", { name: `Recipes by Machine at ${location}` });
}

/** The cell of the row whose heading starts with `recipe`, under the Machine at `column`, counted from 0. */
function cell(table: Locator, recipe: string, column: number): Locator {
  const heading = table.page().getByRole("rowheader").filter({ hasText: new RegExp(`^${recipe}`) });
  return table.getByRole("row").filter({ has: heading }).getByRole("cell").nth(column);
}

function shotRows(page: Page): Locator {
  return page.getByRole("table", { name: "Shots" }).getByRole("row").filter({ has: page.getByRole("cell") });
}

/**
 * Three Locations and five Machines: two at the Lab and one at the Harbor,
 * each there since long before its Shots, which its tablet backfills; one
 * at the Depot whose tablet never connected; and one at no Location. Then,
 * the tablets unloaded, the Recipes, each Shot's Recipe, and the Recipes
 * each Machine had loaded.
 */
async function seed(page: Page) {
  const post = async <T>(path: string, data: Fields): Promise<T> => {
    const response = await page.request.post(`/api${path}`, { data });
    expect(response.status(), `${path}: ${await response.text()}`).toBe(201);
    return (await response.json()) as T;
  };
  const machine = async (name: string, locationId?: string) => {
    const created = await post<{ machine: { id: string }; token: string }>("/machines", { name });
    if (locationId) await post(`/machines/${created.machine.id}/location-history`, { locationId, effectiveFrom: "2025-01-01T00:00:00Z" });
    return { id: created.machine.id, token: created.token };
  };
  lab = await createLocation(page, "Lab", ZONE);
  harbor = await createLocation(page, "Harbor", HARBOR.zone);
  const depot = await createLocation(page, "Depot", ZONE);
  machines = { left: await machine("Lab Left", lab.id), right: await machine("Lab Right", lab.id), harbor1: await machine("Harbor 1", harbor.id), depot1: await machine("Depot 1", depot.id) };
  await machine("Spare");

  const shots: [{ token: string }, string, Fields[]][] = [
    [
      machines.left,
      LEFT,
      [
        shotOf("left-house-1", at(0, 1), LEFT),
        shotOf("left-house-2", at(0, 1, 10), LEFT, {}, preheatShotFixture()),
        shotOf("left-house-unfinished", at(0, 1, 20), LEFT, { unfinished: true }),
        shotOf("left-decaf", at(0, 1, 40), LEFT, { actualYield: 38.5, stopReason: "machineEnded" }),
        shotOf("left-none", at(0, 2), LEFT),
        shotOf("left-cleaning", at(0, 2, 10), LEFT, { type: "cleaning" }),
      ],
    ],
    [
      machines.right,
      RIGHT,
      [
        shotOf("right-house", at(0, 1, 5), RIGHT),
        shotOf("right-decaf", at(-1, 8), RIGHT, {}, preheatShotFixture()),
        shotOf("right-guest", at(-3, 8), RIGHT),
        shotOf("right-old", at(-8, 8), RIGHT),
      ],
    ],
    [machines.harbor1, HARBOR_1, [shotOf("harbor-house", at(0, 0, 30, HARBOR.ahead), HARBOR_1)]],
  ];
  const tablets = shots.map(([{ token }, serial, pulled]) => SimulatedTablet.load({ settings: settingsFor({ serverUrl: server.url(), token }), api: withShots(emptyLibrary(serial), pulled), timeScale: 50 }));
  const stored = shots.reduce((count, [, , pulled]) => count + pulled.length, 0);
  await expect.poll(async () => ((await (await page.request.get("/api/shots?limit=1")).json()) as { total: number }).total, { timeout: 30_000 }).toBe(stored);
  // The Left's tablet reports its Machine State, the others' none.
  tablets[0]!.reportState("idle", "idle");
  await expect
    .poll(async () => ((await (await page.request.get(`/api/machines/${machines.left.id}`)).json()) as { machine: { machineState: { state: string } | null } }).machine.machineState?.state)
    .toBe("idle");
  await Promise.all(tablets.map((tablet) => tablet.unload()));

  // The House's Bean Batch was roasted 12 days ago, by the Lab's days.
  const made = async (path: string, data: Fields) => Object.values(await post<Record<string, { id: string }>>(path, data))[0]!.id;
  const beanId = await made("/beans", { content: { roaster: "Roux", name: "Guji" } });
  const beanBatchId = await made("/bean-batches", { beanId, content: { roastDate: date(-12) }, locations: [{ locationId: lab.id }] });
  const recipe = (locationId: string, name: string, slot: number | null, content: Fields = {}) => made("/recipes", { locationId, slot, content: { name, ...content } });
  recipes = {
    house: await recipe(lab.id, "House", 2, { beanBatchId }),
    decaf: await recipe(lab.id, "Decaf", 1),
    guest: await recipe(lab.id, "Guest", null),
    harborHouse: await recipe(harbor.id, "Harbor House", 1),
  };

  // Each Shot's Recipe, as its tablet's map would resolve the one its Workflow names, and the Recipes each Machine had
  // loaded: the Left none since its Decaf, the Right the House again since today began.
  const pulledWith: Record<string, string> = {
    "left-house-1": recipes.house,
    "left-house-2": recipes.house,
    "left-house-unfinished": recipes.house,
    "left-decaf": recipes.decaf,
    "right-house": recipes.house,
    "right-decaf": recipes.decaf,
    "right-guest": recipes.guest,
    "right-old": recipes.house,
    "harbor-house": recipes.harborHouse,
  };
  const loaded: [{ id: string }, string, string, string | null][] = [
    [machines.left, recipes.house, at(-9, 0), at(0, 1, 30)],
    [machines.left, recipes.decaf, at(0, 1, 30), at(0, 1, 50)],
    [machines.right, recipes.house, at(-9, 0), at(-4, 0)],
    [machines.right, recipes.guest, at(-4, 0), at(-2, 0)],
    [machines.right, recipes.decaf, at(-2, 0), at(0, 0, 30)],
    [machines.right, recipes.house, at(0, 0, 30), null],
    [machines.harbor1, recipes.harborHouse, at(-9, 0, 0, HARBOR.ahead), null],
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
