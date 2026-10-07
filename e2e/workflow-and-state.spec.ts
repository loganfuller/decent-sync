import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import { derivedShot, withShots } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, de1ProOnDecaid087, derivedWorkflow, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { DETAILS_POLL_MS, POLL_MS, afterDetailsPolls } from "./support/polling.js";

// What a Machine is set up to do and what it is doing, in the management
// interface, as an Admin in New York. A simulated tablet running the built
// plugin reports the test tablet's Workflow, Shot and states, or ones derived
// from them (see the fixtures' README); its serial is the fixtures' made-up
// 10001.
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

test("the Machines list and Machine page show the machine state, last Shot and current Workflow, and follow changes", async ({ page }) => {
  const token = await createMachine(page, "Bar 1");
  const tablet = SimulatedTablet.load({
    settings: settingsFor({ serverUrl: server.url(), token }),
    api: withShots(de1ProOnDecaid087(), [derivedShot("bar-shot")]),
  });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  tablet.reportState("espresso", "pouring");

  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto("/machines");
  const row = machineRow(page, "Bar 1");
  await expect(row).toContainText("Espresso: pouring");
  // Pulled at 14:14:10 by the tablet's clock, four hours behind UTC, as is New York's.
  await expect(row).toContainText("Oct 4, 2026, 2:14:10 PM");

  await row.getByRole("link", { name: "Bar 1" }).click();
  await expect(page.getByRole("heading", { name: "Bar 1", level: 1 })).toBeVisible();
  await expect(field(page, "Machine state")).toHaveText(/^Espresso: pouring, since \w{3} \d+, \d{4}/);
  await expect(field(page, "Last Shot")).toHaveText("Oct 4, 2026, 2:14:10 PM");
  const workflow = page.getByRole("region", { name: "Workflow" });
  await expect(workflow).toContainText("What it is set up to pull next, as its tablet reported at");
  const expected: [string, string][] = [
    ["Profile", "Londonium"],
    ["Dose", "18 g"],
    ["Yield", "36 g"],
    ["Bean", "Ethiopia Generic 100g Sample"],
    ["Roaster", "Roux Bakehouse"],
    ["Grinder", "DF64 v2"],
    ["Grind setting", "8"],
    ["Barista", "Fixture Barista"],
    ["Steam", "160 °C, 120 s, 2.5 ml/s"],
    ["Hot water", "65 °C, 100 ml"],
    ["Rinse", "90 °C, 5 s"],
  ];
  for (const [term, value] of expected) await expect(field(workflow, term)).toHaveText(value);

  // A barista dials in, and the shot ends. The page follows the machine state
  // within seconds, and loads the Workflow less often.
  tablet.setWorkflow(derivedWorkflow({ targetYield: 40, grinderSetting: "7.5" }));
  tablet.reportState("idle", "idle");
  await expect(field(page, "Machine state")).toHaveText(/^Idle, since /);
  await afterDetailsPolls(page, () => baseExpect(field(workflow, "Yield")).toHaveText("40 g", { timeout: 2_000 }));
  await expect(field(workflow, "Grind setting")).toHaveText("7.5");
  await page.goto("/machines");
  await expect(machineRow(page, "Bar 1")).toContainText("Idle");
});

test("a Machine whose tablet has reported nothing says so", async ({ page }) => {
  await createMachine(page, "Spare");
  await page.goto("/machines");
  const row = machineRow(page, "Spare");
  await expect(row.getByRole("cell").nth(4)).toHaveText("Not reported");
  await expect(row.getByRole("cell").nth(6)).toHaveText("None");

  await row.getByRole("link", { name: "Spare" }).click();
  await expect(field(page, "Machine state")).toHaveText("Not reported yet");
  await expect(field(page, "Last Shot")).toHaveText("None");
  await expect(page.getByRole("region", { name: "Workflow" })).toContainText("Its tablet has not reported it yet.");
});

test("the Machine page asks for its status every 5 s, and for the rest every 30 s", async ({ page }) => {
  await createMachine(page, "Polled");
  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  const requested: string[] = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  await page.goto("/machines");
  await machineRow(page, "Polled").getByRole("link", { name: "Polled" }).click();
  await expect(page.getByRole("heading", { name: "Polled", level: 1 })).toBeVisible();

  const status = `/api${new URL(page.url()).pathname}`;
  const rest = [
    "/workflow",
    "/paired-devices",
    "/collections",
    "/collections/appSettings",
    "/collections/machineSettings",
    "/collections/advancedSettings",
    "/set-aside-deliveries",
  ].map((path) => `${status}${path}`);
  const times = (path: string) => requested.filter((requestedPath) => requestedPath === path).length;
  const restTimes = () => rest.map(times);
  await expect.poll(restTimes).toEqual(rest.map(() => 1));
  const statusTimes = times(status);

  await page.clock.fastForward(POLL_MS);
  await expect.poll(() => times(status)).toBeGreaterThan(statusTimes);
  baseExpect(restTimes()).toEqual(rest.map(() => 1));

  await page.clock.fastForward(DETAILS_POLL_MS);
  await expect.poll(restTimes).toEqual(rest.map(() => 2));
});

/** Creates a machine entry through the REST API, returning its token. */
async function createMachine(page: Page, name: string): Promise<string> {
  const response = await page.request.post("/api/machines", { data: { name } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

function machineRow(page: Page, name: string) {
  return page
    .getByRole("table", { name: "Machines" })
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
}

function field(within: Page | Locator, term: string) {
  return within.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}
