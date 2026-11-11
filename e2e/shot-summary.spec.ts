import { expect, type Locator, type Page, test } from "@playwright/test";
import { preheatShotFixture, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// The Shots list's summary of the Shots its filters find (#466), as an
// Admin, its Barista filter, which finds a Barista however the name was
// spelled (#468), and the other numbers it shows when chosen, with its
// Unfinished Shots (#469). A simulated tablet running the built plugin
// backfills five Shots derived from two real records, changing only their
// id, time, recorded hardware, Barista and what each line names, and the
// last two tests two more each, on Machines of their own. The real Shots
// weighed 0.1 g and 1.3 g under their targets, ran 23.549 s and 25.833 s
// after their Preheat, and stopped on weight. Baristas and hardware ids are
// made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

const HARDWARE = { model: "DE1Pro", serial: "10041" };
const HARDWARE_2 = { model: "DE1Pro", serial: "10042" };
const HARDWARE_3 = { model: "DE1Pro", serial: "10043" };

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
  await expectTip(summary, "Summary", /^How the Shots these filters find went, leaving out cleaning and calibration Shots, and Unfinished Shots, in which nothing poured/);
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

test("the Barista filter offers each Barista once, by the latest spelling, and finds every spelling of the name", async ({ page }) => {
  // A second Machine, whose two Shots, the real ones, a day later, name the first's Ann in other spellings: the last is the latest.
  const { locations } = (await (await page.request.get("/api/locations")).json()) as { locations: { id: string; name: string }[] };
  await adopt(
    page,
    "Lab 2",
    locations.find((location) => location.name === "Lab")!.id,
    [shotOf("lab2-espresso", "2026-02-11T13:30:00Z", " ann", {}, shotFixture(), HARDWARE_2), shotOf("lab2-preheat", "2026-02-11T14:00:00Z", "ANN ", {}, preheatShotFixture(), HARDWARE_2)],
    HARDWARE_2,
  );

  await page.goto("/shots");
  await expect(rows(page)).toHaveCount(7);
  const filters = page.getByRole("region", { name: "Filters" });
  const summary = page.getByRole("region", { name: "Summary" });
  await filters.getByRole("combobox", { name: "Barista", exact: true }).click();
  // Ann once, as last spelled, without the space after it.
  await expect(page.getByRole("option")).toHaveText(["Any Barista", "ANN", "Ben", "Cat", "Dee"]);
  await page.getByRole("option", { name: "ANN", exact: true }).click();
  // Both Machines' Shots, however each spelled the name, and their summary: 23.549 s and 25.833 s twice each.
  await expect(rows(page)).toHaveCount(4);
  await expect(field(summary, "Shots")).toHaveText("4");
  await expect(field(summary, "Duration")).toHaveText("24.7 s (23.5–25.8)");

  // An address holding another spelling, as one shared before this, finds the same Shots, and shows the Barista's choice.
  await page.goto("/shots?barista=%20ann");
  await expect(rows(page)).toHaveCount(4);
  await expect(filters.getByRole("combobox", { name: "Barista", exact: true })).toHaveText("ANN");
  await expect(field(summary, "Shots")).toHaveText("4");
});

test("other numbers chosen show beside the count, which says how many Unfinished Shots were left out, and stay chosen in the address", async ({ page }) => {
  // A third Machine's two Shots, by Eve: the real one, with a dose of 18 g, a rating of 8 and a grind setting of 8, and
  // one stopped at once, in its preinfusion, before anything poured.
  const { locations } = (await (await page.request.get("/api/locations")).json()) as { locations: { id: string; name: string }[] };
  const espresso = shotOf("lab3-espresso", "2026-02-12T13:30:00Z", "Eve", { enjoyment: 8 }, shotFixture(), HARDWARE_3);
  const unfinished = shotOf("lab3-unfinished", "2026-02-12T14:00:00Z", "Eve", {}, shotFixture(), HARDWARE_3);
  await adopt(page, "Lab 3", locations.find((location) => location.name === "Lab")!.id, [espresso, { ...unfinished, measurements: (unfinished.measurements as Fields[]).slice(0, 2) }], HARDWARE_3);

  await page.goto("/shots?barista=Eve");
  await expect(rows(page)).toHaveCount(2);
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(field(summary, "Shots")).toHaveText("11 Unfinished Shot left out");
  await expect(field(summary, "Duration")).toHaveText("23.5 s (23.5–23.5)");

  // The ratio, rating and last step chosen, and stopped on weight no longer, the menu staying open meanwhile.
  await summary.getByRole("button", { name: "Numbers" }).click();
  for (const name of ["Ratio", "Rating", "Last step", "Stopped on weight"]) await page.getByRole("menuitemcheckbox", { name, exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox", { checked: true })).toHaveText(["Yield against target", "Duration", "Ratio", "Rating", "Last step"]);
  await page.keyboard.press("Escape");
  await expect(summary.locator("dt")).toHaveText(["Shots", "Yield against target", "Duration", "Ratio", "Rating", "Last step"]);
  // 35.9 g from 18 g, and the step the real Shot ended in. Not the Unfinished Shot's: it is in no number.
  await expect(field(summary, "Ratio")).toHaveText("1:1.99 (1.99–1.99)");
  await expect(field(summary, "Rating")).toHaveText("8.0 (8.0–8.0)");
  await expect(field(summary, "Last step")).toHaveText("Pressure Decline (1)");
  await expect(page).toHaveURL(/numbers=yieldAgainstTarget%2Cduration%2Cratio%2Crating%2ClastStep/);

  // A reload or a shared address shows the same, and clearing the filters keeps them.
  await page.reload();
  await expect(summary.locator("dt")).toHaveText(["Shots", "Yield against target", "Duration", "Ratio", "Rating", "Last step"]);
  await expect(field(summary, "Ratio")).toHaveText("1:1.99 (1.99–1.99)");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows(page)).toHaveCount(9);
  await expect(field(summary, "Shots")).toHaveText("71 Unfinished Shot left out1 cleaning or calibration Shot left out");
  await expect(summary.locator("dt")).toHaveText(["Shots", "Yield against target", "Duration", "Ratio", "Rating", "Last step"]);
  // Of the seven Shots covered, one is rated.
  await expect(field(summary, "Rating")).toHaveText("8.0 (8.0–8.0)1 of 7 Shots rated");
});

/** What a test changes of a fixture's record. */
interface Changes {
  /** Its enjoyment as rated on its tablet. */
  enjoyment?: number;
  actualYield?: number;
  targetYield?: number;
  /** What stopped it; null for a Shot that recorded none. */
  stopReason?: string | null;
  /** Its profile's type. */
  type?: string;
}

/** A Shot pulled at a UTC time on the hardware given, the Lab's first Machine's unless said, by the Barista given, derived from `fixture` with the changes given. */
function shotOf(id: string, pulledAt: string, barista: string, changes: Changes = {}, fixture = shotFixture(), hardware = HARDWARE): Fields {
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
      machine: { ...workflow.machine, model: hardware.model, serialNumber: hardware.serial },
    },
    annotations: {
      ...(fixture.annotations as Fields),
      ...(changes.actualYield !== undefined && { actualYield: changes.actualYield }),
      ...(changes.enjoyment !== undefined && { enjoyment: changes.enjoyment }),
    },
  };
}

/** Creates a machine entry at the Location since long before its Shots, and loads a simulated tablet on its hardware with the Shots, which it backfills. */
async function adopt(page: Page, name: string, locationId: string, shots: Fields[], hardware = HARDWARE) {
  const total = async () => ((await (await page.request.get("/api/shots?limit=1")).json()) as { total: number }).total;
  const before = await total();
  const response = await page.request.post("/api/machines", { data: { name } });
  expect(response.status()).toBe(201);
  const { machine, token } = (await response.json()) as { machine: { id: string }; token: string };
  const moved = await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId, effectiveFrom: "2025-01-01T00:00:00Z" } });
  expect(moved.status()).toBe(201);
  SimulatedTablet.load({ settings: settingsFor({ serverUrl: server.url(), token }), api: withShots(derivedDe1Pro(hardware), shots), timeScale: 50 });
  await expect.poll(total).toBe(before + shots.length);
}

function rows(page: Page): Locator {
  return page.getByRole("table", { name: "Shots" }).getByRole("row").filter({ has: page.getByRole("cell") });
}

async function choose(page: Page, filter: string, option: string) {
  await page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: filter, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
