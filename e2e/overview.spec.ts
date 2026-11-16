import { type BrowserContextOptions, expect, type Locator, type Page, test } from "@playwright/test";
import type pg from "pg";
import { preheatShotFixture, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { farFromMidnight } from "./support/calendar.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { expectTip, tap } from "./support/tooltips.js";

// The Overview (#471, #543), as an Admin: the home page's block for each
// Location and each Location's page's own, with a status card for each
// Machine and a table of the Recipes pulled in the period by Machine, a cell
// marking what the server judged out of spec (GLOSSARY.md) and a last
// column how far apart a Recipe's Machines are; at a desktop's width, and at
// a phone's.
//
// Simulated tablets running the built plugin backfill twelve Shots on two
// Machines at the Lab and one at the Harbor, each derived from one of two
// Shots Decaid recorded, changing only its id, time, recorded hardware and
// what the table names. The Recipes are made through the REST API once the
// tablets are unloaded, so none is written to one, and each Shot's Recipe
// is then set in PostgreSQL, with each Machine's Loaded Recipes: how a
// tablet's map and its Workflow make them is shot-recipe-links.spec.ts's to
// cover. The real Shots weighed 0.1 g and 1.3 g under their targets of 36 g,
// ran 23.549 s and 25.833 s after their Preheat, and stopped on weight.
// Hardware ids are made up.
//
// | Shot | Machine | Pulled, on its Location's wall clock | Recipe | What it is |
// |---|---|---|---|---|
// | left-house-1 | Lab Left | today 01:00 | House, slot 2 | −0.1 g, 23.549 s: the House's Reference Shot |
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
// | depot-none | Depot 1 | today 00:45, stored by a later test | none | −0.1 g, 23.549 s |
//
// A judgement needs three Shots, and a margin a duration no fixture ran, so
// eleven more are copies of those rows made in PostgreSQL, as
// server/test/shot-spec.test.ts makes its own, each changing only its id,
// time, Recipe and what the table names, a duration as the Shot's own with
// a Preheat of 0:
//
// | Copies | Of | Pulled today | Recipe | What each is |
// |---|---|---|---|---|
// | left-house-slow-1, -2 | left-house-1 | 01:12, 01:14 | House | 27 s |
// | left-house-last | left-house-1 | 02:25 | House | 27 s: the Left's last Shot |
// | right-house-2, -3 | right-house | 01:07, 01:09 | House | 24.5 s |
// | left-decaf-2, -3 | left-decaf | 01:42, 01:44 | Decaf | +2.5 g, ended by the Machine |
// | right-decaf-slow-1, -2, -3 | right-house | 00:05, 00:10, 00:15 | Decaf | 30 s |
// | right-none-last | right-house | 02:30 | none | 25 s, 6 g under, ended by the Machine: the Right's last Shot |
//
// So today, at the Lab, against the margins (10% of a Reference Shot's
// duration, 5% of a yield's target, 90% stopped at target, and 10% of the
// slower Machine's duration between Machines):
//
// | Recipe | Lab Left | Lab Right | Between Machines |
// |---|---|---|---|
// | Decaf, no Reference Shot | 3 Shots, 23.5 s; +2.5 g of 36, and 0 of 3 stopped at target: both out of spec | 3 Shots, 30 s | 6.5 s apart, of 30: out of spec |
// | House, reference 23.549 s | 5 Shots and 1 unfinished, median 27 s: +3.5 s, out of spec | 3 Shots, median 24.5 s: +1.0 s, within spec | 2.5 s apart, of 27: within spec |
// | no Recipe | 1 Shot and 1 cleaning | 1 Shot, 6 g under and ended by the Machine: too few to judge | |
//
// The days are counted back from today, so the Locations are where no day
// begins while this runs (`farFromMidnight`): the Harbor an hour or two ahead
// of the Lab, so its Shot, half an hour into its day, was pulled on the
// Lab's yesterday.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

const HOUR = 3_600_000;

/** The Lab's and the Depot's time zone, how many hours it is ahead of UTC, and how a time there names it. */
const { zone: ZONE, ahead: AHEAD, zoneName: ZONE_NAME } = farFromMidnight();
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

/** A Machine's name of one unbroken word, longer than a phone's column. */
const LONG_NAME = "HarborDownstairsBackBarSpare3";

/** A phone as wide as the ticket's: 390 px. */
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/** How a time reads beside what happened then: how long ago, yesterday's with its time of day, or a date. */
const RELATIVE = String.raw`(?:Just now|\d+ min ago|\d+ h ago|Yesterday, \d+:\d\d [AP]M|\d days ago|\w{3} \d+)`;
/** A regular expression of what an element reads as, each `<when>` in it a relative time and each space any blanks, as a line's end. */
const reads = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(" ", "\\s+").replaceAll("<when>", RELATIVE)}$`);

let recipes: Record<"house" | "decaf" | "guest" | "harborHouse", string>;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("the home page shows a block for each Location: how many Shots its numbers cover, a status card for each Machine there, and a row for each Recipe pulled today, in Recipe Slot order, the Shots with no Recipe last", async ({
  page,
}) => {
  await seed(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expectTip(page.getByRole("main"), "Overview", /^Each Location's Machines, and the Recipes pulled there today, yesterday or in the last 7 days, which are that Location's own days, in its time zone\. What is out of spec is marked with a triangle\./);
  await expect(page.getByRole("tablist", { name: "Period" }).getByRole("tab")).toHaveText(["Today", "Yesterday", "7 days"]);
  await expect(page.getByRole("tab", { name: "Today" })).toHaveAttribute("aria-selected", "true");
  // Overview is the first item of the top bar, and the page it is on.
  const nav = page.getByRole("banner").getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link").first()).toHaveText("Overview");
  await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  // Every Location, by name, each linked to its page. The Machine at no Location is in none.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Depot", "Harbor", "Lab"]);
  await expect(page.getByRole("heading", { name: "Lab", level: 2 }).getByRole("link")).toHaveAttribute("href", `/locations/${lab.id}`);
  await expect(page.getByText("Spare")).toHaveCount(0);

  // The Lab's heading says how many Shots today's numbers cover, the Unfinished Shot beside them and the cleaning Shot in neither.
  const labBlock = page.getByRole("region", { name: "Lab", exact: true });
  await expect(labBlock.getByText("16 Shots today · 1 unfinished", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Harbor", exact: true }).getByText("1 Shot today", { exact: true })).toBeVisible();

  // The Lab's two Machines, each on its status card: its tablet gone while it was awake, which is marked, when it was
  // last seen, its last Shot with its Recipe and duration and what of it is out of spec, and the Recipe it has loaded.
  await expect(cards(page, "Lab")).toHaveText(
    [
      reads("Lab Left Offline Last seen <when> Last Shot <when> House · 27.0 s Out of spec: +3.5 s vs reference Loaded: House (slot 2)"),
      reads("Lab Right Offline Last seen <when> Last Shot <when> No Recipe · 25.0 s Out of spec: −6.0 g vs target Loaded: House (slot 2)"),
    ],
    { useInnerText: true },
  );
  const left = card(page, "Lab", "Lab Left");
  await expect(mark(left).filter({ hasText: "Offline" })).toBeVisible();
  // Its last Shot's mark stands beside the link to it.
  await expect(mark(left).filter({ hasText: "vs reference" })).toHaveText("Out of spec: +3.5 s vs reference", { useInnerText: true });
  await expect(left.getByRole("link", { name: "House · 27.0 s" })).toHaveAttribute("href", "/shots/left-house-last");
  await expect(left.getByRole("link", { name: "House", exact: true })).toHaveAttribute("href", `/library/recipes/${recipes.house}`);
  await left.getByRole("link", { name: "Lab Left" }).click();
  await expect(page).toHaveURL(new RegExp(`/machines/${machines.left.id}$`));
  await page.goBack();

  // The Lab's table: a column for each Machine, by its name alone, and one for how far apart they are.
  const labTable = table(page, "Lab");
  await expect(labTable.getByRole("columnheader")).toHaveText(["Recipe", "Lab Left", "Lab Right", "Between Machines"]);
  // Decaf, in slot 1, before House, in slot 2, with its Reference Shot's duration and its Bean Batch's days since roast;
  // then the Shots pulled with no Recipe loaded.
  await expect(labTable.getByRole("rowheader")).toHaveText(["1 Decaf No reference", "2 House Reference 23.5 s · 12 d since roast", "No Recipe loaded"], { useInnerText: true });
  await expect(labTable.getByRole("rowheader").nth(1).getByLabel("Slot 2")).toHaveText("2");
  await labTable.getByRole("rowheader").getByRole("link", { name: "House" }).click();
  await expect(page).toHaveURL(new RegExp(`/library/recipes/${recipes.house}$`));
  await page.goBack();

  // The Harbor's Machine went offline asleep, as one left for the night: muted, not marked. Its Recipe was pulled half
  // an hour into its day there.
  await expect(cards(page, "Harbor")).toHaveText([reads("Harbor 1 Offline, asleep Last seen <when> Last Shot <when> Harbor House · 23.5 s Loaded: Harbor House (slot 1)")], { useInnerText: true });
  await expect(mark(card(page, "Harbor", "Harbor 1"))).toHaveCount(0);
  const harborTable = table(page, "Harbor");
  await expect(harborTable.getByRole("columnheader")).toHaveText(["Recipe", "Harbor 1", "Between Machines"]);
  await expect(harborTable.getByRole("rowheader")).toHaveText(["1 Harbor House No reference"], { useInnerText: true });
  await expect(cell(harborTable, "Harbor House", 0)).toHaveText("1 Shot · 23.5 s", { useInnerText: true });
  // One Machine has no other to be apart from.
  await expect(cell(harborTable, "Harbor House", 1)).toHaveText("");

  // A Location where nothing was pulled shows its Machine, which never connected, and says so, with no table.
  const depot = page.getByRole("region", { name: "Depot", exact: true });
  await expect(cards(page, "Depot")).toHaveText(["Depot 1 Offline Never connected No Shots yet No Recipe loaded"], { useInnerText: true });
  await expect(mark(card(page, "Depot", "Depot 1"))).toHaveCount(0);
  await expect(depot.getByText("No Shots today", { exact: true })).toBeVisible();
  await expect(depot.getByText("No Shots were pulled here today.")).toBeVisible();
  await expect(depot.getByRole("table")).toHaveCount(0);
});

test("a cell gives a Machine's Shots of a Recipe and their median duration, marks what is out of spec, says nothing of a yield and a stopping within spec, and opens its Shots in the Shots list", async ({
  page,
}) => {
  await page.goto("/");
  const labTable = table(page, "Lab");
  // House on the Left: five Shots and one unfinished, their median 27 s, 3.5 s over the Reference Shot's 23.5 s, which
  // is more than 10% of it: marked. Their yields and their stopping are within spec, and not shown.
  const house = cell(labTable, "House", 0);
  await expect(house).toHaveText("5 Shots · 27.0 s Out of spec: +3.5 s vs reference 1 unfinished", { useInnerText: true });
  await expect(mark(house)).toHaveText(["Out of spec: +3.5 s vs reference"], { useInnerText: true });
  // On the Right, three Shots 1.0 s over it, within spec: the difference in muted text, with no mark.
  await expect(cell(labTable, "House", 1)).toHaveText("3 Shots · 24.5 s +1.0 s vs reference", { useInnerText: true });
  await expect(mark(cell(labTable, "House", 1))).toHaveCount(0);

  // Decaf has no Reference Shot, so no difference. On the Left its three Shots weighed 2.5 g over their 36 g, more than
  // 5%, and the Machine ended all three: its yield and its stopping are out of spec, shown and marked.
  const decaf = cell(labTable, "Decaf", 0);
  await expect(decaf).toHaveText("3 Shots · 23.5 s Out of spec: +2.5 g vs target Out of spec: 0 of 3 stopped at target", { useInnerText: true });
  await expect(mark(decaf)).toHaveCount(2);
  // On the Right its three Shots are within both margins: the count and the median duration alone.
  await expect(cell(labTable, "Decaf", 1)).toHaveText("3 Shots · 30.0 s", { useInnerText: true });

  // With no Recipe: on the Left a Shot and a cleaning Shot, left out of the numbers; on the Right one Shot 6 g under its
  // target that its Machine ended, too few to judge, so both show in muted text, unmarked.
  const none = cell(labTable, "No Recipe loaded", 0);
  await expect(none).toHaveText("1 Shot · 23.5 s 1 cleaning or calibration", { useInnerText: true });
  const few = cell(labTable, "No Recipe loaded", 1);
  await expect(few).toHaveText("1 Shot · 25.0 s −6.0 g vs target 0 of 1 stopped at target", { useInnerText: true });
  await expect(mark(few)).toHaveCount(0);

  // Between Machines: Decaf's are 6.5 s apart, more than 10% of the slower one's 30 s, marked; House's 2.5 s, of 27 s,
  // muted; and the Shots with no Recipe are no Recipe's.
  const between = (recipe: string) => cell(labTable, recipe, 2);
  await expect(between("Decaf")).toHaveText("Out of spec: 6.5 s apart", { useInnerText: true });
  await expect(mark(between("Decaf"))).toHaveCount(1);
  await expect(between("House")).toHaveText("2.5 s apart", { useInnerText: true });
  await expect(mark(between("House"))).toHaveCount(0);
  await expect(between("No Recipe loaded")).toHaveText("");

  // A row's heading leads to its Reference Shot, or, with none, to the Recipe's Shots in the Shots list, to choose one.
  await expect(labTable.getByRole("rowheader").getByRole("link", { name: "Reference 23.5 s" })).toHaveAttribute("href", "/shots/left-house-1");
  await expect(labTable.getByRole("rowheader").getByRole("link", { name: "No reference" })).toHaveAttribute("href", `/shots?recipeId=${recipes.decaf}`);

  // The cell's link holds its filters: its Location, Machine, Recipe and today there. The Shot Summary of those filters
  // gives the cell's numbers and judgement, and the Shots list finds its Shots, the unfinished one among them.
  const filters = `locationId=${lab.id}&machineId=${machines.left.id}&recipeId=${recipes.house}&from=${date(0)}&to=${date(0)}`;
  await expect(house.getByRole("link")).toHaveAttribute("href", `/shots?${filters}`);
  const summary = (await (await page.request.get(`/api/shots/summary?${filters}&groupBy=recipe`)).json()) as {
    groups: { counts: Fields; numbers: Record<string, { median?: number; share?: number }>; spec: Record<string, { judgement: string; difference?: number }> }[];
  };
  expect(summary.groups[0]!.counts).toMatchObject({ shots: 5, unfinished: 1, cleaningAndCalibration: 0 });
  expect(summary.groups[0]!.numbers.duration!.median).toBe(27);
  expect(summary.groups[0]!.numbers.stoppedAtTarget!.share).toBe(1);
  expect(summary.groups[0]!.spec).toMatchObject({ duration: { judgement: "outOfSpec", difference: 3.451 }, yield: { judgement: "withinSpec" }, stoppedAtTarget: { judgement: "withinSpec" } });

  await house.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?${filters}$`));
  await expect(shotRows(page)).toHaveCount(6);
  const chosen = page.getByRole("region", { name: "Filters" });
  await expect(chosen.getByRole("combobox", { name: "Location", exact: true })).toHaveText("Lab");
  await expect(chosen.getByRole("combobox", { name: "Machine", exact: true })).toHaveText("Lab Left");
  await expect(chosen.getByRole("combobox", { name: "Recipe", exact: true })).toHaveText("House, Lab");
  await expect(chosen.getByRole("button", { name: "From", exact: true })).toHaveText(dateText(0));
  await expect(chosen.getByRole("button", { name: "To", exact: true })).toHaveText(dateText(0));
  await expect(field(page.getByRole("region", { name: "Summary" }), "Shots")).toHaveText("51 Unfinished Shot left out");

  // The Shots with no Recipe open as the list's filter for none.
  await page.goBack();
  await none.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?locationId=${lab.id}&machineId=${machines.left.id}&recipeId=none&from=${date(0)}&to=${date(0)}$`));
  await expect(shotRows(page)).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: "Recipe", exact: true })).toHaveText("Pulled with no Recipe loaded");
});

test("a mark has an icon and weight beside its colour, which meets 4.5:1 on its ground in the light and dark themes, and a relative time's tooltip opens by touch", async ({ page }) => {
  await page.goto("/");
  const house = cell(table(page, "Lab"), "House", 0);
  const marked = mark(house);
  await expect(marked).toBeVisible();
  await expect(marked.locator("svg")).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveClass(colorScheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    const { color, ground, weight } = await marked.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, ground: style.backgroundColor, weight: Number(style.fontWeight) };
    });
    expect(weight, colorScheme).toBeGreaterThanOrEqual(600);
    expect(contrast(color, ground), `${colorScheme}: ${color} on ${ground}`).toBeGreaterThanOrEqual(4.5);
  }
  await page.emulateMedia({ colorScheme: "light" });

  // A status card's times are relative, each a button whose tooltip gives the exact time on the Location's clock. A tap
  // opens it, as a touchscreen has no hover; Escape closes it.
  const lastShot = card(page, "Lab", "Lab Left").getByText(/^Last Shot/).getByRole("button");
  await expect(lastShot).toHaveText(new RegExp(`^${RELATIVE}$`));
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await tap(lastShot);
  // Pulled at 02:25 at the Lab.
  await expect(page.getByRole("tooltip")).toHaveText(new RegExp(`^\\w{3} \\d+, \\d{4}, 2:25 AM ${ZONE_NAME.replace("+", "\\+")}$`));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  // When it was last seen opens the same way.
  await tap(card(page, "Lab", "Lab Left").getByText(/^Last seen/).getByRole("button"));
  await expect(page.getByRole("tooltip")).toHaveText(new RegExp(`^\\w{3} \\d+, \\d{4}, \\d+:\\d\\d [AP]M ${ZONE_NAME.replace("+", "\\+")}$`));
  await page.keyboard.press("Escape");
});

test("the period switches to yesterday and to the last 7 days, and stays in the address", async ({ page }) => {
  await page.goto("/");
  const labTable = table(page, "Lab");
  const labBlock = page.getByRole("region", { name: "Lab", exact: true });
  await expect(labTable.getByRole("rowheader")).toHaveCount(3);

  // Yesterday the Right alone pulled a Decaf, 1.3 g under its target, within spec; the Left stays, as it is here.
  // Nothing was pulled at the Harbor.
  await page.getByRole("tab", { name: "Yesterday" }).click();
  await expect(page).toHaveURL(/\/\?period=yesterday$/);
  await expect(labBlock.getByText("1 Shot yesterday", { exact: true })).toBeVisible();
  await expect(labTable.getByRole("rowheader")).toHaveText(["1 Decaf No reference"], { useInnerText: true });
  await expect(labTable.getByRole("columnheader")).toHaveText(["Recipe", "Lab Left", "Lab Right", "Between Machines"]);
  await expect(cards(page, "Lab")).toHaveCount(2);
  await expect(cell(labTable, "Decaf", 0)).toHaveText("");
  await expect(cell(labTable, "Decaf", 1)).toHaveText("1 Shot · 25.8 s", { useInnerText: true });
  await expect(cell(labTable, "Decaf", 2)).toHaveText("");
  await expect(page.getByRole("region", { name: "Harbor", exact: true }).getByText("No Shots were pulled here yesterday.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Depot", exact: true }).getByText("No Shots were pulled here yesterday.")).toBeVisible();

  // The last 7 days, today the last: the Recipes in slots, then the one in none, then the Shots with no Recipe. The
  // House pulled 8 days ago is in none of them.
  await page.getByRole("tab", { name: "7 days" }).click();
  await expect(page).toHaveURL(/\/\?period=week$/);
  await expect(labBlock.getByText("18 Shots in the last 7 days · 1 unfinished", { exact: true })).toBeVisible();
  await expect(labTable.getByRole("rowheader")).toHaveText(["1 Decaf No reference", "2 House Reference 23.5 s · 12 d since roast", "Guest No reference", "No Recipe loaded"], { useInnerText: true });
  await expect(cell(labTable, "Decaf", 0)).toHaveText("3 Shots · 23.5 s Out of spec: +2.5 g vs target Out of spec: 0 of 3 stopped at target", { useInnerText: true });
  // Its four on the Right: three of 30 s and yesterday's.
  await expect(cell(labTable, "Decaf", 1)).toHaveText("4 Shots · 30.0 s", { useInnerText: true });
  await expect(cell(labTable, "House", 1)).toHaveText("3 Shots · 24.5 s +1.0 s vs reference", { useInnerText: true });
  await expect(cell(labTable, "Guest", 0)).toHaveText("");
  const guest = cell(labTable, "Guest", 1);
  await expect(guest).toHaveText("1 Shot · 23.5 s", { useInnerText: true });
  await expect(page.getByRole("region", { name: "Harbor", exact: true }).getByRole("rowheader")).toHaveText(["1 Harbor House No reference"], { useInnerText: true });

  // A cell opens the seven days' Shots, and coming back from them the period is as it was, as after a reload.
  await expect(guest.getByRole("link")).toHaveAttribute("href", `/shots?locationId=${lab.id}&machineId=${machines.right.id}&recipeId=${recipes.guest}&from=${date(-6)}&to=${date(0)}`);
  await guest.getByRole("link").click();
  await expect(shotRows(page)).toHaveCount(1);
  await page.goBack();
  await expect(page.getByRole("tab", { name: "7 days" })).toHaveAttribute("aria-selected", "true");
  await expect(labTable.getByRole("rowheader")).toHaveCount(4);
  await page.reload();
  await expect(page.getByRole("tab", { name: "7 days" })).toHaveAttribute("aria-selected", "true");
  await expect(labTable.getByRole("rowheader")).toHaveCount(4);

  await page.getByRole("tab", { name: "Today" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(labTable.getByRole("rowheader")).toHaveCount(3);
});

test("on a phone, nothing scrolls sideways with two Machines: the status cards stack, and the table keeps its two Machine columns with shorter cells, how far apart the Machines are under the Recipe", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: server.url(), ...PHONE });
  try {
    const page = await context.newPage();
    await signInAsAdmin(page);
    await page.goto("/");
    const labTable = table(page, "Lab");
    await expect(labTable.getByRole("rowheader")).toHaveCount(3);
    await expectFits(page);
    // Overview is the first item of the menu.
    await page.getByRole("banner").getByRole("button", { name: "Menu" }).click();
    await expect(page.getByRole("dialog", { name: "Decent Sync" }).getByRole("navigation", { name: "Main" }).getByRole("link").first()).toHaveText("Overview");
    await page.keyboard.press("Escape");

    // The cards one under the other, each as wide as the block.
    const [first, second] = await Promise.all([card(page, "Lab", "Lab Left").boundingBox(), card(page, "Lab", "Lab Right").boundingBox()]);
    expect(second!.x).toBe(first!.x);
    expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
    await expect(mark(card(page, "Lab", "Lab Left")).filter({ hasText: "Offline" })).toBeVisible();
    await expect(mark(card(page, "Lab", "Lab Left")).filter({ hasText: "+3.5 s vs reference" })).toBeVisible();
    // The Machine that went offline asleep, and the one that never connected, are not marked here either.
    await expect(card(page, "Harbor", "Harbor 1")).toContainText("Offline, asleep");
    await expect(mark(card(page, "Harbor", "Harbor 1"))).toHaveCount(0);

    // Both Machines' columns, and no Between Machines column: within the block, with nothing to scroll.
    await expect(labTable.getByRole("columnheader")).toHaveText(["Recipe", "Lab Left", "Lab Right"]);
    expect(await labTable.evaluate((element) => element.parentElement!.scrollWidth - element.parentElement!.clientWidth)).toBe(0);
    // A cell's lines without the words its column and row already say, which a screen reader still hears: a marked
    // difference, a muted one, a yield and a stopping out of spec, and those of a cell too small to judge, muted.
    await expect(shown(cell(labTable, "House", 0))).toHaveText(["+3.5 s"]);
    await expect(cell(labTable, "House", 0).getByText("+3.5 s vs reference", { exact: true })).toHaveCSS("position", "absolute");
    await expect(mark(cell(labTable, "House", 0))).toHaveCount(1);
    await expect(shown(cell(labTable, "House", 1))).toHaveText(["+1.0 s"]);
    await expect(mark(cell(labTable, "House", 1))).toHaveCount(0);
    await expect(shown(cell(labTable, "Decaf", 0))).toHaveText(["+2.5 g", "0 of 3 at target"]);
    await expect(mark(cell(labTable, "Decaf", 0))).toHaveCount(2);
    await expect(shown(cell(labTable, "Decaf", 1))).toHaveCount(0);
    await expect(shown(cell(labTable, "No Recipe loaded", 1))).toHaveText(["−6.0 g", "0 of 1 at target"]);
    await expect(mark(cell(labTable, "No Recipe loaded", 1))).toHaveCount(0);
    await expect(cell(labTable, "House", 0)).toContainText("1 unfinished");
    // Between Machines, under each Recipe's name: Decaf's marked, House's muted.
    const heading = (recipe: string) => labTable.getByRole("rowheader").filter({ hasText: recipe });
    await expect(heading("Decaf").getByText("6.5 s apart")).toBeVisible();
    await expect(mark(heading("Decaf"))).toHaveText(["Out of spec: 6.5 s apart"], { useInnerText: true });
    await expect(heading("House").getByText("2.5 s apart")).toBeVisible();
    await expect(mark(heading("House"))).toHaveCount(0);
    await expect(heading("Decaf").getByRole("link", { name: "No reference" })).toBeVisible();
    await expect(heading("House").getByRole("link", { name: "Reference 23.5 s" })).toBeVisible();

    // The Location's page fits too, its period control in its block's heading.
    await page.goto(`/locations/${lab.id}`);
    const overview = page.getByRole("region", { name: "Overview", exact: true });
    await expect(overview.getByRole("table", { name: "Recipes by Machine at Lab" }).getByRole("rowheader")).toHaveCount(3);
    await expect(overview.getByRole("tablist", { name: "Period" })).toBeVisible();
    await expectFits(page);
  } finally {
    await context.close();
  }
});

test("a Machine moved away in the period keeps its card and its column where it pulled Shots, and has them where it is now", async ({ page }) => {
  // From now, by the server's clock: a time of this process's could be ahead of it, and refused as in the future.
  const moved = await page.request.post(`/api/machines/${machines.right.id}/location-history`, { data: { locationId: harbor.id } });
  expect(moved.status()).toBe(201);

  await page.goto("/");
  // At the Lab after the Machine here now, saying where it is, with the Shots it pulled here.
  const labTable = table(page, "Lab");
  await expect(labTable.getByRole("columnheader")).toHaveText(["Recipe", "Lab Left", "Lab Right", "Between Machines"]);
  await expect(card(page, "Lab", "Lab Right")).toContainText("Now at Harbor");
  await expect(cell(labTable, "House", 1)).toHaveText("3 Shots · 24.5 s +1.0 s vs reference", { useInnerText: true });
  // At the Harbor, where it has pulled none.
  const harborTable = table(page, "Harbor");
  await expect(harborTable.getByRole("columnheader")).toHaveText(["Recipe", "Harbor 1", "Lab Right", "Between Machines"]);
  await expect(cards(page, "Harbor")).toHaveCount(2);
  await expect(card(page, "Harbor", "Lab Right")).not.toContainText("Now at");
  await expect(cell(harborTable, "Harbor House", 0)).toHaveText("1 Shot · 23.5 s", { useInnerText: true });
  await expect(cell(harborTable, "Harbor House", 1)).toHaveText("");
});

test("a Location's page shows its own block, with its choice of period in its heading, and no Machines card", async ({ page }) => {
  await page.goto(`/locations/${lab.id}`);
  const overview = page.getByRole("region", { name: "Overview", exact: true });
  // Its tooltip gives the margins and what stopped at target means, and ends with how often it is read.
  await expectTip(
    overview,
    "Overview",
    /out of spec more than 10% from it\. Their yield shows only when out of spec, the median more than 5% from each Shot's own target, and their stopping only when under 90% of them stopped at target: Decaid stopping the Shot at its target weight or, with no scale, its target volume\. Fewer than 3 Shots are not judged.*A cell opens its Shots in the Shots list\. The status is read again every 5 seconds, and the numbers every 30\.$/,
  );
  // Its heading: the title, how many Shots the period's numbers cover, and the period.
  await expect(overview.getByRole("heading", { name: "Overview", level: 2 })).toBeVisible();
  await expect(overview.getByText("16 Shots today · 1 unfinished", { exact: true })).toBeVisible();
  await expect(overview.getByRole("tablist", { name: "Period" }).getByRole("tab")).toHaveText(["Today", "Yesterday", "7 days"]);
  // Its status cards are its Machines, the one since moved among them: the page has no Machines card.
  await expect(cards(page, "Lab", overview)).toHaveText(
    [
      reads("Lab Left Offline Last seen <when> Last Shot <when> House · 27.0 s Out of spec: +3.5 s vs reference Loaded: House (slot 2)"),
      reads("Lab Right Offline Last seen <when> Last Shot <when> No Recipe · 25.0 s Out of spec: −6.0 g vs target Loaded: House (slot 2) Now at Harbor"),
    ],
    { useInnerText: true },
  );
  await expect(page.getByRole("region", { name: "Machines" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Overview", "Recipes"]);
  const labTable = overview.getByRole("table", { name: "Recipes by Machine at Lab" });
  await expect(labTable.getByRole("columnheader")).toHaveText(["Recipe", "Lab Left", "Lab Right", "Between Machines"]);
  await expect(labTable.getByRole("rowheader")).toHaveText(["1 Decaf No reference", "2 House Reference 23.5 s · 12 d since roast", "No Recipe loaded"], { useInnerText: true });
  await expect(cell(labTable, "House", 0)).toHaveText("5 Shots · 27.0 s Out of spec: +3.5 s vs reference 1 unfinished", { useInnerText: true });
  await expect(cell(labTable, "Decaf", 2)).toHaveText("Out of spec: 6.5 s apart", { useInnerText: true });

  await overview.getByRole("tab", { name: "Yesterday" }).click();
  await expect(page).toHaveURL(new RegExp(`/locations/${lab.id}\\?period=yesterday$`));
  await expect(overview.getByText("1 Shot yesterday", { exact: true })).toBeVisible();
  await expect(labTable.getByRole("rowheader")).toHaveText(["1 Decaf No reference"], { useInnerText: true });
  await expect(cell(labTable, "Decaf", 1)).toHaveText("1 Shot · 25.8 s", { useInnerText: true });
  // The page's other card is as before.
  await expect(page.getByRole("region", { name: "Recipes", exact: true })).toBeVisible();
});

test("the Machines' status is read again every 5 seconds, and the numbers every 30", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  const depot = page.getByRole("region", { name: "Depot", exact: true });
  const depotCard = card(page, "Depot", "Depot 1");
  await expect(depotCard).toContainText("Offline");
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
  await expect(depotCard).toContainText("Never connected");

  // Five seconds on, the status is read again, with its last Shot, and the numbers are not.
  await page.clock.fastForward(5_000);
  await expect(depotCard).toContainText("Online");
  await expect(depotCard.getByRole("link", { name: "No Recipe · 23.5 s" })).toHaveAttribute("href", "/shots/depot-none");
  await expect(depot.getByText("No Shots were pulled here today.")).toBeVisible();
  expect(summariesRead).toBe(0);

  // Thirty seconds after they were read, the numbers are too.
  await page.clock.fastForward(25_000);
  await expect(cell(table(page, "Depot"), "No Recipe loaded", 0)).toHaveText("1 Shot · 23.5 s", { useInnerText: true });
  await expect(depot.getByText("No Shots were pulled here today.")).toHaveCount(0);
  await expect(depot.getByText("1 Shot today", { exact: true })).toBeVisible();
  // And the count above was of something: these readings were counted.
  await expect.poll(() => summariesRead).toBeGreaterThan(0);
});

test("on a phone, with three Machines the page still fits: the table scrolls within its block, and the Recipe column stays in place", async ({ browser, page }) => {
  // A third Machine at the Harbor, beside its own and the one moved there, with a name of one long word, which wraps
  // within its card and its column rather than widening them.
  const created = await page.request.post("/api/machines", { data: { name: LONG_NAME } });
  expect(created.status()).toBe(201);
  const { machine } = (await created.json()) as { machine: { id: string } };
  expect((await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId: harbor.id } })).status()).toBe(201);

  const context = await browser.newContext({ baseURL: server.url(), ...PHONE });
  try {
    const phone = await context.newPage();
    await signInAsAdmin(phone);
    await phone.goto("/");
    const harborTable = table(phone, "Harbor");
    await expect(harborTable.getByRole("columnheader")).toHaveText(["Recipe", "Harbor 1", LONG_NAME, "Lab Right"]);
    await expect(cards(phone, "Harbor")).toHaveCount(3);
    await expectFits(phone);
    // The long name wraps within its column's heading and its card: neither is wider than what holds it.
    for (const holder of [harborTable.getByRole("columnheader", { name: LONG_NAME }), card(phone, "Harbor", LONG_NAME)]) {
      expect(await holder.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    }

    // The table is wider than its block, and scrolls in its own container.
    const scroller = harborTable.locator("xpath=..");
    const overflow = await scroller.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeGreaterThan(0);
    const heading = harborTable.getByRole("rowheader").first();
    const lastColumn = harborTable.getByRole("columnheader", { name: "Lab Right" });
    const before = { heading: await heading.boundingBox(), column: await lastColumn.boundingBox() };
    await scroller.evaluate((element) => element.scrollTo({ left: element.scrollWidth }));
    await expect.poll(async () => (await lastColumn.boundingBox())!.x).toBe(before.column!.x - overflow);
    // The cells moved under the Recipe column, which is where it was, and the page still fits.
    expect((await heading.boundingBox())!.x).toBe(before.heading!.x);
    await heading.scrollIntoViewIfNeeded();
    await expect(heading).toBeInViewport({ ratio: 1 });
    await expectFits(phone);
  } finally {
    await context.close();
  }
});

/** The tablet with this serial, its Decaid holding no Library of its own, so the Library is only what the spec makes. */
function emptyLibrary(serial: string) {
  return { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS };
}

/** A Location's block's table on the home page. */
function table(page: Page, location: string): Locator {
  return page.getByRole("region", { name: location, exact: true }).getByRole("table", { name: `Recipes by Machine at ${location}` });
}

/** The cell of the row whose heading starts with `recipe`, after its Recipe Slot if it is in one, under the Machine at `column`, counted from 0, the one after the last Machine's being Between Machines. */
function cell(table: Locator, recipe: string, column: number): Locator {
  const heading = table.page().getByRole("rowheader").filter({ hasText: new RegExp(`^\\d?${recipe}`) });
  return table.getByRole("row").filter({ has: heading }).getByRole("cell").nth(column);
}

/** A Location's block's status cards: one for each of its Machines, within `scope`, the Location's block on the home page where none is given. */
function cards(page: Page, location: string, scope: Locator = page.getByRole("region", { name: location, exact: true })): Locator {
  return scope.getByRole("list", { name: `Machines at ${location}` }).getByRole("listitem");
}

/** The status card of the Machine named, in a Location's block on the home page. */
function card(page: Page, location: string, machine: string): Locator {
  return cards(page, location).filter({ has: page.getByRole("link", { name: machine, exact: true }) });
}

/** What is marked within `scope`: each out-of-spec mark (web/src/components/spec-mark.tsx). */
function mark(scope: Locator): Locator {
  return scope.locator('[data-slot="spec-mark"]');
}

/** The lines of a cell as a narrow screen words them: those shown in place of the full wording, which stays for a screen reader. */
function shown(scope: Locator): Locator {
  return scope.locator('[aria-hidden="true"]:not(svg)');
}

/** The contrast of two colours as a computed style gives them, `rgb(r, g, b)`, by WCAG's relative luminance. */
function contrast(text: string, ground: string): number {
  const luminance = (color: string) => {
    const channels = /^rgba?\((\d+), (\d+), (\d+)(?:, [\d.]+)?\)$/.exec(color);
    if (!channels) throw new Error(`Not an sRGB colour: ${color}`);
    const [red, green, blue] = channels.slice(1, 4).map((channel) => {
      const value = Number(channel) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(text), luminance(ground)].sort((a, b) => b - a) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** The page is no wider than the phone's screen: what is wider, such as a table, scrolls within it. */
async function expectFits(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect({ scrollWidth, clientWidth }, `${new URL(page.url()).pathname} fits the screen`).toEqual({ scrollWidth: 390, clientWidth: 390 });
}

/**
 * Copies a Shot's row in PostgreSQL under another id, with the columns
 * given, and its record's stop reason where one is given.
 */
async function copyShot(database: pg.Client, from: string, id: string, columns: Fields, stopReason?: string) {
  const record = stopReason === undefined ? {} : { record: { ...(await database.query<{ record: Fields }>("SELECT record FROM shots WHERE id = $1", [from])).rows[0]!.record, stopReason } };
  await database.query("INSERT INTO shots SELECT (jsonb_populate_record(NULL::shots, to_jsonb(s) || $2::jsonb)).* FROM shots AS s WHERE s.id = $1", [from, JSON.stringify({ id, ...columns, ...record })]);
}

function shotRows(page: Page): Locator {
  return page.getByRole("table", { name: "Shots" }).getByRole("row").filter({ has: page.getByRole("cell") });
}

/**
 * Three Locations and five Machines: two at the Lab and one at the Harbor,
 * each there since long before its Shots, which its tablet backfills; one
 * at the Depot whose tablet never connected; and one at no Location. Then,
 * the tablets unloaded, the Recipes, each Shot's Recipe, the copies that
 * make groups large enough to judge, the Recipes each Machine had loaded,
 * and the House's Reference Shot.
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
  // The Left's tablet reports its Machine idle and the Harbor's asleep, as one left for the night, the Right's nothing.
  tablets[0]!.reportState("idle", "idle");
  tablets[2]!.reportState("sleeping", "idle");
  const stateOf = async (machine: { id: string }) =>
    ((await (await page.request.get(`/api/machines/${machine.id}`)).json()) as { machine: { machineState: { state: string } | null } }).machine.machineState?.state;
  await expect.poll(() => stateOf(machines.left)).toBe("idle");
  await expect.poll(() => stateOf(machines.harbor1)).toBe("sleeping");
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
  // loaded: the Left the House again since 02:15, after its Decaf and a while with none, and the Right the House
  // again since half an hour into today.
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
    [machines.left, recipes.house, at(0, 2, 15), null],
    [machines.right, recipes.house, at(-9, 0), at(-4, 0)],
    [machines.right, recipes.guest, at(-4, 0), at(-2, 0)],
    [machines.right, recipes.decaf, at(-2, 0), at(0, 0, 30)],
    [machines.right, recipes.house, at(0, 0, 30), null],
    [machines.harbor1, recipes.harborHouse, at(-9, 0, 0, HARBOR.ahead), null],
  ];
  const database = await server.connectDatabase();
  try {
    for (const [id, recipeId] of Object.entries(pulledWith)) await database.query("UPDATE shots SET recipe_id = $2 WHERE id = $1", [id, recipeId]);
    // The copies, each of a Shot on its own Machine: its time today, its Recipe, and a duration of its own with no Preheat.
    const timed = (hours: number, minutes: number, recipeId: string | null, duration?: number) => ({ pulled_at: at(0, hours, minutes), recipe_id: recipeId, ...(duration !== undefined && { duration, preheat: 0 }) });
    await copyShot(database, "left-house-1", "left-house-slow-1", timed(1, 12, recipes.house, 27));
    await copyShot(database, "left-house-1", "left-house-slow-2", timed(1, 14, recipes.house, 27));
    await copyShot(database, "left-house-1", "left-house-last", timed(2, 25, recipes.house, 27));
    await copyShot(database, "right-house", "right-house-2", timed(1, 7, recipes.house, 24.5));
    await copyShot(database, "right-house", "right-house-3", timed(1, 9, recipes.house, 24.5));
    await copyShot(database, "left-decaf", "left-decaf-2", timed(1, 42, recipes.decaf));
    await copyShot(database, "left-decaf", "left-decaf-3", timed(1, 44, recipes.decaf));
    for (const [n, minutes] of [5, 10, 15].entries()) await copyShot(database, "right-house", `right-decaf-slow-${n + 1}`, timed(0, minutes, recipes.decaf, 30));
    // 6 g under its target of 36, and ended by its Machine.
    await copyShot(database, "right-house", "right-none-last", { ...timed(2, 30, null, 25), actual_yield: 30 }, "machineEnded");
    for (const [{ id }, recipeId, loadedAt, unloadedAt] of loaded) {
      await database.query("INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at, unloaded_at) VALUES ($1, $2, $3, $4)", [id, recipeId, loadedAt, unloadedAt]);
    }
  } finally {
    await database.end();
  }
  // The House is read against its own first Shot on the Left, of 23.549 s.
  expect((await page.request.put(`/api/recipes/${recipes.house}/reference-shot`, { data: { shotId: "left-house-1" } })).status()).toBe(200);
}
