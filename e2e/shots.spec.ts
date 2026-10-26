import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import { derivedShot, preheatShotFixture, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { field } from "./support/locators.js";
import { expectTip, tap } from "./support/tooltips.js";

// Shots in the management interface, as an Admin whose browser is in Tokyo
// while the Locations are in the US: times are shown and filtered in each
// Shot's own Location's time zone. Simulated tablets running the built plugin
// backfill Shots derived from a scrubbed real record, changing only their id,
// time, recorded hardware, Bean, Barista, profile title and grind setting.
// Baristas, Beans and hardware ids are made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
test.use({ timezoneId: "Asia/Tokyo" });
const expect = baseExpect.configure({ timeout: 15_000 });

const tablets: SimulatedTablet[] = [];

const CURVES_TIP =
  "Seconds from the start of the Shot's profile. Dashed lines are the targets the Machine reported." +
  "Preheat, shaded before 0 s, is the Machine heating its water before the profile starts. Its targets are the heater test's, not the profile's, and it doesn't count toward the duration or the peaks.";

interface Recorded {
  hardware?: { model: string; serial: string };
  roaster?: string;
  bean?: string;
  barista?: string;
  profile?: string;
  grinderSetting?: string;
  grinderBurrs?: string;
}

test.beforeEach(({ page }) => signInAsAdmin(page));

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("Shots from every Location are listed newest first, at their Location's time, with inferred credit marked", async ({ page }) => {
  const lab = await createLocation(page, "Lab", "America/Denver");
  const uptown = await createLocation(page, "Uptown", "America/Chicago");
  const lab1 = { model: "DE1Pro", serial: "10021" };
  const uptown1 = { model: "DE1Pro", serial: "10022" };
  const roaming = { model: "DE1XL", serial: "10023" };
  const ethiopia = { roaster: "Roux Bakehouse", bean: "Ethiopia Guji" };

  await adopt(page, "Lab 1", lab1, lab.id, [
    shotAt("lab-espresso", "2026-02-10T13:30:00Z", { hardware: lab1, ...ethiopia, barista: "Ann", profile: "Londonium", grinderSetting: "7.5", grinderBurrs: "SSP MP" }),
    shotAt("lab-dial-in", "2026-02-10T13:00:00Z", { hardware: lab1, ...ethiopia, barista: "Ann", profile: "Londonium", grinderSetting: "8" }),
    // Recorded on hardware no Machine has, before this tablet moved onto Lab 1.
    shotAt("held-shot", "2026-01-20T15:00:00Z", { hardware: { model: "Bengle", serial: "10029" }, roaster: "Roux Bakehouse", bean: "Kenya Nyeri", barista: "Ben" }),
  ]);
  await adopt(page, "Uptown 1", uptown1, uptown.id, [
    shotAt("uptown-espresso", "2026-02-10T12:30:00Z", { hardware: uptown1, ...ethiopia, barista: "Cat", profile: "Blooming" }),
    // Records no hardware, so it is credited to Uptown 1, whose tablet reported it, as inferred.
    shotAt("uptown-inferred", "2026-02-11T15:00:00Z", { roaster: "Other Roaster", bean: "Ethiopia Guji", barista: "Cat", profile: "Blooming" }),
  ]);
  await adopt(page, "Roaming", roaming, null, [shotAt("roaming-shot", "2026-02-10T06:30:00Z", { hardware: roaming, barista: "Ann" })]);

  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Shots" }).click();
  await expect(rows(page)).toHaveCount(6);
  await expectTip(page.getByRole("main"), "Shots", /^Every Shot pulled at every Location, newest first\. Times are shown in each Shot's Location's time zone/);
  await expect(column(page, 1)).toHaveText([
    "Feb 11, 2026, 9:00 AM CST",
    "Feb 10, 2026, 6:30 AM MST",
    "Feb 10, 2026, 6:00 AM MST",
    "Feb 10, 2026, 6:30 AM CST",
    "Feb 10, 2026, 6:30 AM UTC",
    "Jan 20, 2026, 3:00 PM UTC",
  ].map((time) => new RegExp(`^${time}`)));
  await expect(page.getByText("Shots 1–6 of 6")).toBeVisible();

  const labRow = row(page, "Feb 10, 2026, 6:30 AM MST");
  await expect(labRow.getByRole("cell")).toHaveText(["Feb 10, 2026, 6:30 AM MST", "Lab 1", "Lab", "Londonium", "Roux Bakehouse · Ethiopia Guji", "18 g", "35.9 g", "23.5 s", "-", "Ann"]);
  // An inferred Machine credit, and the Location it brings, are marked.
  const inferred = row(page, "Feb 11, 2026, 9:00 AM CST");
  await expect(inferred.getByRole("cell").nth(1)).toHaveText("Uptown 1Inferred");
  await expect(inferred.getByRole("cell").nth(2)).toHaveText("UptownInferred");
  await expect(row(page, "Feb 10, 2026, 6:30 AM CST").getByText("Inferred")).toHaveCount(0);
  // Without a Location, times are in UTC, and say so.
  await expect(row(page, "Feb 10, 2026, 6:30 AM UTC").getByRole("cell").nth(2)).toHaveText("No Location, times in UTC");
  await expect(row(page, "Jan 20, 2026, 3:00 PM UTC").getByRole("cell").nth(1)).toHaveText("Bengle serial 10029Pending Machine");
});

test("filters narrow the list alone and together, with dates read in each Shot's Location's time zone", async ({ page }) => {
  await page.goto("/shots");
  await expect(rows(page)).toHaveCount(6);
  await expectTip(page.getByRole("region", { name: "Filters" }), "dates and times", /^Dates and times are read in each Shot's Location's time zone, so 7:00 means 7:00 wherever it was pulled\./);

  await choose(page, "Location", "Uptown");
  await expect(rows(page)).toHaveCount(2);
  await choose(page, "Location", "No Location (UTC)");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText("Roaming");
  await choose(page, "Location", "Any Location");

  // The same Bean across Machines, but not the same name from another roaster.
  await choose(page, "Bean", "Roux Bakehouse · Ethiopia Guji");
  await expect(rows(page)).toHaveCount(3);
  await expect(column(page, 2)).toHaveText(["Lab 1", "Lab 1", "Uptown 1"]);
  await choose(page, "Barista", "Cat");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Uptown 1");
  await choose(page, "Profile", "Londonium");
  await expect(page.getByText("No Shots match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows(page)).toHaveCount(6);

  // A page past the end, as an old link may name, moves to the last page.
  await page.goto("/shots?offset=25");
  await expect(rows(page)).toHaveCount(6);
  await expect(page).toHaveURL(/\/shots$/);

  // A Pending Machine's Shots can be reviewed before an Admin adopts or dismisses it.
  await choose(page, "Machine", "Bengle serial 10029");
  await expect(rows(page)).toHaveCount(1);
  await choose(page, "Machine", "Lab 1");
  await expect(rows(page)).toHaveCount(2);
  await choose(page, "Machine", "Any Machine");

  // 6:00 to 9:00 on February 10, which is a different moment at each Location.
  await chooseDate(page, "From", 2026, "Feb", 10);
  await page.getByLabel("From time").fill("06:00");
  await chooseDate(page, "To", 2026, "Feb", 10);
  await page.getByLabel("To time").fill("09:00");
  await expect(page).toHaveURL(/from=2026-02-10T06%3A00&to=2026-02-10T09%3A00|from=2026-02-10T06:00&to=2026-02-10T09:00/);
  await expect(column(page, 1)).toHaveText([/^Feb 10, 2026, 6:30 AM MST/, /^Feb 10, 2026, 6:00 AM MST/, /^Feb 10, 2026, 6:30 AM CST/, /^Feb 10, 2026, 6:30 AM UTC/]);
  // Until 6:15 leaves out the Shots pulled at 6:30 by their own Location's clock.
  await page.getByLabel("To time").fill("06:15");
  await expect(column(page, 1)).toHaveText([/^Feb 10, 2026, 6:00 AM MST/]);

  // The filters are in the page's address, so reloading or sharing it keeps them.
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "From" })).toHaveText("Feb 10, 2026");
});

test("a Shot's page shows its curves and everything recorded, and compares it with the previous Shot on its Machine", async ({ page }) => {
  await page.goto("/shots?machineId=" + (await machineId(page, "Lab 1")));
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole("link", { name: "Feb 10, 2026, 6:30 AM MST" }).click();

  await expect(page.getByRole("heading", { name: "Shot pulled Feb 10, 2026, 6:30 AM MST", level: 1 })).toBeVisible();
  const curves = page.getByRole("region", { name: "Curves" });
  for (const name of ["Pressure", "Flow", "Weight", "Temperature"]) {
    const chart = curves.getByRole("figure", { name });
    await expect(chart.locator(".recharts-line")).not.toHaveCount(0);
    await expect(chart).toContainText("This Shot");
  }
  await expect(curves.getByRole("figure", { name: "Pressure" })).toContainText("Target");
  await expect(curves.getByText("Previous Shot", { exact: true })).toHaveCount(0);
  await expect(field(page.getByRole("region", { name: "Machine at the time" }), "Serial")).toHaveText("10021");
  await expect(field(page.getByRole("region", { name: "Workflow" }), "Grind setting")).toHaveText("7.5");
  await expect(field(page.getByRole("region", { name: "Workflow" }), "Burrs")).toHaveText("SSP MP");
  await expect(field(page.getByRole("region", { name: "Annotations" }), "Yield weighed")).toHaveText("35.9 g");
  await expectTip(curves, "Curves", CURVES_TIP);
  await expectTip(page.getByRole("region", { name: "Annotations" }), "Annotations", "How it turned out, as recorded on the tablet.");

  await curves.getByRole("checkbox", { name: "Compare with the previous Shot on Lab 1" }).check();
  for (const name of ["Pressure", "Flow", "Weight", "Temperature"]) {
    await expect(curves.getByRole("figure", { name })).toContainText("Previous Shot");
  }
  const comparison = curves.getByRole("table", { name: "Comparison with the previous Shot" });
  await expect(comparison.getByRole("row", { name: /^Pulled/ }).getByRole("cell")).toHaveText(["Feb 10, 2026, 6:30 AM MST", "Feb 10, 2026, 6:00 AM MST"]);
  await expect(comparison.getByRole("row", { name: /^Grind setting/ }).getByRole("cell")).toHaveText(["7.5", "8"]);

  await comparison.getByRole("link", { name: "Previous Shot" }).click();
  await expect(page.getByRole("heading", { name: "Shot pulled Feb 10, 2026, 6:00 AM MST", level: 1 })).toBeVisible();
  // The first Shot on Lab 1 has none before it.
  await expect(page.getByText("There is no earlier Shot on Lab 1 to compare it with.")).toBeVisible();

  // An inferred Shot says so.
  await page.goto("/shots");
  await page.getByRole("link", { name: "Feb 11, 2026, 9:00 AM CST" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Inferred credit" })).toContainText(
    "This Shot recorded no machine hardware, so it is credited to Uptown 1, whose tablet reported it. Its Location, Uptown, comes from that Machine's Location History, so it is inferred too.",
  );
  await expect(page.getByRole("region", { name: "Machine at the time" })).toContainText("It recorded no machine hardware.");

  // Back to the list as it was left.
  await page.goto("/shots?barista=Ann");
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole("link", { name: "Feb 10, 2026, 6:30 AM UTC" }).click();
  await page.getByRole("link", { name: "← Shots" }).click();
  await expect(page).toHaveURL(/\/shots\?barista=Ann$/);
  await expect(rows(page)).toHaveCount(3);
});

test("a curve breaks where its samples have no value, as a pressure target where a step sets none", async ({ page }) => {
  // Derived: the real Shot's samples with their pressure targets changed to 3, 3, none (0) and 9 bar,
  // at -4.4 (in Preheat), 0, 21.4 and 23.5 seconds, as a profile switching from pressure to flow control and back would record.
  const hardware = { model: "DE1Pro", serial: "10024" };
  const shot = shotAt("switching-shot", "2026-03-01T12:00:00Z", { hardware });
  const targets = [3, 3, 0, 9];
  shot.measurements = (shot.measurements as { machine: Record<string, unknown> }[]).map((sample, n) => ({
    ...sample,
    machine: { ...sample.machine, targetPressure: targets[n] },
  }));
  // Derived: a long Shot of the real Shot's samples repeated a second apart for over eleven minutes, with
  // a target of 3 bar, then none for a fifth of a second at 300.2 s, then 9 bar.
  const long = shotAt("long-switching-shot", "2026-03-02T12:00:00Z", { hardware });
  const samples = shot.measurements as { machine: Record<string, unknown>; scale: Record<string, unknown> }[];
  const seconds = [...Array.from({ length: 301 }, (_, n) => n), 300.2, 300.4, ...Array.from({ length: 400 }, (_, n) => 301 + n)];
  long.measurements = seconds.map((second, n) => {
    const at = new Date(Date.UTC(2026, 2, 2, 12) + second * 1000).toISOString().replace("Z", "");
    const sample = samples[n % samples.length]!;
    return {
      ...sample,
      machine: { ...sample.machine, timestamp: at, targetPressure: second < 300.1 ? 3 : second < 300.3 ? 0 : 9 },
      scale: { ...sample.scale, timestamp: at },
    };
  });
  // Derived: the real Shot's samples with the tablet's clock set back five seconds after the second, as
  // Decaid would record across a correction, so two samples fall at one elapsed time, the second without a target.
  const setBack = shotAt("clock-set-back-shot", "2026-03-03T12:00:00Z", { hardware });
  setBack.measurements = [0, 1000, -4000, -3950, -2900].map((ms, n) => {
    const at = new Date(Date.UTC(2026, 2, 3, 12) + ms).toISOString().replace("Z", "");
    const sample = samples[n % samples.length]!;
    return { ...sample, machine: { ...sample.machine, timestamp: at, targetPressure: [3, 3, 0, 9, 9][n] }, scale: { ...sample.scale, timestamp: at } };
  });
  await adopt(page, "Switcher", hardware, null, [shot, long, setBack]);

  await page.goto("/shots/switching-shot");
  const pressure = page.getByRole("region", { name: "Curves" }).getByRole("figure", { name: "Pressure" });
  const plot = pressure.locator('[data-slot="chart"]');
  const tooltip = pressure.locator(".recharts-tooltip-wrapper");
  const box = (await plot.boundingBox())!;
  // The plot starts after the 40-pixel y-axis and runs from -5 to 24 seconds.
  const at = (seconds: number) => ({ x: 40 + ((box.width - 48) * (seconds + 5)) / 29, y: box.height / 3 });

  await plot.hover({ position: at(-2.4) });
  await expect(tooltip).toContainText("Target3 bar");
  // Between 0 and 21.4 seconds no step set a pressure target, so none is drawn or named.
  await plot.hover({ position: at(9.6) });
  await expect(tooltip).toContainText("This Shot");
  await expect(tooltip).not.toContainText("Target");
  // The last sample's target is kept, though it falls between the chart's tenths of a second.
  await plot.hover({ position: at(23.6) });
  await expect(tooltip).toContainText("Target9 bar");
  // That target has no value either side, so a line would not show it: it is marked.
  await expect(pressure.locator('circle[data-lone-reading="target"]')).toHaveCount(1);
  await expect(pressure.locator('circle[data-lone-reading="target"]')).toBeVisible();

  // On the long Shot the chart reads more than a second apart, yet the fifth of a second without a target still breaks its line.
  await page.goto("/shots/long-switching-shot");
  const target = pressure.locator("path.recharts-line-curve[stroke-dasharray]");
  await expect(target).toHaveCount(1);
  expect((await target.getAttribute("d"))?.match(/M/g)).toHaveLength(2);

  // Nor does a gap where the tablet's clock went back, at a time another sample shares.
  await page.goto("/shots/clock-set-back-shot");
  await expect(target).toHaveCount(1);
  expect((await target.getAttribute("d"))?.match(/M/g)).toHaveLength(2);
});

test("a Shot's Preheat is shaded and labelled before 0 s, left out of its duration, and marked in its measurements", async ({ page }) => {
  // The real Shot with a long Preheat, 7.36 s, and before it on the same Machine the other real Shot, whose
  // Preheat lasted 4.39 s, each changing only its id and recorded hardware, and the other its time.
  const hardware = { model: "DE1Pro", serial: "10027" };
  const preheated = preheatShotFixture();
  const { machine, ...workflow } = preheated.workflow as Record<string, Record<string, unknown>>;
  const shot = { ...preheated, id: "preheat-shot", workflow: { ...workflow, machine: { ...machine, serialNumber: hardware.serial } } };
  await adopt(page, "Preheater", hardware, null, [shot, shotAt("preheat-previous", "2026-10-25T12:00:00Z", { hardware })]);

  await page.goto("/shots/preheat-shot");
  // From the first sample after Preheat, not the 33.2 s since the recording started.
  await expect(field(page, "Duration")).toHaveText("25.8 s");
  const curves = page.getByRole("region", { name: "Curves" });
  for (const name of ["Pressure", "Flow", "Weight", "Temperature"]) {
    const chart = curves.getByRole("figure", { name });
    await expect(chart.locator(".recharts-reference-area")).toHaveCount(1);
    await expect(chart.getByText("Preheat", { exact: true })).toBeVisible();
  }

  // A tap as iOS Safari makes one opens the Curves card's explanation, and a tap elsewhere closes it.
  await page.mouse.move(0, 0);
  await tap(curves.getByRole("button", { name: "About Curves", exact: true }));
  await expect(page.getByRole("tooltip")).toHaveText(CURVES_TIP);
  await tap(curves.getByRole("heading", { name: "Curves" }));
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  // Compared, both Shots are aligned at 0 s, each with its own Preheat before it: the previous Shot's
  // starts at -4.4 s and its profile ends at 23.5 s, this one's at -7.4 s and 25.8 s.
  await curves.getByRole("checkbox", { name: "Compare with the previous Shot on Preheater" }).check();
  const pressure = curves.getByRole("figure", { name: "Pressure" });
  await expect(pressure).toContainText("Previous Shot");
  const plot = pressure.locator('[data-slot="chart"]');
  const tooltip = pressure.locator(".recharts-tooltip-wrapper");
  const box = (await plot.boundingBox())!;
  // The plot starts after the 40-pixel y-axis and runs from -8 to 26 seconds.
  const at = (seconds: number) => ({ x: 40 + ((box.width - 48) * (seconds + 8)) / 34, y: box.height / 3 });
  for (const [seconds, previous] of [[-6, false], [-2, true], [22, true], [24.5, false]] as const) {
    await plot.hover({ position: at(seconds) });
    await expect(tooltip).toContainText("This Shot");
    if (previous) await expect(tooltip).toContainText("Previous Shot");
    else await expect(tooltip).not.toContainText("Previous Shot");
    // Every time before 0 s is in Preheat, and the tooltip says so.
    if (seconds < 0) await expect(tooltip).toContainText(/s, Preheat/);
    else await expect(tooltip).not.toContainText("Preheat");
  }

  await curves.getByRole("button", { name: "Measurements as a table" }).click();
  const measurements = curves.getByRole("table", { name: "Measurements" }).getByRole("row").filter({ has: page.getByRole("cell") });
  await expect(measurements).toHaveCount(168);
  await expect(measurements.first().getByRole("cell").first()).toHaveText("-7.36 sPreheat");
  await expect(measurements.nth(42).getByRole("cell").first()).toHaveText(/^-0\.\d\d sPreheat$/);
  await expect(measurements.nth(43).getByRole("cell").first()).toHaveText("0.00 s");
  await expect(measurements.filter({ hasText: "Preheat" })).toHaveCount(43);
});

test("a Shot's record as sent scrolls a long line in its box, leaving the page and its charts their width", async ({ page }) => {
  // Derived: the real Shot with its profile's notes one long line, as a profile's description often is.
  const hardware = { model: "DE1Pro", serial: "10026" };
  const shot = shotAt("long-notes-shot", "2026-03-04T12:00:00Z", { hardware });
  const workflow = shot.workflow as { profile: Record<string, unknown> };
  workflow.profile = { ...workflow.profile, notes: "Pre-infuse gently, then let the lever decline. ".repeat(12) };
  await adopt(page, "Notes", hardware, null, [shot]);

  await page.goto("/shots/long-notes-shot");
  const pressure = page.getByRole("region", { name: "Curves" }).getByRole("figure", { name: "Pressure" });
  await expect(pressure.locator(".recharts-line")).not.toHaveCount(0);
  const width = (await pressure.boundingBox())!.width;

  await page.getByRole("button", { name: "Record as sent" }).click();
  const sent = page.locator("pre").filter({ hasText: "let the lever decline" });
  await expect(sent).toBeVisible();
  expect(await sent.evaluate((pre) => pre.scrollWidth > pre.clientWidth)).toBe(true);
  expect((await pressure.boundingBox())!.width).toBe(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("going back to a later page keeps it, though the filters left meanwhile matched nothing", async ({ page }) => {
  const shots = Array.from({ length: 30 }, (_, n) =>
    shotAt(`page-shot-${n}`, new Date(Date.UTC(2026, 3, 1, 8, n)).toISOString(), { hardware: { model: "DE1Pro", serial: "10025" } }),
  );
  await adopt(page, "Pager", { model: "DE1Pro", serial: "10025" }, null, shots);

  await page.goto(`/shots?machineId=${await machineId(page, "Pager")}`);
  await expect(rows(page)).toHaveCount(25);
  await page.getByRole("link", { name: "Go to next page" }).click();
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByText("Shots 26–30 of 30")).toBeVisible();
  const later = page.url();

  await choose(page, "Barista", "Cat");
  await expect(page.getByText("No Shots match these filters.")).toBeVisible();
  await page.goBack();
  await expect(page.getByText("Shots 26–30 of 30")).toBeVisible();
  expect(page.url()).toBe(later);
});

/** A Shot pulled at a UTC time, recording only what is given beside the real record; with no hardware, it records none. */
function shotAt(id: string, pulledAt: string, recorded: Recorded): Record<string, unknown> {
  const { machine, context, profile, ...workflow } = shotFixture().workflow as Record<string, Record<string, unknown>>;
  return derivedShot(id, {
    timestamp: pulledAt,
    workflow: {
      ...workflow,
      context: {
        ...context,
        ...(recorded.roaster === undefined ? {} : { coffeeRoaster: recorded.roaster }),
        ...(recorded.bean === undefined ? {} : { coffeeName: recorded.bean }),
        ...(recorded.barista === undefined ? {} : { baristaName: recorded.barista }),
        ...(recorded.grinderSetting === undefined ? {} : { grinderSetting: recorded.grinderSetting }),
        ...(recorded.grinderBurrs === undefined ? {} : { grinderBurrs: recorded.grinderBurrs }),
      },
      profile: recorded.profile === undefined ? profile : { ...profile, title: recorded.profile },
      ...(recorded.hardware ? { machine: { ...machine, model: recorded.hardware.model, serialNumber: recorded.hardware.serial } } : {}),
    },
  });
}

/**
 * Creates a machine entry, at a Location since long before its Shots if one
 * is given, and loads a simulated tablet on its hardware with the Shots, which
 * it backfills.
 */
async function adopt(page: Page, name: string, hardware: { model: string; serial: string }, locationId: string | null, shots: Record<string, unknown>[]) {
  const response = await page.request.post("/api/machines", { data: { name } });
  baseExpect(response.status()).toBe(201);
  const { machine, token } = (await response.json()) as { machine: { id: string }; token: string };
  if (locationId) {
    const moved = await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId, effectiveFrom: "2025-01-01T00:00:00Z" } });
    baseExpect(moved.status()).toBe(201);
  }
  tablets.push(
    SimulatedTablet.load({
      settings: settingsFor({ serverUrl: server.url(), token }),
      api: withShots(derivedDe1Pro(hardware), shots),
      timeScale: 50,
    }),
  );
  await baseExpect
    .poll(async () => {
      const listed = await page.request.get(`/api/shots?limit=100`);
      const ids = ((await listed.json()) as { shots: { id: string }[] }).shots.map((shot) => shot.id);
      return shots.every((shot) => ids.includes(String(shot.id)));
    }, { timeout: 15_000 })
    .toBe(true);
}

async function machineId(page: Page, name: string): Promise<string> {
  const { machines } = (await (await page.request.get("/api/machines")).json()) as { machines: { id: string; name: string }[] };
  return machines.find((machine) => machine.name === name)!.id;
}

function rows(page: Page): Locator {
  return page.getByRole("table", { name: "Shots" }).getByRole("row").filter({ has: page.getByRole("cell") });
}

/** Each listed Shot's cell in a column, counted from 1. */
function column(page: Page, n: number): Locator {
  return rows(page).locator(`td:nth-child(${n})`);
}

/** The Shots list's row for the Shot pulled at that time, as the list shows it. */
function row(page: Page, time: string): Locator {
  return rows(page).filter({ has: page.getByRole("link", { name: time, exact: true }) });
}

async function choose(page: Page, filter: string, option: string) {
  await page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: filter, exact: true }).click();
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
