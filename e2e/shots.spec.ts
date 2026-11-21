import { expect, type Locator, type Page, test } from "@playwright/test";
import { derivedShot, preheatShotFixture, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { chooseFilter, datesPreset, field, openCard } from "./support/locators.js";
import { expectTip, tap } from "./support/tooltips.js";

// Shots in the management interface, as an Admin whose browser is in Tokyo
// while the Locations are in the US: times are shown and filtered in each
// Shot's own Location's time zone. Simulated tablets running the built plugin
// backfill Shots derived from a scrubbed real record, changing only their id,
// time, recorded hardware, Bean, Barista, profile title and grind setting.
// Baristas, Beans and hardware ids are made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
test.use({ timezoneId: "Asia/Tokyo" });

const CURVES_TIP =
  "Seconds from the start of the Shot's profile. Dashed lines are the targets the Machine reported. Flow is the pump's, and weight flow the rate coffee lands in the cup, as the scale measured it. Temperature is the group temperature, measured at the group head, the sensor closest to the coffee." +
  "Grey vertical lines mark where the profile moved from one step to another. The measurements table names each sample's step." +
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
  // Each Shot's link reads as its time of day and is named by its whole time, in its own Location's time zone.
  await expect.poll(() => times(page)).toEqual([
    "Feb 11, 2026, 9:00 AM CST",
    "Feb 10, 2026, 6:30 AM MST",
    "Feb 10, 2026, 6:00 AM MST",
    "Feb 10, 2026, 6:30 AM CST",
    "Feb 10, 2026, 6:30 AM UTC",
    "Jan 20, 2026, 3:00 PM UTC",
  ]);
  await expect(column(page, 1)).toHaveText([/^9:00 AM/, /^6:30 AM/, /^6:00 AM/, /^6:30 AM/, /^6:30 AM/, /^3:00 PM/]);
  // Under a heading for each day, each Shot's own Location's.
  await expect(page.getByRole("table", { name: "Shots" }).locator("tbody th")).toHaveText(["Wed Feb 11", "Tue Feb 10", "Tue Jan 20"]);
  await expect(page.getByText("Shots 1–6 of 6")).toBeVisible();

  // It was pulled with no Recipe loaded, 0.1 g under its target of 36 g, which is within spec.
  const labRow = row(page, "Feb 10, 2026, 6:30 AM MST");
  await expect(labRow.getByRole("cell")).toHaveText(["6:30 AM", "Lab 1", "No RecipeLondonium · Ethiopia Guji · Lab", "7.5", "18 g", "35.9 g−0.1 g", "23.5 s", "-", "Ann"]);
  // An inferred Machine credit, and the Location it brings, are marked.
  const inferred = row(page, "Feb 11, 2026, 9:00 AM CST");
  await expect(inferred.getByRole("cell").nth(1)).toHaveText("Uptown 1Inferred");
  await expect(inferred.getByRole("cell").nth(2)).toHaveText("No RecipeBlooming · Ethiopia Guji · UptownInferred");
  await expect(row(page, "Feb 10, 2026, 6:30 AM CST").getByText("Inferred")).toHaveCount(0);
  // Without a Location, times are in UTC, and say so.
  await expect(row(page, "Feb 10, 2026, 6:30 AM UTC").getByRole("cell").nth(2)).toHaveText("No RecipeLondonium · Ethiopia Generic 100g Sample · No Location, times in UTC");
  await expect(row(page, "Jan 20, 2026, 3:00 PM UTC").getByRole("cell").nth(1)).toHaveText("Bengle serial 10029Pending Machine");
});

test("filters narrow the list alone and together, with dates read in each Shot's Location's time zone", async ({ page }) => {
  await page.goto("/shots");
  await expect(rows(page)).toHaveCount(6);
  await expectTip(
    page.getByRole("region", { name: "Filters" }),
    "dates and times",
    /^Today, Yesterday, 7 days and 30 days are each Shot's Location's own days, .*Dates and times are read in each Shot's Location's time zone, so 7:00 means 7:00 wherever it was pulled\./,
  );

  await chooseFilter(page, "Location", "Uptown");
  await expect(rows(page)).toHaveCount(2);
  await chooseFilter(page, "Location", "No Location (UTC)");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText("Roaming");
  await chooseFilter(page, "Location", "Any Location");

  // The same Bean across Machines, but not the same name from another roaster.
  await chooseFilter(page, "Bean", "Roux Bakehouse · Ethiopia Guji");
  await expect(rows(page)).toHaveCount(3);
  await expect(column(page, 2)).toHaveText(["Lab 1", "Lab 1", "Uptown 1"]);
  await chooseFilter(page, "Barista", "Cat");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Uptown 1");
  await chooseFilter(page, "Profile", "Londonium");
  await expect(page.getByText("No Shots match these filters.")).toBeVisible();
  await page.getByRole("region", { name: "Filters" }).getByRole("button", { name: "Clear", exact: true }).click();
  await expect(rows(page)).toHaveCount(6);

  // A page past the end, as an old link may name, moves to the last page.
  await page.goto("/shots?offset=25");
  await expect(rows(page)).toHaveCount(6);
  await expect(page).toHaveURL(/\/shots$/);

  // A Pending Machine's Shots can be reviewed before an Admin adopts or dismisses it.
  await chooseFilter(page, "Machine", "Bengle serial 10029");
  await expect(rows(page)).toHaveCount(1);
  await chooseFilter(page, "Machine", "Lab 1");
  await expect(rows(page)).toHaveCount(2);
  await chooseFilter(page, "Machine", "Any Machine");

  // 6:00 to 9:00 on February 10, which is a different moment at each Location: Custom opens the From and To fields.
  await expect(page.getByRole("button", { name: "From", exact: true })).toHaveCount(0);
  await datesPreset(page, "Custom").click();
  await chooseDate(page, "From", 2026, "Feb", 10);
  await page.getByLabel("From time").fill("06:00");
  await chooseDate(page, "To", 2026, "Feb", 10);
  await page.getByLabel("To time").fill("09:00");
  await expect(page).toHaveURL(/from=2026-02-10T06%3A00&to=2026-02-10T09%3A00|from=2026-02-10T06:00&to=2026-02-10T09:00/);
  await expect.poll(() => times(page)).toEqual(["Feb 10, 2026, 6:30 AM MST", "Feb 10, 2026, 6:00 AM MST", "Feb 10, 2026, 6:30 AM CST", "Feb 10, 2026, 6:30 AM UTC"]);
  // Until 6:15 leaves out the Shots pulled at 6:30 by their own Location's clock.
  await page.getByLabel("To time").fill("06:15");
  await expect.poll(() => times(page)).toEqual(["Feb 10, 2026, 6:00 AM MST"]);

  // The filters are in the page's address, so reloading or sharing it keeps them.
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(datesPreset(page, "Custom")).toBeChecked();
  await expect(page.getByRole("button", { name: "From" })).toHaveText("Feb 10, 2026");
});

test("a Shot's page shows its curves and everything recorded, and compares it with the previous Shot on its Machine", async ({ page }) => {
  await page.goto("/shots?machineId=" + (await machineId(page, "Lab 1")));
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole("link", { name: "Feb 10, 2026, 6:30 AM MST" }).click();

  // Pulled with no Recipe loaded, which its title says in the Recipe's place, over its time at its Location.
  await expect(page.getByRole("heading", { name: "No Recipe loaded on Lab 1", level: 1 })).toBeVisible();
  await expect(page.getByText("Feb 10, 2026, 6:30 AM MST · Lab", { exact: true })).toBeVisible();
  const curves = page.getByRole("region", { name: "Curves" });
  for (const name of ["Pressure", "Flow", "Weight", "Weight flow", "Temperature"]) {
    const chart = curves.getByRole("figure", { name, exact: true });
    await expect(chart.locator(".recharts-line")).not.toHaveCount(0);
    await expect(chart).toContainText("This Shot");
  }
  await expect(curves.getByRole("figure", { name: "Pressure" })).toContainText("Target");
  // With no Recipe it has no Reference Shot, so it opens compared with nothing.
  await expect(curves.getByRole("radiogroup", { name: "Compare with" }).getByRole("radio")).toHaveText(["Previous Shot on this Machine", "Nothing"]);
  await expect(curves.getByRole("radio", { name: "Nothing" })).toBeChecked();
  await expect(curves.getByText("Previous Shot", { exact: true })).toHaveCount(0);
  const went = page.getByRole("region", { name: "How it went" });
  await expect(field(went, "Yield")).toHaveText("35.9 g");
  await expect(field(went, "Dose")).toHaveText("18 g");
  await expect(field(went, "Stopped")).toHaveText("At its target weight");
  await expectTip(curves, "Curves", CURVES_TIP);

  // Everything else, once, in Details, closed until opened.
  const details = await openCard(page, "Details");
  await expect(field(details, "Machine, as recorded")).toHaveText("DE1Pro, serial 10021, firmware 1333, flow calibration 1.1");
  await expect(field(details, "Grinder")).toHaveText("DF64 v2 at 7.5");
  await expect(field(details, "Burrs")).toHaveText("SSP MP");
  await expect(field(details, "Barista")).toHaveText("Ann");
  // The scale's last reading in its curves, before the stop, beside the yield Decaid weighed once the flow settled.
  await expect(field(details, "Last weight recorded")).toHaveText("32.5 g at 23.5 s");
  // Beside it, when coffee first reached its cup, its scale reading 25.8 g from 0, 21.45 s into its profile, and its weight flow at that last reading.
  await expect(field(details, "Time to first drip")).toHaveText("21.4 s");
  await expect(field(details, "Flow at the stop")).toHaveText("3.22 g/s");
  await expectTip(
    details,
    "Details",
    "What it was pulled with and what its Machine and scale measured, as recorded on its tablet. A Recipe Slot is the one its Recipe is in now. Times on this page are in Lab's time zone, America/Denver." +
      "The time to first drip is from the start of its profile to when the scale first shows coffee in the cup. The last weight recorded is the scale's last reading in its curves: just before the stop, as Decaid records none after it, or earlier where the scale dropped out. So the yield, which Decaid weighs until the flow settles, less it is roughly what dripped after the stop, unless the yield was edited on the tablet. The flow at the stop is the scale's weight flow at that last reading, the rate coffee was landing in the cup.",
  );

  await curves.getByRole("radio", { name: "Previous Shot on this Machine" }).click();
  for (const name of ["Pressure", "Flow", "Weight", "Weight flow", "Temperature"]) {
    await expect(curves.getByRole("figure", { name, exact: true })).toContainText("Previous Shot");
  }
  // Under the curves, the two Shots side by side.
  const comparison = curves.getByRole("table", { name: "Comparison with the previous Shot" });
  await expect(comparison.getByRole("columnheader")).toHaveText(["", "Duration", "Yield", "Time to first drip", "Peak pressure", "Grind setting"]);
  await expect(comparison.getByRole("row", { name: /^This Shot/ }).getByRole("cell").last()).toHaveText("7.5");
  await expect(comparison.getByRole("row", { name: /^Previous Shot/ }).getByRole("cell").last()).toHaveText("8");

  await comparison.getByRole("link", { name: "Previous Shot" }).click();
  await expect(page.getByText("Feb 10, 2026, 6:00 AM MST · Lab", { exact: true })).toBeVisible();
  // The first Shot on Lab 1 has none before it.
  await expect(page.getByText("There is no earlier Shot on Lab 1 to compare it with.")).toBeVisible();

  // An inferred Shot says so, above how it went.
  await page.goto("/shots");
  await page.getByRole("link", { name: "Feb 11, 2026, 9:00 AM CST" }).click();
  const inferred = page.getByRole("alert").filter({ hasText: "Inferred credit" });
  await expect(inferred).toContainText(
    "This Shot recorded no machine hardware, so it is credited to Uptown 1, whose tablet reported it. Its Location, Uptown, comes from that Machine's Location History, so it is inferred too.",
  );
  expect((await inferred.boundingBox())!.y).toBeLessThan((await went.boundingBox())!.y);
  await expect(field(await openCard(page, "Details"), "Machine, as recorded")).toHaveText("It recorded no machine hardware");

  // One a Pending Machine holds names its hardware, and says what holds it.
  await page.goto("/shots/held-shot");
  await expect(page.getByRole("heading", { name: "No Recipe loaded on Bengle serial 10029", level: 1 })).toBeVisible();
  await expect(page.getByRole("main").getByText("Pending Machine", { exact: true })).toBeVisible();
  await expect(page.getByText("Jan 20, 2026, 3:00 PM UTC · No Location, times in UTC", { exact: true })).toBeVisible();

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

test("a Shot's Preheat is shaded and labelled before 0 s, left out of its duration, and marked in its measurements, with its steps after it", async ({ page }) => {
  // The real Shot with a long Preheat, 7.36 s, and before it on the same Machine the other real Shot, whose
  // Preheat lasted 4.39 s, each changing only its id and recorded hardware, and the other its time.
  const hardware = { model: "DE1Pro", serial: "10027" };
  const preheated = preheatShotFixture();
  const { machine, ...workflow } = preheated.workflow as Record<string, Record<string, unknown>>;
  const shot = { ...preheated, id: "preheat-shot", workflow: { ...workflow, machine: { ...machine, serialNumber: hardware.serial } } };
  // Derived: the same Shot pulled the day after with no scale.
  const unweighed = { ...shot, id: "preheat-no-scale", timestamp: "2026-10-26T12:00:00Z", measurements: (preheated.measurements as object[]).map((sample) => ({ ...sample, scale: null })) };
  await adopt(page, "Preheater", hardware, null, [shot, unweighed, shotAt("preheat-previous", "2026-10-25T12:00:00Z", { hardware })]);

  // With no scale, it shows no last weight, time to first drip or flow at the stop.
  await page.goto("/shots/preheat-no-scale");
  await expect(field(page.getByRole("region", { name: "How it went" }), "Yield")).toHaveText("34.7 g");
  const scaleless = await openCard(page, "Details");
  await expect(field(scaleless, "Peak pressure")).toHaveText(/ bar$/);
  for (const none of ["Last weight recorded", "Time to first drip", "Flow at the stop"]) await expect(field(scaleless, none)).toHaveCount(0);

  await page.goto("/shots/preheat-shot");
  // From the first sample after Preheat, not the 33.2 s since the recording started.
  await expect(field(page, "Duration")).toHaveText("25.8 s");
  // Counted from there too: its first drip, the scale's 0.3 g 6.235 s into its profile in its rise from 0 to 1 g, and its
  // last reading landed at 2.82 g/s.
  const details = await openCard(page, "Details");
  await expect(field(details, "Time to first drip")).toHaveText("6.2 s");
  await expect(field(details, "Last weight recorded")).toHaveText("32.4 g at 25.8 s");
  await expect(field(details, "Flow at the stop")).toHaveText("2.82 g/s");
  const curves = page.getByRole("region", { name: "Curves" });
  for (const name of ["Pressure", "Flow", "Weight", "Weight flow", "Temperature"]) {
    const chart = curves.getByRole("figure", { name, exact: true });
    await expect(chart.locator(".recharts-reference-area")).toHaveCount(1);
    await expect(chart.getByText("Preheat", { exact: true })).toBeVisible();
    // A line at each of the four frame changes its samples show, at 5.0, 6.0, 12.1 and 17.5 s: none at 0 s or in Preheat.
    await expect(chart.locator(".recharts-reference-line")).toHaveCount(4);
  }

  // A tap as iOS Safari makes one opens the Curves card's explanation, and a tap elsewhere closes it.
  await page.mouse.move(0, 0);
  await tap(curves.getByRole("button", { name: "About Curves", exact: true }));
  await expect(page.getByRole("tooltip")).toHaveText(CURVES_TIP);
  await tap(curves.getByRole("heading", { name: "Curves" }));
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  // Compared, both Shots are aligned at 0 s, each with its own Preheat before it: the previous Shot's
  // starts at -4.4 s and its profile ends at 23.5 s, this one's at -7.4 s and 25.8 s.
  await curves.getByRole("radio", { name: "Previous Shot on this Machine" }).click();
  const pressure = curves.getByRole("figure", { name: "Pressure" });
  await expect(pressure).toContainText("Previous Shot");
  // The previous Shot's own step change, at 21.4 s, is not marked.
  for (const name of ["Pressure", "Flow", "Weight", "Weight flow", "Temperature"]) {
    await expect(curves.getByRole("figure", { name, exact: true }).locator(".recharts-reference-line")).toHaveCount(4);
  }
  const plot = pressure.locator('[data-slot="chart"]');
  const tooltip = pressure.locator(".recharts-tooltip-wrapper");
  const box = (await plot.boundingBox())!;
  // The plot starts after the 40-pixel y-axis and runs from -8 to 26 seconds.
  const at = (seconds: number) => ({ x: 40 + ((box.width - 48) * (seconds + 8)) / 34, y: box.height / 3 });
  const cases = [
    [-6, false, undefined],
    [-2, true, undefined],
    [3, true, "Prefill"],
    [14, true, "Pressurize"],
    [22, true, "Extraction"],
    [24.5, false, "Extraction"],
  ] as const;
  for (const [seconds, previous, step] of cases) {
    await plot.hover({ position: at(seconds) });
    await expect(tooltip).toContainText("This Shot");
    if (previous) await expect(tooltip).toContainText("Previous Shot");
    else await expect(tooltip).not.toContainText("Previous Shot");
    // Every time before 0 s is in Preheat, and the tooltip says so; after it, the tooltip names this Shot's step.
    if (seconds < 0) await expect(tooltip).toContainText(/s, Preheat/);
    else await expect(tooltip).not.toContainText("Preheat");
    if (step) await expect(tooltip).toContainText(new RegExp(`\\d s, ${step}This Shot`));
  }

  // Its measurements, in a card of their own, closed until opened.
  const table = (await openCard(page, "Measurements")).getByRole("table", { name: "Measurements" });
  const measurements = table.getByRole("row").filter({ has: page.getByRole("cell") });
  await expect(measurements).toHaveCount(168);
  await expect(measurements.first().getByRole("cell").first()).toHaveText("-7.36 sPreheat");
  await expect(measurements.nth(42).getByRole("cell").first()).toHaveText(/^-0\.\d\d sPreheat$/);
  await expect(measurements.nth(43).getByRole("cell").first()).toHaveText("0.00 s");
  await expect(measurements.filter({ hasText: "Preheat" })).toHaveCount(43);
  // Each sample's step, after the time: none in Preheat.
  await expect(table.getByRole("columnheader").nth(1)).toHaveText("Step");
  for (const [n, step] of [[0, ""], [42, ""], [43, "Prefill"], [67, "Compressing"], [126, "Pressurize"], [127, "Extraction"]] as const) {
    await expect(measurements.nth(n).getByRole("cell").nth(1)).toHaveText(step);
  }
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

  await openCard(page, "Record as sent");
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

  await chooseFilter(page, "Barista", "Cat");
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
  expect(response.status()).toBe(201);
  const { machine, token } = (await response.json()) as { machine: { id: string }; token: string };
  if (locationId) {
    const moved = await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId, effectiveFrom: "2025-01-01T00:00:00Z" } });
    expect(moved.status()).toBe(201);
  }
  SimulatedTablet.load({
    settings: settingsFor({ serverUrl: server.url(), token }),
    api: withShots(derivedDe1Pro(hardware), shots),
    timeScale: 50,
  });
  await expect
    .poll(async () => {
      const listed = await page.request.get(`/api/shots?limit=100`);
      const ids = ((await listed.json()) as { shots: { id: string }[] }).shots.map((shot) => shot.id);
      return shots.every((shot) => ids.includes(String(shot.id)));
    })
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

/** Each listed Shot's whole time, as its link is named, in the list's order. */
function times(page: Page): Promise<(string | null)[]> {
  return column(page, 1)
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("aria-label")));
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
