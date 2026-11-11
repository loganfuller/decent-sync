import { expect, type Locator, type Page, test } from "@playwright/test";
import { shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { derivedSteam, steamFixture, withSteams } from "../server/test/support/steam-fixtures.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field, rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// A Machine's use on its page (#475), as an Admin: the chart by day, for the
// last 14 days, the switch to one day by hour, another range chosen, and the
// note about a tablet that was off. A simulated tablet running the built
// plugin backfills two Shots and a Steam Record derived from ones Decaid
// recorded, changing only their ids, times and recorded hardware, and
// reports each Machine State change with its plugin's clock set to the
// change's time. The Lab is in Phoenix, 7 hours behind UTC all year, so its
// days are 24 hours whenever this runs. Hardware ids are made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

const HARDWARE = { model: "DE1Pro", serial: "10061" };
const HOUR = 3_600_000;

/** Today at the Lab, as a UTC date holding its wall clock's parts. */
const TODAY = new Date(Date.now() - 7 * HOUR);

/** A day at the Lab, `days` from today, as a UTC date at its midnight on the wall clock. */
function day(days: number): Date {
  return new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate() + days));
}

/** The moment the Lab's wall clock read a time on a day `days` from today. */
function at(days: number, hours: number, minutes = 0, seconds = 0): string {
  return new Date(day(days).getTime() + ((hours + 7) * 3600 + minutes * 60 + seconds) * 1000).toISOString();
}

/**
 * Yesterday at the Lab: asleep since 22:00 the night before and woken at
 * 06:00; a Shot of 30 s at 08:00, a flush of 10 s at 08:10, a hot water pour
 * of 20 s at 09:00 and 45 s of steaming at 12:00; asleep again from 21:00,
 * and its tablet has reported nothing since.
 */
const CHANGES: [state: string, substate: string, at: string][] = [
  ["sleeping", "idle", at(-2, 22)],
  ["idle", "idle", at(-1, 6)],
  ["espresso", "pouring", at(-1, 8)],
  ["idle", "idle", at(-1, 8, 0, 30)],
  ["flush", "pouring", at(-1, 8, 10)],
  ["idle", "idle", at(-1, 8, 10, 10)],
  ["hotWater", "pouring", at(-1, 9)],
  ["idle", "idle", at(-1, 9, 0, 20)],
  ["steam", "pouring", at(-1, 12)],
  ["idle", "idle", at(-1, 12, 0, 45)],
  ["sleeping", "idle", at(-1, 21)],
];

let machineId: string;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("a Machine's page charts its use by day for the last 14 days, with each count's total, the time in each Machine State and the note about a tablet that was off", async ({ page }) => {
  const lab = await createLocation(page, "Lab", "America/Phoenix");
  machineId = await adopt(page, "Lab 1", lab.id);

  await page.goto(`/machines/${machineId}`);
  const use = page.getByRole("region", { name: "Use" });
  await expect(use.getByRole("tab", { name: "By day" })).toHaveAttribute("aria-selected", "true");
  await expect(use.getByRole("figure", { name: "Use by day" })).toBeVisible();
  await expectTip(use, "Use", /A Machine State lasts until the next one its tablet reports, so a Machine whose tablet was off counts as in its last state until the tablet is back\. Monitoring will correct this\./);

  // The last 14 days, today the last of them, with the range's days in its two fields.
  await expect(use.getByRole("button", { name: "From", exact: true })).toHaveText(dateText(-13));
  await expect(use.getByRole("button", { name: "To", exact: true })).toHaveText(dateText(0));
  // Yesterday's Shot and cleaning Shot, Steam Record, flush and hot water pour.
  await expectTotals(use, { Shots: "2", "Steam Records": "1", Flushes: "1", "Hot water pours": "1" });
  // What it did yesterday; how long it was asleep goes on until now, its tablet having said nothing since.
  const times = use.getByRole("region", { name: "Time in each Machine State" });
  await expect(field(times, "Idle")).toHaveText("14 h 58 min");
  await expect(field(times, "Steaming")).toHaveText("45 s");
  await expect(field(times, "Pulling a shot")).toHaveText("30 s");
  await expect(field(times, "Pouring hot water")).toHaveText("20 s");
  await expect(field(times, "Flushing")).toHaveText("10 s");
  await expect(field(times, "Asleep")).toHaveText(/^\d+ (d|h)\b/);

  // The same numbers as a table, a row a day.
  await use.getByRole("button", { name: "Show the numbers" }).click();
  const table = use.getByRole("table", { name: "Use by day" });
  await expect(rows(table)).toHaveCount(14);
  await expect(rows(table).nth(12).getByRole("cell")).toHaveText([
    dayText(-1),
    "2",
    "1",
    "1",
    "1",
    "Idle 14 h 58 min, Asleep 9 h, Steaming 45 s, Pulling a shot 30 s, Pouring hot water 20 s, Flushing 10 s",
  ]);
  // Before its tablet reported anything, nothing.
  await expect(rows(table).first().getByRole("cell")).toHaveText([dayText(-13), "0", "0", "0", "0", ""]);
});

test("the chart switches to one day by hour, today until another day is chosen, and back", async ({ page }) => {
  await page.goto(`/machines/${machineId}`);
  const use = page.getByRole("region", { name: "Use" });
  await use.getByRole("tab", { name: "By hour" }).click();
  await expect(use.getByRole("figure", { name: "Use by hour" })).toBeVisible();
  // Today so far: asleep, with nothing made.
  await expect(use.getByRole("button", { name: "Day", exact: true })).toHaveText(dateText(0));
  await expectTotals(use, { Shots: "0", "Steam Records": "0", Flushes: "0", "Hot water pours": "0" });

  await chooseDate(page, use, "Day", day(-1));
  await expect(use.getByRole("button", { name: "Day", exact: true })).toHaveText(dateText(-1));
  await expectTotals(use, { Shots: "2", "Steam Records": "1", Flushes: "1", "Hot water pours": "1" });
  const times = use.getByRole("region", { name: "Time in each Machine State" });
  await expect(field(times, "Idle")).toHaveText("14 h 58 min");
  await expect(field(times, "Asleep")).toHaveText("9 h");

  await use.getByRole("button", { name: "Show the numbers" }).click();
  const table = use.getByRole("table", { name: "Use by hour" });
  await expect(rows(table)).toHaveCount(24);
  const hour = (n: number) => rows(table).nth(n).getByRole("cell");
  await expect(hour(5)).toHaveText(["5 AM", "0", "0", "0", "0", "Asleep 1 h"]);
  // The Shot and the flush after it.
  await expect(hour(8)).toHaveText(["8 AM", "1", "0", "1", "0", "Idle 59 min 20 s, Pulling a shot 30 s, Flushing 10 s"]);
  await expect(hour(9)).toHaveText(["9 AM", "0", "0", "0", "1", "Idle 59 min 40 s, Pouring hot water 20 s"]);
  await expect(hour(12)).toHaveText(["12 PM", "0", "1", "0", "0", "Idle 59 min 15 s, Steaming 45 s"]);
  // The cleaning Shot, which no Machine State was reported for.
  await expect(hour(14)).toHaveText(["2 PM", "1", "0", "0", "0", "Idle 1 h"]);
  await expect(hour(23)).toHaveText(["11 PM", "0", "0", "0", "0", "Asleep 1 h"]);

  // Back by day, to the 14 days as before.
  await use.getByRole("tab", { name: "By day" }).click();
  await expect(use.getByRole("figure", { name: "Use by day" })).toBeVisible();
  await expect(rows(use.getByRole("table", { name: "Use by day" }))).toHaveCount(14);
});

test("another range is chosen by its first and last day, and one longer than 31 days is refused, the chart staying as it was", async ({ page }) => {
  await page.goto(`/machines/${machineId}`);
  const use = page.getByRole("region", { name: "Use" });
  await use.getByRole("button", { name: "Show the numbers" }).click();
  const table = use.getByRole("table", { name: "Use by day" });
  await expect(rows(table)).toHaveCount(14);

  // The two days before today.
  await chooseDate(page, use, "From", day(-2));
  await chooseDate(page, use, "To", day(-1));
  await expect(rows(table)).toHaveCount(2);
  // The night before yesterday, from 22:00.
  await expect(rows(table).first().getByRole("cell")).toHaveText([dayText(-2), "0", "0", "0", "0", "Asleep 2 h"]);
  await expectTotals(use, { Shots: "2", "Steam Records": "1", Flushes: "1", "Hot water pours": "1" });
  const times = use.getByRole("region", { name: "Time in each Machine State" });
  await expect(field(times, "Asleep")).toHaveText("11 h");

  await chooseDate(page, use, "From", day(-60));
  await expect(use.getByRole("alert")).toHaveText("Could not read its use: Choose a range of at most 31 days");
  await expect(rows(table)).toHaveCount(2);
});

/** A day `days` from today as a date field shows it, such as "Nov 9, 2026". */
function dateText(days: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(day(days));
}

/** A day `days` from today as the table names it, such as "Mon, Nov 9, 2026". */
function dayText(days: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(day(days));
}

/** That the card gives each count's total over the days or hours it shows. */
async function expectTotals(use: Locator, totals: Record<string, string>) {
  const list = use.locator('dl[aria-label="Totals"]');
  for (const [count, total] of Object.entries(totals)) await expect(field(list, count), count).toHaveText(total);
}

/** Picks a day in one of the card's calendars, going to its month and year first. */
async function chooseDate(page: Page, use: Locator, name: string, chosen: Date) {
  await use.getByRole("button", { name, exact: true }).click();
  const calendar = page.getByRole("dialog");
  await calendar.getByRole("combobox", { name: "Choose the Year" }).selectOption(String(chosen.getUTCFullYear()));
  await calendar.getByRole("combobox", { name: "Choose the Month" }).selectOption({ label: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" }).format(chosen) });
  await calendar.getByRole("button", { name: new RegExp(`, \\w+ ${chosen.getUTCDate()}(st|nd|rd|th), ${chosen.getUTCFullYear()}`) }).click();
  await expect(calendar).toHaveCount(0);
}

/**
 * Creates a machine entry at the Location since long before, and loads a
 * simulated tablet on its hardware, which backfills yesterday's Shots and
 * Steam Record and reports its Machine State changes: the Machine's id.
 */
async function adopt(page: Page, name: string, locationId: string): Promise<string> {
  const response = await page.request.post("/api/machines", { data: { name } });
  expect(response.status()).toBe(201);
  const { machine, token } = (await response.json()) as { machine: { id: string }; token: string };
  const moved = await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId, effectiveFrom: "2025-01-01T00:00:00Z" } });
  expect(moved.status()).toBe(201);
  // During yesterday's Shot at 08:00, a cleaning Shot at 14:00, and while it steamed at 12:00.
  const shots = [shotOf("lab-morning", at(-1, 8, 0, 5)), shotOf("lab-cleaning", at(-1, 14), "cleaning")];
  const steams = [derivedSteam("lab-steam", { timestamp: at(-1, 12, 0, 10) }, steamFixture())];
  const tablet = SimulatedTablet.load({ settings: settingsFor({ serverUrl: server.url(), token }), api: withSteams(withShots(derivedDe1Pro(HARDWARE), shots), steams), timeScale: 50 });
  await tablet.waitForLog(/^Connected to /);
  for (const [state, substate, observedAt] of CHANGES) {
    tablet.setPluginClockOffset(Date.parse(observedAt) - Date.now());
    tablet.reportState(state, substate);
  }
  tablet.setPluginClockOffset(0);
  const total = async (path: string) => ((await (await page.request.get(path)).json()) as { total: number }).total;
  await expect.poll(() => total(`/api/machines/${machine.id}/machine-state-events?limit=1`)).toBe(CHANGES.length);
  await expect.poll(() => total("/api/shots?limit=1")).toBe(shots.length);
  await expect.poll(() => total("/api/steam-records?limit=1")).toBe(steams.length);
  return machine.id;
}

/** A Shot pulled at a moment on the Lab's hardware, derived from the fixture, of its profile's type or the one given. */
function shotOf(id: string, pulledAt: string, type?: string): Record<string, unknown> {
  const fixture = shotFixture();
  const workflow = fixture.workflow as Record<string, Record<string, unknown>>;
  return {
    ...fixture,
    id,
    timestamp: pulledAt,
    workflow: { ...workflow, profile: { ...workflow.profile, ...(type !== undefined && { beverage_type: type }) }, machine: { ...workflow.machine, model: HARDWARE.model, serialNumber: HARDWARE.serial } },
  };
}
