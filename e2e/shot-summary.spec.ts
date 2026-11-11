import { expect, type Locator, type Page, test } from "@playwright/test";
import { preheatShotFixture, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// The Shots list's summary of the Shots its filters find (#466), as an
// Admin, and the same grouped by what Shots have, a table of its groups
// (#468). A simulated tablet running the built plugin backfills five Shots
// derived from two real records, changing only their id, time, recorded
// hardware, Barista and what each line names, and later tests more, on
// Machines of their own. The real Shots weighed 0.1 g and 1.3 g under their
// targets, ran 23.549 s and 25.833 s after their Preheat, and stopped on
// weight. Baristas and hardware ids are made up.
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

test("the grouping control turns the summary into a table of groups, each opening as the list's filters, and the address keeps the grouping", async ({ page }) => {
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
  const summary = page.getByRole("region", { name: "Summary" });
  await expectTip(summary, "Summary", /Group them by one or two things, such as Recipe then Machine, to compare\. A group's count opens its Shots in the list\./);
  await expect(field(summary, "Shots")).toHaveText("61 cleaning or calibration Shot left out");
  await expect(summary.getByRole("combobox", { name: "Then by", exact: true })).toBeDisabled();

  // By Machine: a row each, with the numbers the first had alone, and the second's two real Shots.
  await group(page, "Group by", "Machine");
  await expect(page).toHaveURL(/[?&]groupBy=machine(&|$)/);
  await expect(field(summary, "Shots")).toHaveCount(0);
  await expect(groups(page)).toHaveCount(2);
  await expect(cells(groups(page).nth(0))).toHaveText(["Lab 1", "41 left out", "23.5 s (23.5–24.1)", "−0.1 g (−0.7 to +1.2)3 of 4 Shots", "67%3 of 4 Shots"]);
  await expect(cells(groups(page).nth(1))).toHaveText(["Lab 2", "2", "24.7 s (24.1–25.3)", "−0.7 g (−1.0 to −0.4)", "100%"]);
  await expect(summary.getByText("Groups 1–2 of 2")).toBeVisible();
  // The rows below are as they were.
  await expect(rows(page)).toHaveCount(7);

  // Then by Barista: each Machine's Baristas, Ann one person whatever the case of her name and the spaces around it,
  // by its latest spelling.
  await group(page, "Then by", "Barista");
  await expect(page).toHaveURL(/[?&]groupBy=machine%2Cbarista(&|$)/);
  await expect(page.getByRole("table", { name: "Groups" }).getByRole("columnheader")).toHaveText(["Machine", "Barista", "Shots", "Duration", "Yield against target", "Stopped on weight"]);
  const expected = [
    ["Lab 1", "ANN", "2", "24.7 s (24.1–25.3)", "−0.7 g (−1.0 to −0.4)", "100%"],
    ["Lab 1", "Ben", "1", "23.5 s (23.5–23.5)", "+2.5 g (+2.5 to +2.5)", "0%"],
    // No target, and no stop reason recorded.
    ["Lab 1", "Cat", "1", "23.5 s (23.5–23.5)", "-0 of 1 Shot", "-0 of 1 Shot"],
    // Only a cleaning Shot.
    ["Lab 1", "Dee", "01 left out", "-", "-", "-"],
    ["Lab 2", "ANN", "2", "24.7 s (24.1–25.3)", "−0.7 g (−1.0 to −0.4)", "100%"],
  ];
  await expect(groups(page)).toHaveCount(expected.length);
  for (const [n, row] of expected.entries()) await expect(cells(groups(page).nth(n)), row.join()).toHaveText(row);

  // The grouping is in the page's address, so a reloaded or shared list is grouped the same.
  await page.reload();
  await expect(groups(page)).toHaveCount(expected.length);
  await expect(summary.getByRole("combobox", { name: "Group by", exact: true })).toHaveText("Machine");
  await expect(summary.getByRole("combobox", { name: "Then by", exact: true })).toHaveText("Barista");

  // A group's count opens the list with the group as its filters, which find its Shots, and their summary as one group.
  await groups(page).nth(0).getByRole("link", { name: "2 Shots: Lab 1, ANN", exact: true }).click();
  const { machines } = (await (await page.request.get("/api/machines")).json()) as { machines: { id: string; name: string }[] };
  await expect(page).toHaveURL(new RegExp(`[?&]machineId=${machines.find((machine) => machine.name === "Lab 1")!.id}(&|$)`));
  await expect(page).toHaveURL(/[?&]barista=ANN(&|$)/);
  await expect(page).not.toHaveURL(/groupBy/);
  await expect(rows(page)).toHaveCount(2);
  const filters = page.getByRole("region", { name: "Filters" });
  await expect(filters.getByRole("combobox", { name: "Machine", exact: true })).toHaveText("Lab 1");
  await expect(filters.getByRole("combobox", { name: "Barista", exact: true })).toHaveText("ANN");
  await expect(field(summary, "Shots")).toHaveText("2");
  await expect(field(summary, "Duration")).toHaveText("24.7 s (24.1–25.3)");
  await expect(page.getByRole("table", { name: "Groups" })).toHaveCount(0);

  // Back to the groups. By Recipe alone, every Shot here is in one group, as none was pulled with a Recipe loaded:
  // 23.549 s four times and 25.833 s twice, and −1.3, −1.3, −0.1, −0.1 and 2.5.
  await page.goBack();
  await expect(groups(page)).toHaveCount(expected.length);
  await group(page, "Then by", "Nothing more");
  await expect(groups(page)).toHaveCount(2);
  await group(page, "Group by", "Recipe");
  await expect(page).toHaveURL(/[?&]groupBy=recipe(&|$)/);
  await expect(groups(page)).toHaveCount(1);
  await expect(cells(groups(page).nth(0))).toHaveText(["No Recipe loaded", "61 left out", "23.5 s (23.5–25.3)", "−0.1 g (−1.3 to −0.1)5 of 6 Shots", "80%5 of 6 Shots"]);
  // A group of Shots with none opens as the filter that finds them.
  await groups(page).nth(0).getByRole("link", { name: "6 Shots: No Recipe loaded", exact: true }).click();
  await expect(page).toHaveURL(/[?&]recipeId=none(&|$)/);
  await expect(page).not.toHaveURL(/groupBy/);
  await expect(filters.getByRole("combobox", { name: "Recipe", exact: true })).toHaveText("Pulled with no Recipe loaded");
  // Its summary as one group, which shows only once this address's has loaded, and its Shots.
  await expect(field(summary, "Stopped on weight")).toHaveText("80%5 of 6 Shots recorded what stopped them");
  await expect(rows(page)).toHaveCount(7);
});

test("the Barista filter offers each Barista once, finds every spelling, and clearing the filters keeps the grouping", async ({ page }) => {
  await page.goto("/shots");
  const filters = page.getByRole("region", { name: "Filters" });
  await filters.getByRole("combobox", { name: "Barista", exact: true }).click();
  await expect(page.getByRole("option")).toHaveText(["Any Barista", "ANN", "Ben", "Cat", "Dee"]);
  await page.getByRole("option", { name: "ANN", exact: true }).click();
  // Both Machines' Shots, however each spelled the name.
  await expect(rows(page)).toHaveCount(4);

  // An address holding another spelling, as one shared before, finds the same Shots, and shows the Barista's choice.
  await page.goto("/shots?barista=%20ann&groupBy=machine");
  await expect(rows(page)).toHaveCount(4);
  await expect(filters.getByRole("combobox", { name: "Barista", exact: true })).toHaveText("ANN");
  await expect(groups(page)).toHaveCount(2);

  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(rows(page)).toHaveCount(7);
  await expect(page).toHaveURL(/\/shots\?groupBy=machine$/);
  await expect(cells(groups(page).nth(0))).toHaveText(["Lab 1", "41 left out", "23.5 s (23.5–24.1)", "−0.1 g (−0.7 to +1.2)3 of 4 Shots", "67%3 of 4 Shots"]);

  // An address naming a grouping there isn't is read without it.
  await page.goto("/shots?groupBy=roaster,barista");
  await expect(page.getByRole("region", { name: "Summary" }).getByRole("combobox", { name: "Group by", exact: true })).toHaveText("Barista");
  await expect(groups(page)).toHaveCount(4);
});

test("a grouped summary that fails to load for the filters chosen shows no groups, rather than those of the filters before", async ({ page }) => {
  await page.goto("/shots?groupBy=machine");
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(groups(page)).toHaveCount(2);

  await page.route(
    /\/api\/shots\/summary\?.*barista=Ben/,
    (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ statusCode: 404, message: "Shot not found" }) }),
    { times: 1 },
  );
  await choose(page, "Barista", "Ben");
  await expect(rows(page)).toHaveCount(1);
  await expect(summary.getByRole("alert")).toHaveText("Could not read the summary: Shot not found");
  await expect(page.getByRole("table", { name: "Groups" })).toHaveCount(0);

  // The next filters' groups load as usual.
  await choose(page, "Barista", "Cat");
  await expect(summary.getByRole("alert")).toHaveCount(0);
  await expect(cells(groups(page).nth(0))).toHaveText(["Lab 1", "1", "23.5 s (23.5–23.5)", "-0 of 1 Shot", "-0 of 1 Shot"]);
});

test("more groups than a page holds are shown 25 at a time", async ({ page }) => {
  // A third Machine, with 26 Shots, each recording a profile title of its own: with the two the others recorded, 28.
  const { locations } = (await (await page.request.get("/api/locations")).json()) as { locations: { id: string; name: string }[] };
  const titled = Array.from({ length: 26 }, (_, n) => {
    const shot = shotOf(`lab3-${n}`, `2026-02-12T13:${String(n).padStart(2, "0")}:00Z`, "Eve", {}, shotFixture(), HARDWARE_3);
    const workflow = shot.workflow as Record<string, Fields>;
    return { ...shot, workflow: { ...workflow, profile: { ...workflow.profile, title: `Title ${String(n + 1).padStart(2, "0")}` } } };
  });
  await adopt(page, "Lab 3", locations.find((location) => location.name === "Lab")!.id, titled, HARDWARE_3);

  await page.goto("/shots?groupBy=profile");
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(groups(page)).toHaveCount(25);
  await expect(summary.getByText("Groups 1–25 of 28")).toBeVisible();
  await expect(cells(groups(page).nth(0)).first()).toHaveText("Adaptive v3");
  await expect(summary.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
  await summary.getByRole("button", { name: "Next", exact: true }).click();
  await expect(summary.getByText("Groups 26–28 of 28")).toBeVisible();
  await expect(groups(page)).toHaveCount(3);
  await expect(cells(groups(page).nth(2)).first()).toHaveText("Title 26");
  await expect(summary.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await summary.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(summary.getByText("Groups 1–25 of 28")).toBeVisible();

  // A filter that leaves fewer groups starts from the first again.
  await summary.getByRole("button", { name: "Next", exact: true }).click();
  await expect(summary.getByText("Groups 26–28 of 28")).toBeVisible();
  await choose(page, "Barista", "Eve");
  await expect(summary.getByText("Groups 1–25 of 26")).toBeVisible();
});

const HARDWARE_2 = { model: "DE1Pro", serial: "10042" };
const HARDWARE_3 = { model: "DE1Pro", serial: "10043" };

/** What a test changes of a fixture's record. */
interface Changes {
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
    annotations: { ...(fixture.annotations as Fields), ...(changes.actualYield !== undefined && { actualYield: changes.actualYield }) },
  };
}

/** Creates a machine entry at the Location since long before its Shots, and loads a simulated tablet on its hardware with the Shots, which it backfills; resolves with the Machine's id. */
async function adopt(page: Page, name: string, locationId: string, shots: Fields[], hardware = HARDWARE): Promise<string> {
  const total = async () => ((await (await page.request.get("/api/shots?limit=1")).json()) as { total: number }).total;
  const before = await total();
  const response = await page.request.post("/api/machines", { data: { name } });
  expect(response.status()).toBe(201);
  const { machine, token } = (await response.json()) as { machine: { id: string }; token: string };
  const moved = await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId, effectiveFrom: "2025-01-01T00:00:00Z" } });
  expect(moved.status()).toBe(201);
  SimulatedTablet.load({ settings: settingsFor({ serverUrl: server.url(), token }), api: withShots(derivedDe1Pro(hardware), shots), timeScale: 50 });
  await expect.poll(total, { timeout: 30_000 }).toBe(before + shots.length);
  return machine.id;
}

function rows(page: Page): Locator {
  return page.getByRole("table", { name: "Shots" }).getByRole("row").filter({ has: page.getByRole("cell") });
}

/** The rows of the summary's table of groups, leaving out its header row. */
function groups(page: Page): Locator {
  return page.getByRole("table", { name: "Groups" }).getByRole("row").filter({ has: page.getByRole("cell") });
}

function cells(row: Locator): Locator {
  return row.getByRole("cell");
}

/** Chooses what the summary is grouped by, or then by. */
async function group(page: Page, control: "Group by" | "Then by", option: string) {
  await page.getByRole("region", { name: "Summary" }).getByRole("combobox", { name: control, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function choose(page: Page, filter: string, option: string) {
  await page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: filter, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
