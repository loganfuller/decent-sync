import { COLLECTION_NAMES } from "@decent-sync/protocol";
import { expect as baseExpect, type Locator, test } from "@playwright/test";
import {
  SimulatedTablet,
  de1ProOnDecaid090,
  sensorCalibration,
  settingsFor,
  simulatedDevices,
  simulatedDevicesSwitchedOff,
  simulatedLibrary,
} from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { afterDetailsPolls } from "./support/polling.js";
import { createMachine, signInAsAdmin } from "./support/seed.js";
import { field } from "./support/locators.js";

// A Machine's paired devices, settings and library in the management
// interface. A simulated tablet running the built plugin serves the test
// tablet's Decaid API with Decaid's own simulated devices and the library
// recorded with them (see the fixtures' READMEs), or responses derived from
// them by the changes named.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
test.use({ timezoneId: "America/New_York" });
// Machine pages poll the server every few seconds.
const expect = baseExpect.configure({ timeout: 15_000 });

const tablets: SimulatedTablet[] = [];

test.beforeEach(({ page }) => signInAsAdmin(page));

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("the Machine page shows paired devices, settings and the library, and follows a machine and scale switched off", async ({ page }) => {
  const { machine: { id }, token } = await createMachine(page, "Bar 2");
  // Derived: a flow calibration in thousandths, as the machine keeps it (calFlowEst), and a pressure sensor recalibrated
  // by the least step the machine can hold, a 65536th (signed Q16.16).
  const served = {
    ...de1ProOnDecaid090(),
    ...simulatedLibrary(),
    ...simulatedDevices(),
    "/machine/calibration": { flowMultiplier: 0.596 },
    ...sensorCalibration({ pressure: 1 + 1 / 65536 }),
  };
  // Polls every 5 s of the tablet's time, and reads the machine's own settings every 60 s, which runs fifty times faster here.
  const tablet = SimulatedTablet.load({ settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 }, api: served, timeScale: 50 });
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
  await expect(devices).toContainText("As its tablet reported them at");
  await expect(rows(devices)).toHaveText([
    ["Scale", "Mock Scale", "Connected", "Not reported", "Not reported"],
    ["Sensor", "DebugPort (DecentEspresso)", "Connected", "Not reported", "Not reported"],
    ["Sensor", "SensorBasket (DecentEspresso)", "Connected", "Not reported", "Not reported"],
    ["Machine", "MockDe1", "Connected", "Not reported", "Not reported"],
  ].map((cells) => cells.join("")));
  // Discovered nearby, not paired.
  await expect(devices).not.toContainText("MockBengle");

  const settings = page.getByRole("region", { name: "Settings" });
  const machineSettings = settings.getByRole("region", { name: "Machine settings" });
  await expect(machineSettings).toContainText(/^Machine settingsReported at \w{3} \d+, \d{4}/);
  const expected: [string, string][] = [["fan", "55"], ["usb", "No"], ["steamFlow", "0.8"], ["tankTemp", "20"]];
  for (const [term, value] of expected) {
    await expect(field(machineSettings, term)).toHaveText(value);
  }
  await expect(field(settings.getByRole("region", { name: "Advanced settings" }), "heaterIdleTemp")).toHaveText("98");
  const calibration = settings.getByRole("region", { name: "Flow calibration" });
  await expect(calibration).toContainText(/^Flow calibrationReported at \w{3} \d+, \d{4}/);
  await expect(field(calibration, "flowMultiplier")).toHaveText("0.596");
  // Its pressure sensor's recalibration shows, to five decimal places.
  const sensors = settings.getByRole("region", { name: "Sensor calibration" });
  await expect(sensors).toContainText(/^Sensor calibrationReported at \w{3} \d+, \d{4}/);
  const calibrated: [target: string, current: string, factory: string][] = [["flow", "1", "1"], ["pressure", "1.00002", "1"], ["temperature", "0", "0"]];
  for (const [target, current, factory] of calibrated) {
    const list = sensors.getByLabel(target, { exact: true });
    await expect(field(list, "current")).toHaveText(current);
    await expect(field(list, "factory")).toHaveText(factory);
  }
  const appSettings = settings.getByRole("region", { name: "App settings" });
  await expect(field(appSettings, "gatewayMode")).toHaveText("disabled");
  await expect(field(appSettings, "simulatedDevices")).toHaveText("machine, bengle, scale, sensor");
  const workflowSettings = settings.getByRole("region", { name: "Steam, hot water and rinse" });
  await expect(workflowSettings).toContainText("From its Workflow, as its tablet reported it at");
  await expect(field(workflowSettings.getByLabel("Steam", { exact: true }), "flow")).toHaveText("2.5");
  await expect(field(workflowSettings.getByLabel("Hot water", { exact: true }), "volume")).toHaveText("100");
  await expect(field(workflowSettings.getByLabel("Rinse", { exact: true }), "targetTemperature")).toHaveText("90");

  const library = page.getByRole("region", { name: "Library" });
  await expect(rows(library).filter({ hasText: /^Beans/ })).toHaveText(/^Beans2Reported at /);
  await expect(rows(library).filter({ hasText: /^Profiles/ })).toHaveText(/^Profiles3Reported at /);
  // DYE2 has never saved any equipment on this tablet, which the plugin reports as an empty list, as DYE2 reads it.
  await expect(rows(library).filter({ hasText: /^Tools/ })).toHaveText(/^Tools \(DYE2's equipment\)0Reported at /);
  await expect(library).toContainText("its DYE2 recipes are only recorded");
  await expect(library).not.toContainText("Nothing is sent back to the tablet");

  // The machine and the scale are switched off: the last settings read stay, marked as such, from the page's next load of them.
  tablet.machineConnected = false;
  tablet.serve({ ...served, ...simulatedDevicesSwitchedOff() });
  await afterDetailsPolls(page, async () => {
    await baseExpect(rows(devices).first()).toHaveText(["Scale", "Mock Scale", "Disconnected", "Not reported", "Not reported"].join(""), { timeout: 2_000 });
    await baseExpect(machineSettings).toContainText(/Not available when last read, at .+; shown as reported at /, { timeout: 2_000 });
  });
  await expect(field(machineSettings, "fan")).toHaveText("55");
});

test("a Machine whose tablet has reported nothing says so", async ({ page }) => {
  const { token } = await createMachine(page, "Spare 2");
  baseExpect(token).toBeTruthy();
  await page.goto("/machines");
  await page.getByRole("link", { name: "Spare 2", exact: true }).click();
  await expect(page.getByRole("region", { name: "Paired devices" })).toContainText("Its tablet has not reported its paired devices yet.");
  const settings = page.getByRole("region", { name: "Settings" });
  for (const name of ["App settings", "Machine settings", "Advanced settings", "Flow calibration", "Sensor calibration"]) {
    await expect(settings.getByRole("region", { name })).toContainText("Not reported yet");
  }
  await expect(settings.getByRole("region", { name: "Steam, hot water and rinse" })).toContainText("Its tablet has not reported its Workflow yet.");
  await expect(rows(page.getByRole("region", { name: "Library" })).first()).toHaveText("BeansNoneNot reported yet");
});

/** A table's rows below its header. */
function rows(within: Locator) {
  return within.getByRole("table").getByRole("row").filter({ hasNot: within.page().getByRole("columnheader") });
}
