import { expect, type Locator, type Page, test } from "@playwright/test";
import { preheatShotFixture, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// The Shots list's trend of one number of the Shots its filters find, by
// day or week (#470), as an Admin. A simulated tablet running the built
// plugin backfills six Shots derived from two real records, changing only
// their id, time, recorded hardware, Barista and what each line names. The
// real Shots ran 23.549 s and 25.833 s after their Preheat and stopped on
// weight. The Lab is in Denver, seven hours behind UTC that February, and 9
// and 16 February 2026 are Mondays. Baristas and hardware ids are made up.
//
// | Shot | Pulled, UTC | At the Lab | Duration | Stopped by | Barista | Rated |
// |---|---|---|---|---|---|---|
// | tuesday-1 | 10 Feb 16:00 | Tue 10 Feb 09:00 | 23.549 s | targetWeight | Ann | |
// | tuesday-2 | 10 Feb 17:00 | Tue 10 Feb 10:00 | 25.833 s | targetWeight | Ben | |
// | wednesday | 11 Feb 16:00 | Wed 11 Feb 09:00 | 23.549 s | machineEnded | Ann | 8 |
// | sunday | 16 Feb 06:30 | Sun 15 Feb 23:30 | 25.833 s | targetWeight | Ann | |
// | monday | 16 Feb 07:30 | Mon 16 Feb 00:30 | 23.549 s | targetWeight | Ben | |
// | cleaning | 16 Feb 16:00 | Mon 16 Feb 09:00 | a cleaning Shot | | Ann | |
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

const HARDWARE = { model: "DE1Pro", serial: "10071" };

type Fields = Record<string, unknown>;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("the trend charts the Shots the filters find by day, each day's median with the middle half's band, in each Shot's Location's days", async ({ page }) => {
  const lab = await createLocation(page, "Lab", "America/Denver");
  await adopt(page, "Lab 1", lab.id, [
    shotOf("tuesday-1", "2026-02-10T16:00:00Z", "Ann"),
    shotOf("tuesday-2", "2026-02-10T17:00:00Z", "Ben", {}, preheatShotFixture()),
    shotOf("wednesday", "2026-02-11T16:00:00Z", "Ann", { stopReason: "machineEnded", enjoyment: 8 }),
    // An hour apart, either side of the Lab's midnight between a Sunday and a Monday, both on UTC's Monday.
    shotOf("sunday", "2026-02-16T06:30:00Z", "Ann", {}, preheatShotFixture()),
    shotOf("monday", "2026-02-16T07:30:00Z", "Ben"),
    shotOf("cleaning", "2026-02-16T16:00:00Z", "Ann", { type: "cleaning" }),
  ]);

  await page.goto("/shots");
  const trend = page.getByRole("region", { name: "Trend" });
  await expectTip(trend, "Trend", /^How one number of the Shots these filters find moved, by day or by week\./);
  // Duration by day, until another is chosen.
  await expect(trend.getByRole("tab", { name: "By day" })).toHaveAttribute("aria-selected", "true");
  await expect(trend.getByRole("combobox", { name: "Number" })).toHaveText("Duration");
  const chart = trend.getByRole("figure", { name: "Duration by day" });
  await expect(chart.locator("figcaption")).toHaveText("Duration (s)");
  // One line through the four days with Shots, each marked, and the band of their middle halves.
  await expect(chart.locator(".recharts-line-curve")).toHaveCount(1);
  await expect(chart.locator(".recharts-line-dot")).toHaveCount(4);
  await expect(chart.locator(".recharts-area-area")).toHaveCount(1);
  // The days are the Lab's: its Sunday's Shot, pulled on UTC's Monday, is the 15th's. The cleaning Shot is in none.
  await expect(await numbers(trend, "Duration by day")).toHaveText([
    "Tue, Feb 10, 2026224.7 s24.1–25.3",
    "Wed, Feb 11, 2026123.5 s23.5–23.5",
    "Sun, Feb 15, 2026125.8 s25.8–25.8",
    "Mon, Feb 16, 2026123.5 s23.5–23.5",
  ]);
  await expect(trend.getByRole("columnheader")).toHaveText(["Day", "Shots", "Median", "Middle half"]);

  // Pointed at, a day gives the same.
  await chart.locator(".recharts-line-dot").first().hover();
  await expect(chart.locator(".recharts-tooltip-wrapper")).toHaveText("Tue, Feb 10, 2026Duration24.7 sMiddle half24.1–25.3Shots2");
});

test("another number and the week are chosen, kept in the page's address, and a share draws as a line with no band", async ({ page }) => {
  await page.goto("/shots");
  const trend = page.getByRole("region", { name: "Trend" });
  await expect(trend.getByRole("figure", { name: "Duration by day" })).toBeVisible();

  // A share: of the Shots that recorded what stopped them, those stopped on weight, with no band.
  await chooseNumber(trend, "Stopped on weight");
  await expect(page).toHaveURL(/\/shots\?trend=stoppedOnWeight$/);
  const share = trend.getByRole("figure", { name: "Stopped on weight by day" });
  await expect(share.locator("figcaption")).toHaveText("Stopped on weight (%)");
  await expect(share.locator(".recharts-line-dot")).toHaveCount(4);
  await expect(share.locator(".recharts-area-area")).toHaveCount(0);
  await expect(await numbers(trend, "Stopped on weight by day")).toHaveText(["Tue, Feb 10, 20262100%", "Wed, Feb 11, 202610%", "Sun, Feb 15, 20261100%", "Mon, Feb 16, 20261100%"]);
  await expect(trend.getByRole("columnheader")).toHaveText(["Day", "Shots", "Stopped on weight"]);

  // By week, from the Lab's Mondays: its Sunday's Shot is the week of the 9th's, and its Monday's the 16th's.
  await trend.getByRole("tab", { name: "By week" }).click();
  await expect(page).toHaveURL(/\/shots\?trend=stoppedOnWeight&bucket=week$/);
  await expect(trend.getByRole("figure", { name: "Stopped on weight by week" }).locator(".recharts-line-dot")).toHaveCount(2);
  await expect(await numbers(trend, "Stopped on weight by week")).toHaveText(["Mon, Feb 9, 2026475%", "Mon, Feb 16, 20261100%"]);
  await expect(trend.getByRole("columnheader")).toHaveText(["Week of", "Shots", "Stopped on weight"]);

  // The view is the address's, so a reloaded or shared one is the same.
  await page.reload();
  await expect(trend.getByRole("tab", { name: "By week" })).toHaveAttribute("aria-selected", "true");
  await expect(trend.getByRole("combobox", { name: "Number" })).toHaveText("Stopped on weight");
  await expect(await numbers(trend, "Stopped on weight by week")).toHaveText(["Mon, Feb 9, 2026475%", "Mon, Feb 16, 20261100%"]);

  // The week's durations: two of 23.549 s and two of 25.833 s. The address holds neither default.
  await chooseNumber(trend, "Duration");
  await expect(page).toHaveURL(/\/shots\?bucket=week$/);
  await expect(await numbers(trend, "Duration by week")).toHaveText(["Mon, Feb 9, 2026424.7 s23.5–25.8", "Mon, Feb 16, 2026123.5 s23.5–23.5"]);
  await trend.getByRole("tab", { name: "By day" }).click();
  await expect(page).toHaveURL(/\/shots$/);
  await expect(trend.getByRole("figure", { name: "Duration by day" }).locator(".recharts-line-dot")).toHaveCount(4);
});

test("the trend follows the filters and the summary's numbers stay, a number few Shots have says how many it rests on, and one none has says so", async ({ page }) => {
  await page.goto("/shots?numbers=ratio");
  const trend = page.getByRole("region", { name: "Trend" });
  // Ann's Shots: one on each of three days, her cleaning Shot left out.
  await page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: "Barista", exact: true }).click();
  await page.getByRole("option", { name: "Ann", exact: true }).click();
  await expect(shotRows(page)).toHaveCount(4);
  await expect(await numbers(trend, "Duration by day")).toHaveText(["Tue, Feb 10, 2026123.5 s23.5–23.5", "Wed, Feb 11, 2026123.5 s23.5–23.5", "Sun, Feb 15, 2026125.8 s25.8–25.8"]);

  // One of her Shots is rated: the one day with a value, of the one Shot.
  await chooseNumber(trend, "Rating");
  await expect(page).toHaveURL(/\/shots\?numbers=ratio&barista=Ann&trend=rating$/);
  const rating = trend.getByRole("figure", { name: "Rating by day" });
  await expect(rating.locator("figcaption")).toHaveText("Rating");
  await expect(rating.locator(".recharts-line-dot")).toHaveCount(1);
  await expect(await numbers(trend, "Rating by day")).toHaveText(["Wed, Feb 11, 202618.08.0–8.0"]);
  // By week, it rests on one of that week's three.
  await trend.getByRole("tab", { name: "By week" }).click();
  await expect(await numbers(trend, "Rating by week")).toHaveText(["Mon, Feb 9, 20261 of 38.08.0–8.0"]);

  // None recorded a TDS.
  await chooseNumber(trend, "TDS");
  const tds = trend.getByRole("figure", { name: "TDS by week" });
  await expect(tds).toHaveText("TDS (%)Nothing to chart: none of these Shots has a value for it.");
  await expect(trend.getByRole("button", { name: "Show the numbers" })).toHaveCount(0);
  // The summary's own numbers are as chosen.
  await expect(page.getByRole("region", { name: "Summary" }).locator("dt")).toHaveText(["Shots", "Ratio"]);
});

test("a trend that can't be read says so, and the previous release's answer, which has no buckets, draws nothing", async ({ page }) => {
  await page.goto("/shots");
  const trend = page.getByRole("region", { name: "Trend" });
  await expect(trend.getByRole("figure", { name: "Duration by day" })).toBeVisible();

  // As the previous release's instance answers during a deploy: it knows no bucket, and summarises the Shots as one group.
  const unbucketed = { groups: [{ by: {}, counts: { shots: 5, unfinished: 0, cleaningAndCalibration: 1, awaitingValues: 0 }, numbers: {} }], total: 1, limit: 20, offset: 0 };
  await page.route(/\/api\/shots\/summary\?.*bucket=week/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(unbucketed) }), { times: 1 });
  await trend.getByRole("tab", { name: "By week" }).click();
  await expect(trend.getByRole("tab", { name: "By week" })).toHaveAttribute("aria-selected", "true");
  await expect(trend.getByRole("figure")).toHaveCount(0);
  await expect(trend.getByRole("alert")).toHaveCount(0);

  await page.route(/\/api\/shots\/summary\?.*numbers=ratio/, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ statusCode: 500, message: "Internal server error" }) }), {
    times: 1,
  });
  await chooseNumber(trend, "Ratio");
  await expect(trend.getByRole("alert")).toHaveText("Could not read the trend: Internal server error");
  await expect(trend.getByRole("figure")).toHaveCount(0);

  // The next one chosen loads as usual.
  await chooseNumber(trend, "Duration");
  await expect(trend.getByRole("figure", { name: "Duration by week" }).locator(".recharts-line-dot")).toHaveCount(2);
  await expect(trend.getByRole("alert")).toHaveCount(0);
});

/** The rows of the trend's numbers, as its table gives them, opened if it is closed. */
async function numbers(trend: Locator, name: string): Promise<Locator> {
  const table = trend.getByRole("table", { name });
  const show = trend.getByRole("button", { name: "Show the numbers" });
  await expect(show.or(table)).toBeVisible();
  if (await show.isVisible()) await show.click();
  return rows(table);
}

async function chooseNumber(trend: Locator, option: string) {
  await trend.getByRole("combobox", { name: "Number" }).click();
  await trend.page().getByRole("option", { name: option, exact: true }).click();
}

function shotRows(page: Page): Locator {
  return rows(page.getByRole("table", { name: "Shots" }));
}

/** A Shot pulled at a UTC time on the Lab's Machine's hardware, by the Barista given, derived from `fixture` with the changes given. */
function shotOf(id: string, pulledAt: string, barista: string, changes: { stopReason?: string; type?: string; enjoyment?: number } = {}, fixture = shotFixture()): Fields {
  const workflow = fixture.workflow as Record<string, Fields>;
  return {
    ...fixture,
    id,
    timestamp: pulledAt,
    ...(changes.stopReason !== undefined && { stopReason: changes.stopReason }),
    workflow: {
      ...workflow,
      context: { ...workflow.context, baristaName: barista },
      profile: { ...workflow.profile, ...(changes.type !== undefined && { beverage_type: changes.type }) },
      machine: { ...workflow.machine, model: HARDWARE.model, serialNumber: HARDWARE.serial },
    },
    annotations: { ...(fixture.annotations as Fields), ...(changes.enjoyment !== undefined && { enjoyment: changes.enjoyment }) },
  };
}

/** Creates a machine entry at the Location since long before its Shots, and loads a simulated tablet on its hardware with the Shots, which it backfills. */
async function adopt(page: Page, name: string, locationId: string, shots: Fields[]) {
  const total = async () => ((await (await page.request.get("/api/shots?limit=1")).json()) as { total: number }).total;
  const response = await page.request.post("/api/machines", { data: { name } });
  expect(response.status()).toBe(201);
  const { machine, token } = (await response.json()) as { machine: { id: string }; token: string };
  const moved = await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId, effectiveFrom: "2025-01-01T00:00:00Z" } });
  expect(moved.status()).toBe(201);
  SimulatedTablet.load({ settings: settingsFor({ serverUrl: server.url(), token }), api: withShots(derivedDe1Pro(HARDWARE), shots), timeScale: 50 });
  await expect.poll(total).toBe(shots.length);
}
