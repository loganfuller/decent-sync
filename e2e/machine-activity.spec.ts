import { expect, type Page, test } from "@playwright/test";
import { dye2GlobalIdOf } from "@decent-sync/protocol";
import { SimulatedDye2, dye2List, openDye2Dashboard, recordedDye2MainTablet } from "../server/test/support/simulated-dye2.js";
import { SimulatedTablet, settingsFor } from "../server/test/support/simulated-tablet.js";
import { chooseDate, farFromMidnight } from "./support/calendar.js";
import { useFreshServer } from "./support/fresh-server.js";
import { openCard, rows } from "./support/locators.js";
import { CHECK_MS, afterDetailsPolls } from "./support/polling.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// A Machine's activity on its page (#476), as an Admin, in a card shown
// closed until it is opened: the list for today,
// with a Recipe loaded and a grind changed in its dial-in trail, its Loaded
// Recipes and Machine States, another day chosen, a list paged, and one
// that shrinks under the page shown. A simulated tablet running the built plugin and DYE2, as recorded in
// server/test/fixtures/decaid/dye2-v0.1.26/, reports yesterday's Machine
// State changes with its plugin's clock set to each change's time, then has
// the Brazil's recipe applied in DYE2 and its grind changed as the spec
// runs. Hardware ids are made up.
//
// The days are counted back from today, so the Lab is where no day begins
// while this runs (`farFromMidnight`).
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

type Record_ = Record<string, unknown>;

const SERIAL = "10071";
const HOUR = 3_600_000;

/** The recording's tablet's record id of the Brazil's recipe, in Recipe Slot 2, whose grind is 3. */
const BRAZIL = "2";

/** The Lab's time zone, how many hours it is ahead of UTC, and how a time there names it. */
const { zone: ZONE, ahead: AHEAD, zoneName: ZONE_NAME } = farFromMidnight();

/** Today at the Lab, as a UTC date holding its wall clock's parts. */
const TODAY = new Date(Date.now() + AHEAD * HOUR);

/** A day at the Lab, `days` from today, as a UTC date at its midnight on the wall clock. */
function day(days: number): Date {
  return new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate() + days));
}

/** The moment the Lab's wall clock read a time on a day `days` from today. */
function at(days: number, hours: number, minutes = 0, seconds = 0): string {
  return new Date(day(days).getTime() + ((hours - AHEAD) * 3600 + minutes * 60 + seconds) * 1000).toISOString();
}

/**
 * Yesterday at the Lab: asleep since 22:00 the night before and woken at
 * 06:00; eleven Shots of 30 s, ten minutes apart from 08:00; and asleep
 * again from 21:00. With the sleep it began in, 25 Machine States.
 */
const YESTERDAY: [state: string, substate: string, at: string][] = [
  ["sleeping", "idle", at(-2, 22)],
  ["idle", "idle", at(-1, 6)],
  ...Array.from({ length: 11 }, (_, n): [string, string, string][] => [
    ["espresso", "pouring", at(-1, 8, n * 10)],
    ["idle", "idle", at(-1, 8, n * 10, 30)],
  ]).flat(),
  ["sleeping", "idle", at(-1, 21)],
];

let machineId: string;
let recipeId: string;
let tablet: SimulatedTablet;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("a Machine's page lists today's dial-in trail: a Recipe loaded and its grind changed after it, from what to what, with the Recipe loaded then and links to the Library items it names", async ({ page }) => {
  const lab = await createLocation(page, "Lab", ZONE);
  machineId = await adopt(page, "Lab 1", lab.id);

  const loads: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === "GET" && pathname.endsWith("/activity")) loads.push(pathname);
  });
  await page.goto(`/machines/${machineId}`);
  // Shown closed, reading nothing of the day, until it is opened, as the page's Settings Edits and Settings History are.
  const closed = page.getByRole("region", { name: "Activity" });
  await expect(closed.getByRole("button", { name: "Show Activity", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(closed.getByRole("tab")).toHaveCount(0);
  expect(loads).toEqual([]);
  const activity = await openCard(page, "Activity");
  expect(loads).toContain(`/api/machines/${machineId}/activity`);
  await expect(activity.getByRole("tab", { name: "Dial-in trail" })).toHaveAttribute("aria-selected", "true");
  await expect(activity.getByRole("button", { name: "Day", exact: true })).toHaveText(dateText(0));
  await expectTip(activity, "Activity", /The day is that of the Location it was at then, and so is each time, by its tablet's clock\..*Changes within 5 seconds of each other from one source are one entry\./);

  const trail = activity.getByRole("table", { name: "Dial-in trail" });
  await expect(trail.getByRole("columnheader")).toHaveText(["When", "What", "Changes", "Loaded Recipe", "Made by"]);
  // Latest first: the grind, the load, and the Workflow its tablet first reported, today, whole.
  await expect(rows(trail)).toHaveCount(3);
  const [dialled, loaded, inEffect] = [0, 1, 2].map((n) => rows(trail).nth(n).getByRole("cell"));
  await expect(dialled!).toHaveText([TODAY_AT_THE_LAB, "Changed", "Grind setting: 3 to 2.8", "Fixture Brazil Espresso", "The tablet"]);
  // What the load changed, each from what the Workflow held before: the Recipe it came to name and its Bean Batch,
  // each linked to the Library's.
  await expect(loaded!).toHaveText([TODAY_AT_THE_LAB, "Recipe loaded", /Recipe: None to Fixture Brazil Espresso/, "Fixture Brazil Espresso", "The tablet"]);
  const brought = loaded!.nth(2).getByRole("listitem");
  await expect(brought.filter({ hasText: /^Recipe:/ }).getByRole("link", { name: "Fixture Brazil Espresso" })).toHaveAttribute("href", `/library/recipes/${recipeId}`);
  await expect(brought.filter({ hasText: /^Bean:/ })).toHaveText("Bean: Fixture Brazil to Activity Fixture Brazil");
  await expect(brought.filter({ hasText: /^Bean:/ }).getByRole("link", { name: "Activity Fixture Brazil" })).toHaveAttribute("href", /^\/library\/bean-batches\//);
  // The Workflow in effect names no Recipe, and its Profile, Grinder and Basket are the Library's.
  await expect(inEffect!.nth(1)).toHaveText("Workflow in effect");
  const held = inEffect!.nth(2).getByRole("listitem");
  await expect(held.filter({ hasText: /^Recipe:/ })).toHaveCount(0);
  await expect(held.filter({ hasText: /^Profile:/ }).getByRole("link", { name: "Classic Italian espresso" })).toHaveAttribute("href", /^\/library\/profiles\//);
  await expect(held.filter({ hasText: /^(Dose|Grind setting):/ })).toHaveText(["Dose: 19 g", "Grind setting: 3"]);
  await expect(inEffect!.nth(3)).toHaveText("None");

  // The Recipe loaded then opens its page.
  await dialled!.nth(3).getByRole("link", { name: "Fixture Brazil Espresso" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Brazil Espresso", level: 1 })).toBeVisible();
});

test("the day's Loaded Recipes and Machine States are each a list of their own, the Machine State in effect as the day began given with the day it dates from", async ({ page }) => {
  await page.goto(`/machines/${machineId}`);
  const activity = await openCard(page, "Activity");

  await activity.getByRole("tab", { name: "Loaded Recipes" }).click();
  const recipes = activity.getByRole("table", { name: "Loaded Recipes that day" });
  await expect(rows(recipes)).toHaveCount(1);
  await expect(rows(recipes).first().getByRole("cell")).toHaveText(["Fixture Brazil EspressoSlot 2", TODAY_AT_THE_LAB, "Still loaded"]);

  await activity.getByRole("tab", { name: "Machine States" }).click();
  const states = activity.getByRole("table", { name: "Machine States that day" });
  // Idle since its tablet said so today, and asleep before that since 21:00 yesterday.
  await expect(rows(states)).toHaveCount(2);
  await expect(rows(states).first().getByRole("cell")).toHaveText([TODAY_AT_THE_LAB, "Idle"]);
  await expect(rows(states).nth(1).getByRole("cell")).toHaveText([`${dateText(-1)}, 9:00:00 PM ${ZONE_NAME}`, "Asleep"]);
  // Two entries need no paging.
  await expect(activity.getByRole("button", { name: "Older" })).toHaveCount(0);
});

test("another day is chosen from a calendar, its Machine States a page at a time, and a list with nothing that day says so", async ({ page }) => {
  await page.goto(`/machines/${machineId}`);
  const activity = await openCard(page, "Activity");
  await activity.getByRole("tab", { name: "Machine States" }).click();
  await chooseDate(page, activity, "Day", day(-1));
  await expect(activity.getByRole("button", { name: "Day", exact: true })).toHaveText(dateText(-1));

  const states = activity.getByRole("table", { name: "Machine States that day" });
  await expect(rows(states)).toHaveCount(20);
  await expect(activity.getByText("1–20 of 25")).toBeVisible();
  await expect(rows(states).first().getByRole("cell")).toHaveText([`9:00:00 PM ${ZONE_NAME}`, "Asleep"]);
  // The eleventh Shot, 30 s long, the last of the day.
  await expect(rows(states).nth(1).getByRole("cell")).toHaveText([`9:40:30 AM ${ZONE_NAME}`, "Idle"]);
  await expect(rows(states).nth(2).getByRole("cell")).toHaveText([`9:40:00 AM ${ZONE_NAME}`, "Pulling a shot · Pouring"]);
  await expect(activity.getByRole("button", { name: "Newer" })).toBeDisabled();

  await activity.getByRole("button", { name: "Older" }).click();
  await expect(activity.getByText("21–25 of 25")).toBeVisible();
  await expect(rows(states)).toHaveCount(5);
  // The day's first Shot, its waking, and last the sleep it began in, from the night before.
  await expect(rows(states).nth(2).getByRole("cell")).toHaveText([`8:00:00 AM ${ZONE_NAME}`, "Pulling a shot · Pouring"]);
  await expect(rows(states).nth(3).getByRole("cell")).toHaveText([`6:00:00 AM ${ZONE_NAME}`, "Idle"]);
  await expect(rows(states).nth(4).getByRole("cell")).toHaveText([`${dateText(-2)}, 10:00:00 PM ${ZONE_NAME}`, "Asleep"]);
  await expect(activity.getByRole("button", { name: "Older" })).toBeDisabled();
  await activity.getByRole("button", { name: "Newer" }).click();
  await expect(activity.getByText("1–20 of 25")).toBeVisible();
  await expect(rows(states)).toHaveCount(20);

  // Its tablet first reported a Workflow today, and loaded the Recipe today.
  await activity.getByRole("tab", { name: "Dial-in trail" }).click();
  await expect(activity.getByText("Its tablet had reported no Workflow by then.")).toBeVisible();
  await expect(activity.getByRole("table")).toHaveCount(0);
  await activity.getByRole("tab", { name: "Loaded Recipes" }).click();
  await expect(activity.getByText("No Recipe was loaded then.")).toBeVisible();

  // Back to today, the day kept as the list changes.
  await chooseDate(page, activity, "Day", day(0));
  await expect(rows(activity.getByRole("table", { name: "Loaded Recipes that day" }))).toHaveCount(1);
});

test("a trail that shrinks to end before the page shown, as a change undone within 5 seconds leaves it, goes back to its last page", async ({ page }) => {
  type Trail = { workflowChanges: { total: number } };
  const total = async () => ((await (await page.request.get(`/api/machines/${machineId}/activity?kind=workflowChanges&from=${encodeURIComponent(at(0, 0))}`)).json()) as Trail).workflowChanges.total;
  /** The grind changed with the plugin's clock that far on from now, so each change is an entry of its own unless within 5 s of the last. */
  const grind = async (setting: string, aheadMs: number, entries: number) => {
    tablet.setPluginClockOffset(aheadMs);
    await tablet.changeSettings({ context: { grinderSetting: setting } });
    await expect.poll(total).toBe(entries);
  };
  // Seventeen more grind changes, a minute apart: with the three there were, 20 entries, which is one page.
  for (let n = 1; n <= 17; n++) await grind((3 + n / 10).toFixed(1), n * 60_000, 3 + n);

  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto(`/machines/${machineId}`);
  const activity = await openCard(page, "Activity");
  const trail = activity.getByRole("table", { name: "Dial-in trail" });
  await expect(rows(trail)).toHaveCount(20);
  await expect(activity.getByRole("button", { name: "Older" })).toHaveCount(0);

  // A 21st, which the second page holds the oldest entry for.
  const dialled = Date.now();
  await grind("9.9", 18 * 60_000, 21);
  await afterDetailsPolls(page, () => expect(activity.getByText("1–20 of 21")).toBeVisible({ timeout: CHECK_MS }));
  await activity.getByRole("button", { name: "Older" }).click();
  await expect(activity.getByText("21–21 of 21")).toBeVisible();
  await expect(rows(trail).getByRole("cell").nth(1)).toHaveText("Workflow in effect");

  // Undone 2 s later by the plugin's clock: the two are one entry that changed nothing, which the trail drops.
  await grind("4.7", 18 * 60_000 + 2_000 - (Date.now() - dialled), 20);
  await afterDetailsPolls(page, () => expect(rows(trail)).toHaveCount(20, { timeout: CHECK_MS }));
  await expect(rows(trail).first().getByRole("cell").nth(2)).toHaveText("Grind setting: 4.6 to 4.7");
  await expect(activity.getByRole("button", { name: "Newer" })).toHaveCount(0);
});

/** A time today as the lists show it under today, at the Lab: to the second, with the Lab's zone. */
const TODAY_AT_THE_LAB = new RegExp(`^\\d+:\\d\\d:\\d\\d [AP]M ${ZONE_NAME.replace("+", "\\+")}$`);

/** A day `days` from today as the Day field shows it, such as "Nov 9, 2026". */
function dateText(days: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(day(days));
}

/**
 * Creates a machine entry at the Location since long before, and loads a
 * simulated tablet running DYE2 on its hardware, which reports yesterday's
 * Machine State changes, then that it is idle now, has the Brazil's recipe
 * applied in DYE2 and its grind changed to 2.8: the Machine's id.
 */
async function adopt(page: Page, name: string, locationId: string): Promise<string> {
  const response = await page.request.post("/api/machines", { data: { name } });
  expect(response.status()).toBe(201);
  const { machine, token } = (await response.json()) as { machine: { id: string }; token: string };
  const moved = await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId, effectiveFrom: "2025-01-01T00:00:00Z" } });
  expect(moved.status()).toBe(201);
  // Kept for the last test, which has more changed on it.
  tablet = server.keep(() =>
    SimulatedTablet.load({
      settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 },
      api: recordedDye2MainTablet(SERIAL, "Activity"),
      dye2: new SimulatedDye2(),
      timeScale: 50,
    }),
  );
  await tablet.waitForLog(/^Connected to /);
  const read = async <T>(path: string) => (await (await page.request.get(`/api/machines/${machine.id}${path}`)).json()) as T;

  for (const [state, substate, observedAt] of YESTERDAY) {
    tablet.setPluginClockOffset(Date.parse(observedAt) - Date.now());
    tablet.reportState(state, substate);
  }
  tablet.setPluginClockOffset(0);
  tablet.reportState("idle", "idle");
  await expect.poll(async () => (await read<{ total: number }>("/machine-state-events?limit=1")).total).toBe(YESTERDAY.length + 1);

  // The Brazil's recipe, once its record names the Library's Recipe, applied from DYE2's dashboard.
  const brazil = () => (Array.isArray(dye2List(tablet, "recipes")) ? (dye2List(tablet, "recipes") as Record_[]) : []).find((record) => record.id === BRAZIL);
  await expect.poll(() => dye2GlobalIdOf(brazil())).not.toBeNull();
  recipeId = dye2GlobalIdOf(brazil())!;
  expect((await (await openDye2Dashboard(tablet)).applyRecipe(BRAZIL)).workflow?.status).toBe(200);
  type Trail = { workflowChanges: { entries: { kind: string; changes: { field: string; after: unknown }[] }[] } };
  const latest = async () => (await read<Trail>(`/activity?kind=workflowChanges&from=${encodeURIComponent(at(0, 0))}`)).workflowChanges.entries[0];
  // Once the load and what the plugin writes after it are in, so the grind is a change of its own.
  await expect.poll(async () => (await latest())?.kind).toBe("loaded");
  await expect.poll(() => (tablet.workflow().context as Record_).grinderSetting).toBe("3");
  await tablet.changeSettings({ context: { grinderSetting: "2.8" } });
  await expect.poll(async () => (await latest())?.changes).toEqual([expect.objectContaining({ field: "grindSetting", after: "2.8" })]);
  return machine.id;
}
