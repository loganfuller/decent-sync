import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import { derivedSteam, nextMilkProbeSteamFixture, steamFixture, withSteams } from "../server/test/support/steam-fixtures.js";
import { RawConnection, SimulatedTablet, derivedDe1Pro, helloWith, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// Steam Records in the management interface, as an Admin whose browser is in
// Tokyo while the Locations are in the US: times are shown and filtered in
// each Steam Record's own Location's time zone. Simulated tablets running the
// built plugin backfill Steam Records derived from records Decaid produced,
// changing only their ids and local times. Hardware ids are made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
test.use({ timezoneId: "Asia/Tokyo" });
const expect = baseExpect.configure({ timeout: 15_000 });

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };
const sam = { name: "Sam Staff", email: "sam@example.com", password: "staff password 1" };
const tablets: SimulatedTablet[] = [];

test.beforeEach(async ({ page }) => {
  // The first test sets the server up; later ones sign in. Both sign the page's context in.
  const setup = await page.request.post("/api/setup", { data: admin });
  if (setup.status() === 409) await page.request.post("/api/session", { data: admin });
  else baseExpect(setup.status()).toBe(201);
});

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("Steam Records from every Location are listed newest first, at their Location's time", async ({ page }) => {
  const lab = await createLocation(page, "Lab", "America/Denver");
  const uptown = await createLocation(page, "Uptown", "America/Chicago");
  await adopt(page, "Lab 1", { model: "DE1Pro", serial: "10041" }, lab.id, [
    steamAt("lab-latte", "2026-02-10T13:30:00Z"),
    // The test tablet's DE1Pro has no milk probe.
    steamAt("lab-cortado", "2026-02-10T13:00:00Z", steamFixture()),
  ]);
  await adopt(page, "Uptown 1", { model: "DE1Pro", serial: "10042" }, uptown.id, [
    steamAt("uptown-flat-white", "2026-02-10T12:30:00Z"),
    // Recorded right after another, so it starts with the probe's last reading of that one.
    steamAt("uptown-next", "2026-02-11T15:00:00Z", nextMilkProbeSteamFixture()),
  ]);
  await adopt(page, "Roaming", { model: "DE1XL", serial: "10043" }, null, [steamAt("roaming-steam", "2026-02-10T06:30:00Z")]);

  // Uptown 2's token, bound to its own hardware, on a tablet at other hardware: that hardware's Pending Machine holds what it sends.
  const borrowed = await createMachine(page, "Uptown 2");
  const raw = await RawConnection.open(server.url());
  raw.send(helloWith(borrowed.token, { machine: { model: "DE1Pro", serial: "10044" } }));
  baseExpect(await raw.message(0)).toMatchObject({ type: "welcome" });
  await raw.close();
  await load(page, borrowed.token, { model: "Bengle", serial: "10049" }, [steamAt("held-steam", "2026-01-20T15:00:00Z")]);

  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Steam Records" }).click();
  await expect(rows(page)).toHaveCount(6);
  await expect(column(page, 1)).toHaveText([
    "Feb 11, 2026, 9:00 AM CST",
    "Feb 10, 2026, 6:30 AM MST",
    "Feb 10, 2026, 6:00 AM MST",
    "Feb 10, 2026, 6:30 AM CST",
    "Feb 10, 2026, 6:30 AM UTC",
    "Jan 20, 2026, 3:00 PM UTC",
  ]);
  await expect(page.getByText("Steam Records 1–6 of 6")).toBeVisible();

  await expect(row(page, "Feb 10, 2026, 6:30 AM MST").getByRole("cell")).toHaveText(["Feb 10, 2026, 6:30 AM MST", "Lab 1", "Lab", "11.8 s", "60.46 °C", "60.46 °C", "Fixture Barista"]);
  await expect(row(page, "Feb 10, 2026, 6:00 AM MST").getByRole("cell")).toHaveText(["Feb 10, 2026, 6:00 AM MST", "Lab 1", "Lab", "3.8 s", "-", "-", "Fixture Barista"]);
  // Without a Location, times are in UTC, and say so.
  await expect(row(page, "Feb 10, 2026, 6:30 AM UTC").getByRole("cell").nth(2)).toHaveText("No Location, times in UTC");
  await expect(row(page, "Jan 20, 2026, 3:00 PM UTC").getByRole("cell").nth(1)).toHaveText("Bengle serial 10049Pending Machine");
  // Steam Records record no hardware, so their credit is never marked inferred.
  await expect(page.getByText("Inferred")).toHaveCount(0);
});

test("filters by Location, Machine and date narrow the list, with dates read in each Steam Record's Location's time zone", async ({ page }) => {
  await page.goto("/steam-records");
  await expect(rows(page)).toHaveCount(6);

  await choose(page, "Location", "Uptown");
  await expect(column(page, 2)).toHaveText(["Uptown 1", "Uptown 1"]);
  await choose(page, "Location", "No Location (UTC)");
  await expect(column(page, 1)).toHaveText(["Feb 10, 2026, 6:30 AM UTC", "Jan 20, 2026, 3:00 PM UTC"]);
  // A Pending Machine's Steam Records can be reviewed before an Admin adopts or dismisses it.
  await choose(page, "Machine", "Bengle serial 10049");
  await expect(column(page, 1)).toHaveText(["Jan 20, 2026, 3:00 PM UTC"]);
  await choose(page, "Location", "Any Location");
  await choose(page, "Machine", "Lab 1");
  await expect(column(page, 1)).toHaveText(["Feb 10, 2026, 6:30 AM MST", "Feb 10, 2026, 6:00 AM MST"]);
  await choose(page, "Location", "Uptown");
  await expect(page.getByText("No Steam Records match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows(page)).toHaveCount(6);

  // A page past the end, as an old link may name, moves to the last page.
  await page.goto("/steam-records?offset=25");
  await expect(rows(page)).toHaveCount(6);
  await expect(page).toHaveURL(/\/steam-records$/);

  // 6:00 to 9:00 on February 10, which is a different moment at each Location.
  await chooseDate(page, "From", 2026, "Feb", 10);
  await page.getByLabel("From time").fill("06:00");
  await chooseDate(page, "To", 2026, "Feb", 10);
  await page.getByLabel("To time").fill("09:00");
  await expect(page).toHaveURL(/from=2026-02-10T06%3A00&to=2026-02-10T09%3A00|from=2026-02-10T06:00&to=2026-02-10T09:00/);
  await expect(column(page, 1)).toHaveText(["Feb 10, 2026, 6:30 AM MST", "Feb 10, 2026, 6:00 AM MST", "Feb 10, 2026, 6:30 AM CST", "Feb 10, 2026, 6:30 AM UTC"]);
  // Until 6:15 leaves out those recorded at 6:30 by their own Location's clock.
  await page.getByLabel("To time").fill("06:15");
  await expect(column(page, 1)).toHaveText(["Feb 10, 2026, 6:00 AM MST"]);

  // The filters are in the page's address, so reloading or sharing it keeps them.
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "From" })).toHaveText("Feb 10, 2026");

  // A Machine's page, and each Pending Machine, link to the Steam Records they hold.
  await page.goto("/machines");
  const pending = page.getByRole("list", { name: "Pending Machines", exact: true }).getByRole("listitem").filter({ hasText: "Bengle serial 10049" });
  await pending.getByRole("link", { name: "Review the Steam Records it holds" }).click();
  await expect(column(page, 1)).toHaveText(["Jan 20, 2026, 3:00 PM UTC"]);
  await page.goto(`/machines/${await machineId(page, "Uptown 1")}`);
  await page.getByRole("link", { name: "All its Steam Records" }).click();
  await expect(column(page, 1)).toHaveText(["Feb 11, 2026, 9:00 AM CST", "Feb 10, 2026, 6:30 AM CST"]);
});

test("a Steam Record's page shows its milk temperatures, steam settings and curves", async ({ page }) => {
  await page.goto(`/steam-records?machineId=${await machineId(page, "Lab 1")}`);
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole("link", { name: "Feb 10, 2026, 6:30 AM MST" }).click();

  await expect(page.getByRole("heading", { name: "Steam Record from Feb 10, 2026, 6:30 AM MST", level: 1 })).toBeVisible();
  const details = page.getByLabel("Steam Record", { exact: true });
  await expect(field(details, "Peak milk temperature")).toHaveText("60.46 °C");
  await expect(field(details, "Final milk temperature")).toHaveText("60.46 °C");
  await expect(field(details, "Duration")).toHaveText("11.8 s");
  await expect(field(details, "Location")).toHaveText("Lab");
  const settings = page.getByRole("region", { name: "Steam settings" });
  await expect(field(settings, "Steam temperature")).toHaveText("150 °C");
  await expect(field(settings, "Stops at milk temperature")).toHaveText("60 °C");

  const curves = page.getByRole("region", { name: "Curves" });
  for (const name of ["Milk temperature", "Steam temperature", "Pressure", "Flow"]) {
    const chart = curves.getByRole("figure", { name });
    await expect(chart.locator(".recharts-line")).not.toHaveCount(0);
    await expect(chart).toContainText("This Steam Record");
  }
  // The milk temperature its Workflow stops steaming at.
  await expect(curves.getByRole("figure", { name: "Milk temperature" })).toContainText("Target");

  // Without a milk probe, there is no milk temperature to show, and its Workflow set no stop at one.
  await page.getByRole("link", { name: "← Steam Records" }).click();
  await expect(page).toHaveURL(/\/steam-records\?machineId=/);
  await page.getByRole("link", { name: "Feb 10, 2026, 6:00 AM MST" }).click();
  await expect(field(details, "Peak milk temperature")).toHaveText("-");
  await expect(curves.getByRole("figure", { name: "Milk temperature" })).toContainText("Not recorded.");
  await expect(curves.getByRole("figure", { name: "Pressure" }).locator(".recharts-line")).not.toHaveCount(0);
  await expect(field(settings, "Stops at milk temperature")).toHaveText("Off");

  // One that started with the reading carried over from the Steam Record before says why its peak is lower.
  await page.goto("/steam-records");
  await page.getByRole("link", { name: "Feb 11, 2026, 9:00 AM CST" }).click();
  await expect(field(details, "Peak milk temperature")).toContainText("61.46 °C");
  await expect(field(details, "Peak milk temperature")).toContainText("Leaves out the 61.95 °C it started with");
  await expect(field(details, "Final milk temperature")).toHaveText("61.46 °C");

  // A Pending Machine's Steam Record has no Location, so its times are in UTC.
  await page.goto("/steam-records");
  await page.getByRole("link", { name: "Jan 20, 2026, 3:00 PM UTC" }).click();
  await expect(page.getByText("Its Location is unknown, so times are in UTC.")).toBeVisible();
  await expect(field(details, "Machine")).toHaveText("Bengle serial 10049Pending Machine");
});

test("Staff see every Steam Record an Admin sees", async ({ page, browser }) => {
  const { locations } = (await (await page.request.get("/api/locations")).json()) as { locations: { id: string; name: string }[] };
  const response = await page.request.post("/api/invites", {
    data: { email: sam.email, role: "staff", locationIds: [locations.find((location) => location.name === "Uptown")!.id] },
  });
  baseExpect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const samsBrowser = await browser.newContext({ baseURL: server.url(), timezoneId: "Asia/Tokyo" });
  try {
    const accepted = await samsBrowser.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: sam });
    baseExpect(accepted.status()).toBe(201);
    const samsPage = await samsBrowser.newPage();
    await samsPage.goto("/steam-records");
    await expect(rows(samsPage)).toHaveCount(6);
    await page.goto("/steam-records");
    await expect(rows(page)).toHaveCount(6);
    await expect(rows(samsPage)).toHaveText(await rows(page).allTextContents());

    // Including at Locations Sam does not work at.
    await choose(samsPage, "Location", "Lab");
    await expect(rows(samsPage)).toHaveCount(2);
    await samsPage.getByRole("link", { name: "Feb 10, 2026, 6:30 AM MST" }).click();
    await expect(samsPage.getByRole("region", { name: "Curves" }).getByRole("figure", { name: "Milk temperature" }).locator(".recharts-line")).not.toHaveCount(0);
  } finally {
    await samsBrowser.close();
  }
});

/**
 * A Steam Record recorded at a UTC time, derived from one Decaid produced. Its
 * `timestamp` is that time on the tablet's clock, as Decaid writes it: local
 * time without an offset, to the microsecond. The simulated tablet runs the
 * plugin in this process, so its clock is this process's time zone, and the
 * plugin places the record back at that UTC time.
 */
function steamAt(id: string, steamedAt: string, fixture?: Record<string, unknown>): Record<string, unknown> {
  const at = new Date(steamedAt);
  const pad = (part: number, length = 2) => String(part).padStart(length, "0");
  const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}000`;
  return derivedSteam(id, { timestamp: local }, fixture);
}

/**
 * Creates a machine entry, at a Location since long before its Steam Records
 * if one is given, and loads a simulated tablet on its hardware with the Steam
 * Records, which it backfills.
 */
async function adopt(page: Page, name: string, hardware: { model: string; serial: string }, locationId: string | null, steams: Record<string, unknown>[]) {
  const { machine, token } = await createMachine(page, name);
  if (locationId) {
    const moved = await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId, effectiveFrom: "2025-01-01T00:00:00Z" } });
    baseExpect(moved.status()).toBe(201);
  }
  await load(page, token, hardware, steams);
}

/** Loads a simulated tablet with the token, on the hardware given, and waits until its Steam Records are listed. */
async function load(page: Page, token: string, hardware: { model: string; serial: string }, steams: Record<string, unknown>[]) {
  tablets.push(
    SimulatedTablet.load({
      settings: settingsFor({ serverUrl: server.url(), token }),
      api: withSteams(derivedDe1Pro(hardware), steams),
      timeScale: 50,
    }),
  );
  await baseExpect
    .poll(async () => {
      const listed = await page.request.get("/api/steam-records?limit=100");
      const ids = ((await listed.json()) as { steamRecords: { id: string }[] }).steamRecords.map((steam) => steam.id);
      return steams.every((steam) => ids.includes(String(steam.id)));
    }, { timeout: 15_000 })
    .toBe(true);
}

async function createMachine(page: Page, name: string): Promise<{ machine: { id: string }; token: string }> {
  const response = await page.request.post("/api/machines", { data: { name } });
  baseExpect(response.status()).toBe(201);
  return (await response.json()) as { machine: { id: string }; token: string };
}

async function createLocation(page: Page, name: string, timeZone: string): Promise<{ id: string }> {
  const response = await page.request.post("/api/locations", { data: { name, timeZone } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string } }).location;
}

async function machineId(page: Page, name: string): Promise<string> {
  const { machines } = (await (await page.request.get("/api/machines")).json()) as { machines: { id: string; name: string }[] };
  return machines.find((machine) => machine.name === name)!.id;
}

function rows(page: Page): Locator {
  return page.getByRole("table", { name: "Steam Records" }).getByRole("row").filter({ has: page.getByRole("cell") });
}

/** Each listed Steam Record's cell in a column, counted from 1. */
function column(page: Page, n: number): Locator {
  return rows(page).locator(`td:nth-child(${n})`);
}

/** The list's row for the Steam Record recorded at that time, as the list shows it. */
function row(page: Page, time: string): Locator {
  return rows(page).filter({ has: page.getByRole("link", { name: time, exact: true }) });
}

async function choose(page: Page, filter: string, option: string) {
  await page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: filter }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Picks a day in a date filter's calendar, going to its month and year first. */
async function chooseDate(page: Page, filter: string, year: number, month: string, day: number) {
  await page.getByRole("button", { name: filter, exact: true }).click();
  const calendar = page.getByRole("dialog");
  await calendar.getByRole("combobox", { name: "Choose the Year" }).selectOption(String(year));
  await calendar.getByRole("combobox", { name: "Choose the Month" }).selectOption({ label: month });
  await calendar.getByRole("button", { name: new RegExp(`, \\w+ ${day}(st|nd|rd|th), ${year}`) }).click();
  await expect(calendar).toHaveCount(0);
}

/** The value of a field, by its term. */
function field(scope: Locator, term: string): Locator {
  return scope.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}
