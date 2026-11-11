import { expect, type Locator, type Page, test } from "@playwright/test";
import { preheatShotFixture, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// The Shots list's summary of the Shots its filters find (#466), as an
// Admin. A simulated tablet running the built plugin backfills five Shots
// derived from two real records, changing only their id, time, recorded
// hardware, Barista and what each line names. The real Shots weighed 0.1 g
// and 1.3 g under their targets, ran 23.549 s and 25.833 s after their
// Preheat, and stopped on weight. Baristas and hardware ids are made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

const HARDWARE = { model: "DE1Pro", serial: "10041" };

type Fields = Record<string, unknown>;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("the summary of the Shots the filters find sits above the rows, each number as its median with the middle half's range", async ({ page }) => {
  const lab = await createLocation(page, "Lab", "America/Denver");
  await adopt(page, "Lab 1", lab.id, [
    shotOf("lab-espresso", "2026-02-10T13:30:00Z", "Ann"),
    shotOf("lab-preheat", "2026-02-10T14:00:00Z", "Ann", {}, preheatShotFixture()),
    // 2.5 g over its target, and ended by the Machine as its profile finished.
    shotOf("lab-over", "2026-02-10T14:30:00Z", "Ben", { actualYield: 38.5, stopReason: "machineEnded" }),
    // No target, and no stop reason recorded.
    shotOf("lab-no-target", "2026-02-10T15:00:00Z", "Cat", { targetYield: 0, stopReason: null }),
    shotOf("lab-cleaning", "2026-02-10T15:30:00Z", "Dee", { type: "cleaning" }),
  ]);

  await page.goto("/shots");
  await expect(rows(page)).toHaveCount(5);
  const summary = page.getByRole("region", { name: "Summary" });
  await expectTip(summary, "Summary", /^How the Shots these filters find went, leaving out cleaning and calibration Shots\./);
  // Four of the five listed, the cleaning Shot left out and said so. Three of 23.549 s and one of 25.833 s.
  await expect(field(summary, "Shots")).toHaveText("41 cleaning or calibration Shot left out");
  await expect(field(summary, "Duration")).toHaveText("23.5 s (23.5–24.1)");
  // −1.3, −0.1 and 2.5: a number says how many Shots it rests on where some had no value.
  await expect(field(summary, "Yield against target")).toHaveText("−0.1 g (−0.7 to +1.2)3 of 4 Shots had a target and a yield");
  // Two of the three that recorded what stopped them.
  await expect(field(summary, "Stopped on weight")).toHaveText("67%3 of 4 Shots recorded what stopped them");
});

test("the summary follows the filters, says when only cleaning Shots match, and is gone when none do", async ({ page }) => {
  await page.goto("/shots");
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(field(summary, "Shots")).toHaveText("41 cleaning or calibration Shot left out");

  // The two real Shots: −1.3 and −0.1, and 23.549 s and 25.833 s.
  await choose(page, "Barista", "Ann");
  await expect(rows(page)).toHaveCount(2);
  await expect(field(summary, "Shots")).toHaveText("2");
  await expect(field(summary, "Duration")).toHaveText("24.7 s (24.1–25.3)");
  await expect(field(summary, "Yield against target")).toHaveText("−0.7 g (−1.0 to −0.4)");
  await expect(field(summary, "Stopped on weight")).toHaveText("100%");

  await choose(page, "Barista", "Ben");
  await expect(field(summary, "Shots")).toHaveText("1");
  await expect(field(summary, "Duration")).toHaveText("23.5 s (23.5–23.5)");
  await expect(field(summary, "Yield against target")).toHaveText("+2.5 g (+2.5 to +2.5)");
  await expect(field(summary, "Stopped on weight")).toHaveText("0%");

  // The filters are in the page's address, so the summary of a reloaded or shared list is the same.
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(field(summary, "Yield against target")).toHaveText("+2.5 g (+2.5 to +2.5)");

  // Only a cleaning Shot: it is counted, and there is no number.
  await choose(page, "Barista", "Dee");
  await expect(rows(page)).toHaveCount(1);
  await expect(field(summary, "Shots")).toHaveText("01 cleaning or calibration Shot left out");
  for (const number of ["Duration", "Yield against target", "Stopped on weight"]) await expect(field(summary, number)).toHaveText("-");

  await choose(page, "Profile", "Adaptive v3");
  await expect(page.getByText("No Shots match these filters.")).toBeVisible();
  await expect(summary).toHaveCount(0);
});

test("a summary that fails to load for the filters chosen gives no numbers, rather than those of the filters before", async ({ page }) => {
  await page.goto("/shots");
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(field(summary, "Shots")).toHaveText("41 cleaning or calibration Shot left out");

  // As the previous release's instance answers during a deploy: it has no such route, and reads the path as a Shot's.
  await page.route(
    /\/api\/shots\/summary\?.*barista=Ann/,
    (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ statusCode: 404, message: "Shot not found" }) }),
    { times: 1 },
  );
  await choose(page, "Barista", "Ann");
  await expect(rows(page)).toHaveCount(2);
  await expect(summary.getByRole("alert")).toHaveText("Could not read the summary: Shot not found");
  for (const number of ["Shots", "Duration", "Yield against target", "Stopped on weight"]) await expect(field(summary, number)).toHaveText("-");

  // The next filters' summary loads as usual.
  await choose(page, "Barista", "Ben");
  await expect(field(summary, "Shots")).toHaveText("1");
  await expect(summary.getByRole("alert")).toHaveCount(0);
});

/** What a test changes of a fixture's record. */
interface Changes {
  actualYield?: number;
  targetYield?: number;
  /** What stopped it; null for a Shot that recorded none. */
  stopReason?: string | null;
  /** Its profile's type. */
  type?: string;
}

/** A Shot pulled at a UTC time on the Lab's hardware by the Barista given, derived from `fixture` with the changes given. */
function shotOf(id: string, pulledAt: string, barista: string, changes: Changes = {}, fixture = shotFixture()): Fields {
  const { stopReason: recordedStop, ...record } = fixture;
  const workflow = fixture.workflow as Record<string, Fields>;
  const stopReason = changes.stopReason === undefined ? recordedStop : changes.stopReason;
  return {
    ...record,
    id,
    timestamp: pulledAt,
    ...(stopReason !== null && { stopReason }),
    workflow: {
      ...workflow,
      context: { ...workflow.context, baristaName: barista, ...(changes.targetYield !== undefined && { targetYield: changes.targetYield }) },
      profile: { ...workflow.profile, ...(changes.type !== undefined && { beverage_type: changes.type }) },
      machine: { ...workflow.machine, model: HARDWARE.model, serialNumber: HARDWARE.serial },
    },
    annotations: { ...(fixture.annotations as Fields), ...(changes.actualYield !== undefined && { actualYield: changes.actualYield }) },
  };
}

/** Creates a machine entry at the Location since long before its Shots, and loads a simulated tablet on its hardware with the Shots, which it backfills. */
async function adopt(page: Page, name: string, locationId: string, shots: Fields[]) {
  const response = await page.request.post("/api/machines", { data: { name } });
  expect(response.status()).toBe(201);
  const { machine, token } = (await response.json()) as { machine: { id: string }; token: string };
  const moved = await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId, effectiveFrom: "2025-01-01T00:00:00Z" } });
  expect(moved.status()).toBe(201);
  SimulatedTablet.load({ settings: settingsFor({ serverUrl: server.url(), token }), api: withShots(derivedDe1Pro(HARDWARE), shots), timeScale: 50 });
  await expect.poll(async () => ((await (await page.request.get("/api/shots?limit=1")).json()) as { total: number }).total).toBe(shots.length);
}

function rows(page: Page): Locator {
  return page.getByRole("table", { name: "Shots" }).getByRole("row").filter({ has: page.getByRole("cell") });
}

async function choose(page: Page, filter: string, option: string) {
  await page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: filter, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
