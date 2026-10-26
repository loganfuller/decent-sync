import { COLLECTION_NAMES } from "@decent-sync/protocol";
import { expect, type Locator, test } from "@playwright/test";
import {
  SimulatedTablet,
  de1ProOnDecaid090,
  derivedDe1Pro,
  sensorCalibration,
  settingsFor,
  simulatedDevices,
  simulatedDevicesSwitchedOff,
  simulatedLibrary,
  skinsAt,
} from "../server/test/support/simulated-tablet.js";
import { SimulatedDye2, dye2Migrated } from "../server/test/support/simulated-dye2.js";
import { useFreshServer } from "./support/fresh-server.js";
import { afterDetailsPolls } from "./support/polling.js";
import { createMachine, signInAsAdmin } from "./support/seed.js";
import { field } from "./support/locators.js";
import { expectTip, tap } from "./support/tooltips.js";

// A Machine's paired devices, settings and library, and the DYE2 and
// Streamline on its tablet, in the management interface. A simulated tablet running the built plugin serves the test
// tablet's Decaid API with Decaid's own simulated devices and the library
// recorded with them (see the fixtures' READMEs), or responses derived from
// them by the changes named.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
test.use({ timezoneId: "America/New_York" });

const tablets: SimulatedTablet[] = [];

test.beforeEach(({ page }) => signInAsAdmin(page));

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("the Machine page shows paired devices, settings and the library, and follows a machine and scale switched off", async ({ page }) => {
  const { machine: { id }, token } = await createMachine(page, "Bar 2");
  // Derived: a flow calibration in thousandths, as the machine keeps it (calFlowEst), and the test DE1Pro's sensor
  // calibrations (#232), signed Q16.16 values off their fields' steps.
  const served = {
    ...de1ProOnDecaid090(),
    ...simulatedLibrary(),
    ...simulatedDevices(),
    "/machine/calibration": { flowMultiplier: 0.596 },
    ...sensorCalibration({ flow: 1.100006103515625, pressure: 1.293609619140625, temperature: -2.899993896484375 }),
    // And a Tablet Setting no definition covers, as a newer Decaid may report.
    "/settings": { ...(simulatedDevices()["/settings"] as Record<string, unknown>), updateChannel: "beta" },
  };
  // Polls every 5 s of the tablet's time, and reads the machine's own settings every 60 s, which runs fifty times faster here.
  // The tablet is in Toronto in summer.
  const tablet = SimulatedTablet.load({ settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 }, api: served, timeScale: 50, utcOffsetMinutes: -240 });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  // The page loads what the tablet reported every 30 s, so it opens once the server holds all of it.
  const reported = async () => ((await (await page.request.get(`/api/machines/${id}/collections`)).json()) as { collections: unknown[] }).collections;
  await expect.poll(async () => (await reported()).length).toBe(COLLECTION_NAMES.length);

  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto("/machines");
  await page.getByRole("link", { name: "Bar 2", exact: true }).click();
  const devices = page.getByRole("region", { name: "Paired devices" });
  await expectTip(devices, "Paired devices", /^As its tablet reported them at .+\.Devices only discovered nearby are left out\./);
  await expect(rows(devices)).toHaveText([
    ["Scale", "Mock Scale", "Connected", "Not reported", "Not reported"],
    ["Sensor", "DebugPort (DecentEspresso)", "Connected", "Not reported", "Not reported"],
    ["Sensor", "SensorBasket (DecentEspresso)", "Connected", "Not reported", "Not reported"],
    ["Machine", "MockDe1", "Connected", "Not reported", "Not reported"],
  ].map((cells) => cells.join("")));
  // Discovered nearby, not paired.
  await expect(devices).not.toContainText("MockBengle");

  // Each field by its label, with its unit and its choice's label; what sets a read-only one, and the notes, in its tooltip,
  // as is when each section was reported.
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  const machineSettings = settings.getByRole("region", { name: "Machine Settings" });
  const general = machineSettings.getByRole("region", { name: "General", exact: true });
  await expectTip(general, "General", /^Reported at \w{3} \d+, \d{4}/);
  const shown: [term: string, value: string, ...about: string[]][] = [
    // Above the 50 °C an edit may set, and shown as it is.
    ["Fan threshold", "55 °C", RESETS, PUT_BACK],
    ["Steam purge mode", "Normal", PUT_BACK],
    ["Steam flow", "0.8 ml/s", "Set by the Workflow"],
    ["Tank temperature", "20 °C", "Set by each profile"],
    ["USB charger", "Off", "Set by the Tablet's charging mode"],
  ];
  await expectShown(general, shown);
  // A tap as iOS Safari makes one, which neither hovers nor focuses the icon, opens its tooltip, and a tap elsewhere closes it.
  await page.mouse.move(0, 0);
  await tap(general.getByRole("button", { name: "About Fan threshold", exact: true }));
  await expect(page.getByRole("tooltip")).toHaveText(RESETS + PUT_BACK);
  await tap(general.getByRole("heading", { name: "General" }));
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expectShown(machineSettings.getByRole("region", { name: "Advanced", exact: true }), [
    ["Idle temperature", "98 °C", PUT_BACK],
    ["Heater voltage", "110 V", "Restart the Machine after changing it for the change to take effect."],
    ["Refill kit", "Auto-Detect", RESETS, PUT_BACK],
  ]);
  const calibration = machineSettings.getByRole("region", { name: "Flow calibration" });
  await expectTip(calibration, "Flow calibration", /^Reported at \w{3} \d+, \d{4}/);
  await expectShown(calibration, [["Flow multiplier", "0.596"]]);
  // Its sensors' calibrations show rounded to their fields' steps, as Streamline shows them (#272).
  const sensors = machineSettings.getByRole("region", { name: "Sensor calibration" });
  await expectTip(sensors, "Sensor calibration", /^Reported at \w{3} \d+, \d{4}/);
  await expectShown(sensors, [
    ["Flow sensor multiplier", "1.1"],
    ["Pressure sensor multiplier", "1.2936"],
    ["Temperature sensor offset", "-2.9 °C"],
  ]);
  await expect(sensors).not.toContainText("factory");
  const tabletSettings = settings.getByRole("region", { name: "Tablet Settings" });
  await expectTip(tabletSettings, "Tablet Settings", /^Reported at \w{3} \d+, \d{4}/);
  await expectShown(tabletSettings, [
    // A field with nothing to explain has no tooltip.
    ["Gateway mode", "Disabled"],
    ["Charging mode", "Charge to 100%"],
    // In the tablet's own time.
    ["Night mode sleep time", "22:00 (UTC\u22124)"],
    ["Volume flow multiplier", "0.3 s"],
    ["Simulated devices", "machine, bengle, scale, sensor", "For development"],
    ["Default skin", "streamline.js", "Managed with the Tablet's skins"],
    ["Preferred machine", "MockDe1", "Managed with the preferred devices"],
    ["updateChannel", "beta", "Not known to Decent Sync, so shown as Decaid names it, read-only"],
  ]);
  const workflowSettings = settings.getByRole("region", { name: "Steam, hot water and rinse" });
  await expectTip(workflowSettings, "Steam, hot water and rinse", /^From its Workflow, as its tablet reported it at /);
  await expect(field(workflowSettings.getByLabel("Steam", { exact: true }), "flow")).toHaveText("2.5");
  await expect(field(workflowSettings.getByLabel("Hot water", { exact: true }), "volume")).toHaveText("100");
  await expect(field(workflowSettings.getByLabel("Rinse", { exact: true }), "targetTemperature")).toHaveText("90");

  const library = page.getByRole("region", { name: "Library" });
  await expect(rows(library).filter({ hasText: /^Beans/ })).toHaveText(/^Beans2\w{3} \d+, \d{4}/);
  await expect(rows(library).filter({ hasText: /^Profiles/ })).toHaveText(/^Profiles3\w{3} \d+, \d{4}/);
  // DYE2 has never saved any equipment on this tablet, which the plugin reports as an empty list, as DYE2 reads it.
  await expect(rows(library).filter({ hasText: /^Tools/ })).toHaveText(/^Tools \(DYE2's equipment\)0\w{3} \d+, \d{4}/);
  await expectTip(library, "Library", /its DYE2 recipes are only recorded\.$/);

  // The machine and the scale are switched off: the last settings read stay, marked as such, from the page's next load of them.
  tablet.machineConnected = false;
  tablet.serve({ ...served, ...simulatedDevicesSwitchedOff() });
  await afterDetailsPolls(page, async () => {
    await expect(rows(devices).first()).toHaveText(["Scale", "Mock Scale", "Disconnected", "Not reported", "Not reported"].join(""), { timeout: 2_000 });
    await expect(general).toContainText(/Not available when last read, at .+; shown as reported at /, { timeout: 2_000 });
  });
  await expect(field(general, "Fan threshold")).toHaveText(/^55 °C/);
});

test("the Settings card shows a Tablet's presence settings and wake schedules under its Tablet Settings, its times in its own time", async ({ page }) => {
  const { machine: { id }, token } = await createMachine(page, "Bar 4");
  // Derived from Decaid v0.9.0's presence settings as wake schedules were added (settings-writes-v0.9.0/): one on three
  // weekdays keeping the Machine awake for two hours, which it is until 08:30, and one every day that is off.
  const presence = {
    userPresenceEnabled: true,
    sleepTimeoutMinutes: 30,
    keepAwakeUntil: "2026-10-26T08:30:00.000",
    schedules: [
      { id: "0f0e0d0c-0b0a-4908-8706-050403020100", time: "06:30", daysOfWeek: [1, 3, 5], enabled: true, keepAwakeFor: 120 },
      { id: "1f1e1d1c-1b1a-4918-9716-151413121110", time: "21:15", daysOfWeek: [], enabled: false },
    ],
  };
  // Hardware of its own, and in Kolkata, five and a half hours east of UTC, while the page is in New York.
  const served = { ...derivedDe1Pro({ serial: "20004" }), "/presence/settings": presence };
  const tablet = SimulatedTablet.load({ settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 }, api: served, timeScale: 50, utcOffsetMinutes: 330 });
  tablets.push(tablet);
  const reported = async () => ((await (await page.request.get(`/api/machines/${id}/collections/presenceSettings`)).json()) as { collection: unknown }).collection;
  await expect.poll(reported).not.toBeNull();

  await page.goto(`/machines/${id}`);
  const tabletSettings = page.getByRole("region", { name: "Settings", exact: true }).getByRole("region", { name: "Tablet Settings" });
  // Night mode's times, as the tablet keeps them, unmoved into the page's time zone.
  await expectShown(tabletSettings, [
    ["Night mode sleep time", "22:00 (UTC+5:30)"],
    ["Night mode morning time", "07:00 (UTC+5:30)"],
  ]);
  const presenceSettings = tabletSettings.getByRole("region", { name: "Presence", exact: true });
  await expectTip(presenceSettings, "Presence", /^Reported at \w{3} \d+, \d{4}/);
  await expectShown(presenceSettings, [
    ["Presence detection", "On"],
    ["Sleep timeout", "30 min"],
    ["Kept awake until", "Oct 26, 2026, 08:30 (UTC+5:30)", "Set while a wake schedule keeps the Machine awake"],
  ]);
  const schedules = presenceSettings.getByRole("table", { name: "Wake schedules" });
  // An Admin may change them (settings-edits.spec.ts): each schedule has Edit and Delete, and an Add button follows.
  await expect(schedules.getByRole("columnheader")).toHaveText(["Time", "Days", "On", "Keeps awake for", "Actions"]);
  await expect(rows(presenceSettings)).toHaveText([
    ["06:30 (UTC+5:30)", "Mon, Wed, Fri", "On", "120 min", ""],
    ["21:15 (UTC+5:30)", "Every day", "Off", "None", ""],
  ].map((cells) => cells.join("")));
  await expect(presenceSettings.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
});

test("the Versions card shows the DYE2 and Streamline on the tablet, follows their changes, and keeps them while the Machine is offline", async ({ page }) => {
  const { machine: { id }, token } = await createMachine(page, "Bar 3");
  const dye2 = new SimulatedDye2();
  // Hardware of its own, as Bar 2's tablet holds the test tablet's.
  const served = { ...derivedDe1Pro({ serial: "20003" }), ...dye2Migrated() };
  const tablet = SimulatedTablet.load({ settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 }, api: served, dye2, timeScale: 50 });
  tablets.push(tablet);
  // What the server holds from the tablet, which the page loads every 30 s.
  const reported = async () =>
    ((await (await page.request.get(`/api/machines/${id}/tablet-versions`)).json()) as { tabletVersions: Record<string, { status: string; loaded?: boolean; branch?: string }> })
      .tabletVersions;
  await tablet.waitForLog(/^Connected to /);
  await expect.poll(async () => (await reported()).streamline!.status).toBe("active");

  await page.clock.install();
  await page.goto(`/machines/${id}`);
  await expectTip(page.getByRole("main"), "Versions", "As last reported by its Tablet.");
  await expect(page.getByText("As reported by the latest accepted connection.")).toHaveCount(0);
  // DYE2's release, and Streamline's release served, though its build of main is the default, as on the test tablet.
  await expect(field(page, "DYE2")).toHaveText("0.1.26");
  await expect(field(page, "Streamline")).toHaveText("0.2.18 (release)");

  // DYE2 is disabled, and Decaid serves another Skin, as Quick Settings can.
  dye2.disable();
  tablet.serve({ ...served, ...skinsAt("servedOther") });
  await expect.poll(async () => (await reported()).streamline!.status).toBe("notActive");
  await expect.poll(async () => (await reported()).dye2!.loaded).toBe(false);
  await afterDetailsPolls(page, async () => {
    await expect(field(page, "DYE2")).toHaveText("0.1.26 (not loaded)", { timeout: 2_000 });
    await expect(field(page, "Streamline")).toHaveText("Not the active skin (Passione 0.9.6)", { timeout: 2_000 });
  });

  // DYE2 is installed from its dist branch and Decaid serves Streamline's build of main, both builds of main, and the
  // Machine then goes offline.
  await dye2.install("branch");
  tablet.serve({ ...served, ...skinsAt("servedMain") });
  await expect.poll(async () => (await reported()).dye2!.branch).toBe("dist");
  await expect.poll(async () => (await reported()).streamline).toMatchObject({ status: "active", build: "main" });
  await tablet.unload();
  await afterDetailsPolls(page, async () => {
    await expect(field(page, "Status")).toHaveText("Offline", { timeout: 2_000 });
    await expect(field(page, "DYE2")).toHaveText("0.1.26 (branch dist)", { timeout: 2_000 });
  });
  await expect(field(page, "Streamline")).toHaveText("0.2.18 (main build)");
});

test("a Machine whose tablet has reported nothing says so", async ({ page }) => {
  const { token } = await createMachine(page, "Spare 2");
  expect(token).toBeTruthy();
  await page.goto("/machines");
  await page.getByRole("link", { name: "Spare 2", exact: true }).click();
  await expect(page.getByRole("region", { name: "Paired devices" })).toContainText("Its tablet has not reported its paired devices yet.");
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  for (const name of ["General", "Advanced", "Flow calibration", "Sensor calibration", "Tablet Settings", "Presence"]) {
    await expect(settings.getByRole("region", { name, exact: true })).toContainText("Not reported yet");
  }
  await expect(settings.getByRole("region", { name: "Steam, hot water and rinse" })).toContainText("Its tablet has not reported its Workflow yet.");
  await expect(rows(page.getByRole("region", { name: "Library" })).first()).toHaveText("BeansNoneNot reported yet");
  await expect(field(page, "DYE2")).toHaveText("Not reported");
  await expect(field(page, "Streamline")).toHaveText("Not reported");
});

const RESETS = "Resets when the Machine reconnects.";
const PUT_BACK = "Streamline puts back a value set in its settings page when that page next opens.";

/** That each field is shown by its label with its value, and its tooltip has each line saying what sets it or noting what may become of it, or that it has none. */
async function expectShown(scope: Locator, shown: [term: string, value: string, ...about: string[]][]) {
  for (const [term, value, ...about] of shown) {
    await expect(field(scope, term)).toHaveText(value);
    if (about.length > 0) await expectTip(scope, term, about.join(""));
    else await expect(scope.getByRole("button", { name: `About ${term}`, exact: true })).toHaveCount(0);
  }
}

/** A table's rows below its header. */
function rows(within: Locator) {
  return within.getByRole("table").getByRole("row").filter({ hasNot: within.page().getByRole("columnheader") });
}
