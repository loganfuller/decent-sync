import { type BrowserContextOptions, expect, type Locator, type Page, test } from "@playwright/test";
import { useFreshServer } from "./support/fresh-server.js";
import { type JudgedShots, seedJudgedShots } from "./support/judged-shots.js";
import { chooseFilter, closeFilters, datesPreset, field, filterChip, openCard, openFilters, rows } from "./support/locators.js";
import { signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// The Shots list (#544), as an Admin: its date presets, its other filters
// behind one button with a chip for each that is set, its rating filter,
// its Trend closed until opened, with a line for each Machine of one Recipe
// against its Reference Shot's duration, its Summary marking what is out of
// spec, and its rows, under a heading for each day, with what of each Shot
// is out of spec; at a desktop's width, and at a phone's.
//
// The Locations, Machines, Recipes and Shots are those of
// support/judged-shots.ts, which describes them: two Machines at the Lab,
// whose Shots of today are the House's, with a Reference Shot of 23.549 s,
// the Decaf's, with none, and some pulled with no Recipe. Three of them are
// then rated here, through the server: the House's Reference Shot five
// stars, the Left's last three, and the Right's first of the House a star
// and a half.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

let lab: JudgedShots["lab"];
let machines: JudgedShots["machines"];
let recipes: JudgedShots["recipes"];

/** A phone as wide as the ticket's: 390 px. */
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/** A day's heading: today's and yesterday's named so, with the day. */
const TODAY = /^Today, \w{3} \w{3} \d+$/;
const YESTERDAY = /^Yesterday, \w{3} \w{3} \d+$/;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("the date presets stay in view and narrow the list to each Location's own days, and the preset chosen is kept in the address", async ({ page }) => {
  ({ lab, machines, recipes } = await seedJudgedShots(page, server));
  for (const [id, rating] of [["left-house-1", 10], ["left-house-last", 6], ["right-house", 3]] as const) {
    expect((await page.request.patch(`/api/shots/${id}`, { data: { rating } })).status()).toBe(200);
  }

  await page.goto("/shots");
  // Every Shot, with no preset chosen: 22 of them.
  await expect(page.getByText("Shots 1–22 of 22")).toBeVisible();
  const presets = page.getByRole("radiogroup", { name: "Dates" }).getByRole("radio");
  await expect(presets).toHaveText(["Today", "Yesterday", "7 days", "30 days", "Custom"]);
  await expect(page.getByRole("radiogroup", { name: "Dates" }).getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "From", exact: true })).toHaveCount(0);

  // Today's: the Lab's 18 and the Harbor's one, pulled on the Lab's yesterday, which is the Harbor's today.
  await datesPreset(page, "Today").click();
  await expect(page).toHaveURL(/\/shots\?period=today$/);
  await expect(page.getByText("Shots 1–19 of 19")).toBeVisible();
  await expect(shotRows(page).filter({ hasText: "Harbor 1" })).toHaveCount(1);
  // Yesterday's is the Right's Decaf, and the 7 days leave out the House pulled 8 days ago, which the 30 days hold.
  await datesPreset(page, "Yesterday").click();
  await expect(page).toHaveURL(/\/shots\?period=yesterday$/);
  await expect(shotRows(page)).toHaveCount(1);
  await expect(shotRows(page).first()).toContainText("Lab Right");
  await datesPreset(page, "7 days").click();
  await expect(page.getByText("Shots 1–21 of 21")).toBeVisible();
  await datesPreset(page, "30 days").click();
  await expect(page.getByText("Shots 1–22 of 22")).toBeVisible();
  // The summary follows the preset, as it follows every filter.
  await datesPreset(page, "Yesterday").click();
  await expect(field(page.getByRole("region", { name: "Summary" }), "Shots")).toHaveText("1");

  // A reloaded or shared address shows the same days.
  await page.reload();
  await expect(datesPreset(page, "Yesterday")).toBeChecked();
  await expect(shotRows(page)).toHaveCount(1);

  // Custom opens the From and To fields, whose dates take the preset's place; a preset then takes theirs.
  await datesPreset(page, "Custom").click();
  await expect(page).toHaveURL(/\/shots$/);
  await expect(page.getByRole("button", { name: "From", exact: true })).toHaveText("Any date");
  await expect(page.getByRole("button", { name: "To", exact: true })).toHaveText("Any date");
  await page.goto("/shots?from=2026-01-01&to=2026-01-02");
  await expect(datesPreset(page, "Custom")).toBeChecked();
  await expect(page.getByRole("button", { name: "From", exact: true })).toHaveText("Jan 1, 2026");
  await datesPreset(page, "Today").click();
  await expect(page).toHaveURL(/\/shots\?period=today$/);
  await expect(page.getByRole("button", { name: "From", exact: true })).toHaveCount(0);
  // Pressed again, the preset is cleared.
  await datesPreset(page, "Today").click();
  await expect(page).toHaveURL(/\/shots$/);
  await expect(page.getByText("Shots 1–22 of 22")).toBeVisible();
});

test("the other filters open from one button that says how many are set, each one set shows as a chip that names it and removes it, and the rating filter finds rated Shots", async ({ page }) => {
  await page.goto("/shots?period=today");
  const bar = page.getByRole("region", { name: "Filters" });
  const button = bar.getByRole("button", { name: /^Filters/ });
  await expect(button).toHaveText("Filters");
  await expect(page.getByRole("list", { name: "Filters set" })).toHaveCount(0);

  // Every filter but the dates is behind the button, in a popover on a wide screen.
  const filters = await openFilters(page);
  await expect(filters.getByRole("combobox")).toHaveCount(10);
  for (const name of ["Location", "Machine", "Recipe", "Bean", "Bean Batch", "Grinder", "Basket", "Barista", "Profile", "Rating"]) {
    await expect(filters.getByRole("combobox", { name, exact: true })).toBeVisible();
  }
  await closeFilters(page);

  // Two set: each is a chip, and the button counts them.
  await chooseFilter(page, "Recipe", "House, Lab");
  await chooseFilter(page, "Machine", "Lab Left");
  await expect(page).toHaveURL(new RegExp(`/shots\\?period=today&recipeId=${recipes.house}&machineId=${machines.left.id}$`));
  await expect(button).toHaveText("Filters2, 2 set");
  await expect(page.getByRole("list", { name: "Filters set" }).getByRole("listitem")).toHaveText(["Machine:Lab Left", "Recipe:House, Lab"]);
  await expect(page.getByText("Shots 1–6 of 6")).toBeVisible();
  // A chip removes its filter, leaving the other and the preset.
  await filterChip(page, "Machine").getByRole("button", { name: "Remove the Machine filter" }).click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?period=today&recipeId=${recipes.house}$`));
  await expect(button).toHaveText("Filters1, 1 set");
  await expect(page.getByText("Shots 1–9 of 9")).toBeVisible();

  // The rating filter: any rating, rated, not rated, or a least number of stars.
  await (await openFilters(page)).getByRole("combobox", { name: "Rating", exact: true }).click();
  await expect(page.getByRole("option")).toHaveText(["Any rating", "Rated", "Not rated", "5 stars", "4 stars or more", "3 stars or more", "2 stars or more"]);
  await page.getByRole("option", { name: "Rated", exact: true }).click();
  await closeFilters(page);
  await expect(page).toHaveURL(new RegExp(`/shots\\?period=today&recipeId=${recipes.house}&rating=rated$`));
  await expect(filterChip(page, "Rating")).toHaveText("Rating:Rated");
  // The House's three rated Shots, newest first, and their summary.
  await expect.poll(() => shotIds(page)).toEqual(["left-house-last", "right-house", "left-house-1"]);
  await expect(field(page.getByRole("region", { name: "Summary" }), "Shots")).toHaveText("3");
  // Three stars or more leaves out the one of a star and a half, and five stars finds the Reference Shot alone.
  await chooseFilter(page, "Rating", "3 stars or more");
  await expect(filterChip(page, "Rating")).toHaveText("Rating:3 stars or more");
  await expect.poll(() => shotIds(page)).toEqual(["left-house-last", "left-house-1"]);
  await chooseFilter(page, "Rating", "5 stars");
  await expect.poll(() => shotIds(page)).toEqual(["left-house-1"]);
  await chooseFilter(page, "Rating", "Not rated");
  await expect(page.getByText("Shots 1–6 of 6")).toBeVisible();

  // Clear removes every chip's filter, and leaves the preset.
  await bar.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page).toHaveURL(/\/shots\?period=today$/);
  await expect(page.getByRole("list", { name: "Filters set" })).toHaveCount(0);
  await expect(datesPreset(page, "Today")).toBeChecked();

  // "No reference", on the Overview and on a Recipe's page, opens the list at that Recipe's rated Shots.
  await page.goto("/");
  await page.getByRole("region", { name: "Lab", exact: true }).getByRole("rowheader").getByRole("link", { name: "No reference" }).click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?recipeId=${recipes.decaf}&rating=rated$`));
  await expect(page.getByRole("list", { name: "Filters set" }).getByRole("listitem")).toHaveText(["Recipe:Decaf, Lab", "Rating:Rated"]);
  await expect(page.getByText("No Shots match these filters.")).toBeVisible();
  await page.goto(`/library/recipes/${recipes.decaf}`);
  await page.getByRole("region", { name: "Reference Shot" }).getByRole("link", { name: "Its rated Shots" }).click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?recipeId=${recipes.decaf}&rating=rated$`));
});

test("rows are under a heading for each day, each with its Recipe, grind setting and dose, its yield and duration with their differences, marked when out of spec, its stop in words, and its badges", async ({
  page,
}) => {
  await page.goto("/shots");
  const table = page.getByRole("table", { name: "Shots" });
  await expect(table.getByRole("row").first().getByRole("columnheader")).toHaveText(["Pulled", "Machine", "Recipe", "Grind", "Dose", "Yield", "Duration", "Rating", "Barista"]);
  // A heading for each day the page's Shots were pulled on, each Shot's own Location's, today and yesterday named so:
  // the Harbor's Shot, pulled half an hour into its own today, is under today's, though the Lab's clock read yesterday.
  await expect(table.locator("tbody th")).toHaveText([TODAY, YESTERDAY, /^\w{3} \w{3} \d+$/, /^\w{3} \w{3} \d+$/]);
  await expect.poll(async () => (await shotIds(page)).indexOf("harbor-house")).toBe(18);
  await expect(shotRow(page, "right-decaf").locator("xpath=preceding-sibling::tr[th][1]")).toHaveText(YESTERDAY);
  await expect(shotRow(page, "harbor-house").locator("xpath=preceding-sibling::tr[th][1]")).toHaveText(TODAY);
  await expectTip(page.getByRole("main"), "Shots", /Each is marked where it is out of spec: a yield more than 5% from target, or a duration more than 10% from the reference\./);

  // The House on the Left, 27 s against its Reference Shot's 23.549 s: out of spec, and marked. Its time is a time of
  // day, linked to it, and named by its whole time.
  const slow = shotRow(page, "left-house-last");
  await expect(slow.getByRole("cell")).toHaveText(["2:25 AM", "Lab Left", "HouseLondonium · Ethiopia Generic 100g Sample · Lab", "8", "18 g", "35.9 g−0.1 g", "27.0 sOut of spec: +3.5 s", "", "Fixture Barista"]);
  await expect(mark(slow)).toHaveText(["Out of spec: +3.5 s"]);
  await expect(slow.getByRole("link").first()).toHaveAccessibleName(/^\w{3} \d+, \d{4}, 2:25 AM /);
  await expect(slow.getByRole("img", { name: "3 stars", exact: true })).toBeVisible();
  await expect(slow.getByRole("link", { name: "House", exact: true })).toHaveAttribute("href", `/library/recipes/${recipes.house}`);
  // On the Right, 24.5 s: 1.0 s over, within spec, in muted text with no mark.
  const within = shotRow(page, "right-house-2");
  await expect(within.getByRole("cell").nth(6)).toHaveText("24.5 s+1.0 s");
  await expect(mark(within)).toHaveCount(0);

  // The Decaf has no Reference Shot, so its duration has nothing beside it. It weighed 2.5 g over its 36 g, more than
  // 5%: marked. Its Machine ended it, which is said, as a stop at its target is not.
  const over = shotRow(page, "left-decaf");
  await expect(over.getByRole("cell").nth(5)).toHaveText("38.5 gOut of spec: +2.5 g");
  await expect(over.getByRole("cell").nth(6)).toHaveText("23.5 sended by the Machine");
  await expect(mark(over)).toHaveText(["Out of spec: +2.5 g"]);
  await expect(slow.getByRole("cell").nth(6)).not.toContainText("stopped");

  // The House's Reference Shot is badged, and at no difference from itself; rated five stars.
  const reference = shotRow(page, "left-house-1");
  await expect(reference.getByRole("cell").first()).toHaveText("1:00 AMReference");
  await expect(reference.getByRole("cell").nth(6)).toHaveText("23.5 s0.0 s");
  await expect(reference.getByRole("img", { name: "5 stars", exact: true })).toBeVisible();
  // A star and a half are drawn as that, one star filled and the next by half, as the rating filter counts them: under two.
  const halves = shotRow(page, "right-house").getByRole("img", { name: "1.5 stars", exact: true }).locator("> span > span");
  await expect(halves).toHaveCount(2);
  await expect(halves.nth(0)).toHaveAttribute("style", "width: 100%;");
  await expect(halves.nth(1)).toHaveAttribute("style", "width: 50%;");
  // An Unfinished Shot is badged and muted, and carries no mark; a cleaning Shot is badged, and none of its is judged.
  const unfinished = shotRow(page, "left-house-unfinished");
  await expect(unfinished.getByRole("cell").first()).toHaveText("1:20 AMUnfinished");
  await expect(unfinished).toHaveClass(/text-muted-foreground/);
  await expect(mark(unfinished)).toHaveCount(0);
  const cleaning = shotRow(page, "left-cleaning");
  await expect(cleaning.getByRole("cell").first()).toHaveText("2:10 AMCleaning or calibration");
  await expect(cleaning.getByRole("cell").nth(2)).toContainText("No Recipe");
  await expect(mark(cleaning)).toHaveCount(0);

  // Filtered to one Location, a row no longer says it.
  await chooseFilter(page, "Location", "Lab");
  await expect(page.getByText("Shots 1–21 of 21")).toBeVisible();
  await expect(slow.getByRole("cell").nth(2)).toHaveText("HouseLondonium · Ethiopia Generic 100g Sample");
});

test("the Summary gives stopped at target among its numbers, marks what is out of spec, and reads its duration against one Recipe's Reference Shot", async ({ page }) => {
  // Every Shot of today at the Lab: 16 covered, 13 of them stopped at their target, under 90%, which is marked.
  await page.goto(`/shots?period=today&locationId=${lab.id}`);
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(summary.locator("dt")).toHaveText(["Shots", "Yield against target", "Duration", "Stopped at target"]);
  await expect(field(summary, "Shots")).toHaveText("161 Unfinished Shot left out1 cleaning or calibration Shot left out");
  await expect(field(summary, "Stopped at target")).toHaveText("Out of spec: 75%4 ended by the Machine");
  await expect(mark(summary)).toHaveText(["Out of spec: 75%"]);
  await expectTip(summary, "Summary", /Stopped at target is the share, of the Shots that recorded what stopped them, that Decaid stopped at their target weight or, with no scale, their target volume\./);

  // The House on the Left: its median of 27 s is 3.5 s over the Reference Shot's, out of spec, on a line under it.
  await page.goto(`/shots?period=today&recipeId=${recipes.house}&machineId=${machines.left.id}`);
  await expect(field(summary, "Shots")).toHaveText("51 Unfinished Shot left out");
  await expect(field(summary, "Duration")).toHaveText("27.0 s (25.8–27.0)Out of spec: +3.5 s vs reference");
  await expect(field(summary, "Stopped at target")).toHaveText("100%");
  await expect(mark(summary)).toHaveText(["Out of spec: +3.5 s vs reference"]);
  // On the Right it is 1.0 s over, within spec: the same line, muted.
  await page.goto(`/shots?period=today&recipeId=${recipes.house}&machineId=${machines.right.id}`);
  await expect(field(summary, "Duration")).toHaveText("24.5 s (24.0–24.5)+1.0 s vs reference");
  await expect(mark(summary)).toHaveCount(0);

  // The Decaf on the Left: its yields' median is 2.5 g over 36 g, more than 5%, and none stopped at target: both marked.
  await page.goto(`/shots?period=today&recipeId=${recipes.decaf}&machineId=${machines.left.id}`);
  await expect(field(summary, "Yield against target")).toHaveText("Out of spec: +2.5 g (+2.5 to +2.5)");
  await expect(field(summary, "Stopped at target")).toHaveText("Out of spec: 0%3 ended by the Machine");
  // It has no Reference Shot, so its duration is read against none.
  await expect(field(summary, "Duration")).toHaveText("23.5 s (23.5–23.5)");
});

test("the Trend starts closed and reads nothing until opened, is open from a shared address, and draws a line for each Machine of one Recipe, with its Reference Shot's duration as a dashed line", async ({
  page,
}) => {
  const read: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("bucket=")) read.push(new URL(request.url()).search);
  });
  await page.goto(`/shots?period=7days&recipeId=${recipes.house}`);
  const trend = page.getByRole("region", { name: "Trend" });
  await expect(field(page.getByRole("region", { name: "Summary" }), "Shots")).toHaveText("81 Unfinished Shot left out");
  await expect(trend.getByRole("button", { name: "Show Trend" })).toBeVisible();
  await expect(trend.getByRole("figure")).toHaveCount(0);
  expect(read).toEqual([]);

  // Opened, it is read, grouped by the Recipe and its Machines, and the address says it is open. Of one Recipe, it is
  // read grouped by Bean Batch too, for the marks where its batch changed (#733).
  await openCard(page, "Trend");
  await expect(page).toHaveURL(new RegExp(`/shots\\?period=7days&recipeId=${recipes.house}&trend=duration$`));
  expect(read).toHaveLength(2);
  expect(read[0]).toContain("groupBy=recipe%2Cmachine");
  expect(read[1]).toContain("groupBy=beanBatch");
  const chart = trend.getByRole("figure", { name: "Duration by day" });
  // A line and a band for each Machine, named beside its colour, its name leading to the list at that Machine.
  await expect(chart.locator(".recharts-line")).toHaveCount(2);
  await expect(chart.locator(".recharts-area")).toHaveCount(2);
  const lines = trend.getByRole("list", { name: "Lines" });
  await expect(lines.getByRole("listitem")).toHaveText(["Lab Left", "Lab Right", "Reference Shot23.5 s"]);
  await expect(lines.getByRole("link", { name: "Lab Left" })).toHaveAttribute("href", `/shots?period=7days&recipeId=${recipes.house}&trend=duration&machineId=${machines.left.id}`);
  // The Reference Shot's duration is a dashed line across the chart, labelled, and leads to that Shot.
  await expect(chart.locator(".recharts-reference-line-line")).toHaveCount(1);
  await expect(chart.locator(".recharts-reference-line-line")).toHaveAttribute("stroke-dasharray", "5 4");
  await expect(chart.getByText("Reference 23.5 s", { exact: true })).toBeVisible();
  await expect(lines.getByRole("link", { name: "Reference Shot" })).toHaveAttribute("href", "/shots/left-house-1");
  // Its numbers name each Machine: today's medians, 27 s on the Left and 24.5 s on the Right.
  await trend.getByRole("button", { name: "Show the numbers" }).click();
  await expect(trend.getByRole("table", { name: "Duration by day" }).getByRole("columnheader")).toHaveText(["Day", "Machine", "Shots", "Median", "Middle half"]);
  await expect(rows(trend.getByRole("table", { name: "Duration by day" }))).toHaveText([/Lab Left527\.0 s25\.8–27\.0$/, /Lab Right324\.5 s24\.0–24\.5$/]);

  // Another number has no reference line.
  await trend.getByRole("combobox", { name: "Number" }).click();
  await page.getByRole("option", { name: "Yield against target", exact: true }).click();
  await expect(trend.getByRole("figure", { name: "Yield against target by day" }).locator(".recharts-line")).toHaveCount(2);
  await expect(trend.locator(".recharts-reference-line-line")).toHaveCount(0);
  await expect(lines.getByRole("listitem")).toHaveText(["Lab Left", "Lab Right"]);

  // A Machine's name opens the list at it: one line, not named, still against the reference when charting duration.
  await trend.getByRole("combobox", { name: "Number" }).click();
  await page.getByRole("option", { name: "Duration", exact: true }).click();
  await lines.getByRole("link", { name: "Lab Left" }).click();
  await expect(filterChip(page, "Machine")).toHaveText("Machine:Lab Left");
  await expect(chart.locator(".recharts-line")).toHaveCount(1);
  await expect(chart.locator(".recharts-reference-line-line")).toHaveCount(1);
  await expect(lines.getByRole("listitem")).toHaveText(["Reference Shot23.5 s"]);

  // A shared address opens it the same, and one with no Recipe draws one line of every Shot, with no reference.
  await page.goto("/shots?period=7days&trend=duration");
  await expect(chart.locator(".recharts-line")).toHaveCount(1);
  await expect(chart.locator(".recharts-reference-line-line")).toHaveCount(0);
  await expect(trend.getByRole("list", { name: "Lines" })).toHaveCount(0);
  // The Decaf has no Reference Shot: a line for each Machine, and no dashed one.
  await page.goto(`/shots?period=7days&recipeId=${recipes.decaf}&trend=duration`);
  await expect(chart.locator(".recharts-line")).toHaveCount(2);
  await expect(chart.locator(".recharts-reference-line-line")).toHaveCount(0);

  // Hidden, it is closed in the address too.
  await trend.getByRole("button", { name: "Hide Trend" }).click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?period=7days&recipeId=${recipes.decaf}$`));
  await expect(trend.getByRole("figure")).toHaveCount(0);
});

test("on a phone, each Shot is a two-line row and nothing scrolls sideways, the filters open in a sheet, and a chip removes its filter", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: server.url(), ...PHONE });
  try {
    const phone = await context.newPage();
    await signInAsAdmin(phone);
    await phone.goto("/shots?period=today");
    // No table: the Shots are a list under each day's heading.
    await expect(phone.getByRole("table", { name: "Shots" })).toHaveCount(0);
    const list = phone.getByRole("group", { name: "Shots" });
    await expect(list.getByRole("heading")).toHaveText([TODAY]);
    await expect(list.getByRole("listitem")).toHaveCount(19);
    await expectFits(phone);

    // A row's first line: its time and Machine, with its duration and the duration's difference, marked here; its
    // second: its grind setting, its yield with its difference, its Recipe, and its rating.
    const slow = narrowRow(phone, "left-house-last");
    const [first, second] = [slow.locator("a > span").nth(0), slow.locator("a > span").nth(1)];
    await expect(first).toHaveText("2:25 AM· Lab Left27.0 sOut of spec: +3.5 s");
    await expect(second).toHaveText("grind 8 · 35.9 g −0.1 g · House");
    await expect(second.getByRole("img", { name: "3 stars", exact: true })).toBeVisible();
    await expect(mark(slow)).toHaveText(["Out of spec: +3.5 s"]);
    // Neither line wraps, whatever a row holds: every row is two lines high, the cleaning Shot's, with its long badge,
    // and the Decaf's, with its mark and its stop, among them.
    const heights = await list.getByRole("listitem").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    expect(heights).toHaveLength(19);
    expect(Math.max(...heights)).toBeLessThan(75);
    // And each row's duration, at the end of its first line, is within the row: what a line has no room for is cut
    // short before it, as the Machine's name beside a long badge, and the end of a long second line.
    const cut = await list.getByRole("listitem").evaluateAll((items) =>
      items.filter((item) => {
        const row = item.getBoundingClientRect();
        return [...item.querySelectorAll("a > span > span:last-child")].some((end) => end.getBoundingClientRect().right > row.right);
      }).length,
    );
    expect(cut).toBe(0);
    await expect(narrowRow(phone, "right-none-last").locator("a > span").nth(0)).toHaveText("2:30 AM· Lab Right25.0 s");
    await expect(narrowRow(phone, "right-none-last").getByText("25.0 s", { exact: true })).toBeInViewport({ ratio: 1 });
    // The whole row leads to the Shot.
    await expect(slow.getByRole("link")).toHaveAttribute("href", "/shots/left-house-last");
    // A yield out of spec is marked on the second line, with how the Shot stopped; the badges are on the first.
    await expect(narrowRow(phone, "left-decaf").locator("a > span").nth(1)).toHaveText("grind 8 · 38.5 g Out of spec: +2.5 g · ended by the Machine · Decaf");
    await expect(narrowRow(phone, "left-house-1").locator("a > span").nth(0)).toHaveText("1:00 AM· Lab LeftReference23.5 s0.0 s");
    await expect(narrowRow(phone, "left-house-unfinished").locator("a > span").nth(0)).toContainText("Unfinished");
    await expect(narrowRow(phone, "left-cleaning").locator("a > span").nth(0)).toContainText("Cleaning or calibration");

    // The presets are in view, Custom as an icon, and the filters open in a sheet from the bottom.
    await expect(phone.getByRole("radiogroup", { name: "Dates" }).getByRole("radio")).toHaveCount(5);
    await expect(datesPreset(phone, "Custom")).toBeVisible();
    await expect(datesPreset(phone, "Today")).toBeChecked();
    const sheet = await openFilters(phone);
    await expect(sheet.getByRole("heading", { name: "Filters" })).toBeVisible();
    await sheet.getByRole("combobox", { name: "Recipe", exact: true }).click();
    await phone.getByRole("option", { name: "House, Lab", exact: true }).click();
    // Its button says how many Shots the filters find, and closes it.
    await sheet.getByRole("button", { name: "Show 9 Shots", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(phone).toHaveURL(new RegExp(`/shots\\?period=today&recipeId=${recipes.house}$`));
    // Filtered to one Recipe, a row no longer names it.
    await expect(slow.locator("a > span").nth(1)).toHaveText("grind 8 · 35.9 g −0.1 g");
    // The chip names the filter and removes it.
    await expect(filterChip(phone, "Recipe")).toHaveText("Recipe:House, Lab");
    await expectFits(phone);
    await filterChip(phone, "Recipe").getByRole("button", { name: "Remove the Recipe filter" }).click();
    await expect(phone).toHaveURL(/\/shots\?period=today$/);
    await expect(list.getByRole("listitem")).toHaveCount(19);

    // The rating filter, from the sheet, and the trend, closed until opened, with its lines.
    await chooseFilter(phone, "Rating", "Rated");
    await expect(list.getByRole("listitem")).toHaveCount(3);
    await phone.goto(`/shots?period=today&recipeId=${recipes.house}`);
    const trend = phone.getByRole("region", { name: "Trend" });
    await expect(trend.getByRole("figure")).toHaveCount(0);
    await openCard(phone, "Trend");
    await expect(trend.getByRole("figure", { name: "Duration by day" }).locator(".recharts-reference-line-line")).toHaveCount(1);
    await expect(trend.getByRole("list", { name: "Lines" }).getByRole("listitem")).toHaveText(["Lab Left", "Lab Right", "Reference Shot23.5 s"]);
    await expectFits(phone);
  } finally {
    await context.close();
  }
});

/** The Shots list's table's rows of Shots, without its header or its days' headings. */
function shotRows(page: Page): Locator {
  return rows(page.getByRole("table", { name: "Shots" }));
}

/** The table's row of the Shot with that id. */
function shotRow(page: Page, id: string): Locator {
  return shotRows(page).filter({ has: page.locator(`a[href$="/shots/${id}"]`) });
}

/** The ids of the Shots the table lists, in its order. */
function shotIds(page: Page): Promise<string[]> {
  return shotRows(page)
    .locator("td:first-child a")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")!.split("/").at(-1)!));
}

/** A phone's row of the Shot with that id. */
function narrowRow(page: Page, id: string): Locator {
  return page.getByRole("group", { name: "Shots" }).getByRole("listitem").filter({ has: page.locator(`a[href$="/shots/${id}"]`) });
}

/** What is marked within `scope`: each out-of-spec mark (web/src/components/spec-mark.tsx). */
function mark(scope: Locator): Locator {
  return scope.locator('[data-slot="spec-mark"]');
}

/** The page is no wider than the phone's screen. */
async function expectFits(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect({ scrollWidth, clientWidth }, `${new URL(page.url()).pathname} fits the screen`).toEqual({ scrollWidth: 390, clientWidth: 390 });
}
