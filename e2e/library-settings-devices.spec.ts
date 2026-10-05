import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import {
  SimulatedTablet,
  de1ProOnDecaid087,
  settingsFor,
  simulatedDevices,
  simulatedDevicesSwitchedOff,
  simulatedLibrary,
} from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// A Machine's paired devices, settings and library in the management
// interface. A simulated tablet running the built plugin serves the test
// tablet's Decaid API with Decaid's own simulated devices and the library
// recorded with them (see the fixtures' READMEs), or responses derived from
// them by the changes named.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
test.use({ timezoneId: "America/New_York" });
// Machine pages poll the server every few seconds.
const expect = baseExpect.configure({ timeout: 15_000 });

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };
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

test("the Machine page shows paired devices, settings and the library, and follows a machine and scale switched off", async ({ page }) => {
  const token = await createMachine(page, "Bar 2");
  const served = { ...de1ProOnDecaid087(), ...simulatedLibrary(), ...simulatedDevices() };
  // Polls every 5 s of the tablet's time, which runs five times faster here.
  const tablet = SimulatedTablet.load({ settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 }, api: served, timeScale: 5 });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);

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
  // DYE2 has never saved any equipment on this tablet.
  await expect(rows(library).filter({ hasText: /^DYE2 equipment/ })).toHaveText(/^DYE2 equipmentNoneNot available when last read, at /);

  // The machine and the scale are switched off: the last settings read stay, marked as such.
  tablet.machineConnected = false;
  tablet.serve({ ...served, ...simulatedDevicesSwitchedOff() });
  await expect(rows(devices).first()).toHaveText(["Scale", "Mock Scale", "Disconnected", "Not reported", "Not reported"].join(""));
  await expect(machineSettings).toContainText(/Not available when last read, at .+; shown as reported at /);
  await expect(field(machineSettings, "fan")).toHaveText("55");
});

test("a Machine whose tablet has reported nothing says so", async ({ page }) => {
  const token = await createMachine(page, "Spare 2");
  baseExpect(token).toBeTruthy();
  await page.goto("/machines");
  await page.getByRole("link", { name: "Spare 2", exact: true }).click();
  await expect(page.getByRole("region", { name: "Paired devices" })).toContainText("Its tablet has not reported its paired devices yet.");
  const settings = page.getByRole("region", { name: "Settings" });
  for (const name of ["App settings", "Machine settings", "Advanced settings"]) {
    await expect(settings.getByRole("region", { name })).toContainText("Not reported yet");
  }
  await expect(settings.getByRole("region", { name: "Steam, hot water and rinse" })).toContainText("Its tablet has not reported its Workflow yet.");
  await expect(rows(page.getByRole("region", { name: "Library" })).first()).toHaveText("BeansNoneNot reported yet");
});

/** Creates a machine entry through the REST API, returning its token. */
async function createMachine(page: Page, name: string): Promise<string> {
  const response = await page.request.post("/api/machines", { data: { name } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

/** A table's rows below its header. */
function rows(within: Locator) {
  return within.getByRole("table").getByRole("row").filter({ hasNot: within.page().getByRole("columnheader") });
}

function field(within: Locator, term: string) {
  return within.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}
