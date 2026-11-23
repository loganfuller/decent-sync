import { expect, type Locator, test } from "@playwright/test";
import { derivedShot, withShots } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, de1ProOnDecaid093, derivedWorkflow, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { CHECK_MS, DETAILS_POLL_MS, POLL_MS, afterDetailsPolls } from "./support/polling.js";
import { createMachine, signInAsAdmin } from "./support/seed.js";
import { field, machineRow, openMachineTab } from "./support/locators.js";

// What a Machine is set up to do and what it is doing, in the management
// interface, as an Admin in New York. A simulated tablet running the built
// plugin reports the test tablet's Workflow, Shot and states, or ones derived
// from them (see the fixtures' README); its serial is the fixtures' made-up
// 10001.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
test.use({ timezoneId: "America/New_York" });

test.beforeEach(({ page }) => signInAsAdmin(page));

test("the Machines list and Machine page show the machine state, last Shot and current Workflow, and follow changes", async ({ page }) => {
  const { token } = await createMachine(page, "Bar 1");
  const tablet = SimulatedTablet.load({
    settings: settingsFor({ serverUrl: server.url(), token }),
    api: withShots(de1ProOnDecaid093(), [derivedShot("bar-shot")]),
  });
  await tablet.waitForLog(/^Connected to /);
  tablet.reportState("espresso", "pouring");

  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto("/machines");
  const row = machineRow(page, "Bar 1");
  // Named as the Live View names it.
  await expect(row.getByRole("cell").nth(3)).toHaveText("Pulling a shot · Pouring");
  // Pulled at 14:14:10 by the tablet's clock, four hours behind UTC, as is New York's: how long ago, with the time in its tooltip.
  await expectLastShot(row.getByRole("cell").nth(4));

  await row.getByRole("link", { name: "Bar 1" }).click();
  await expect(page.getByRole("heading", { name: "Bar 1", level: 1 })).toBeVisible();
  // In the Live View, as it comes.
  const state = page.getByRole("region", { name: "Live View" }).getByRole("group", { name: "Machine State" });
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });
  tablet.reportState("espresso", "pouring");
  await expect(field(state, "Machine State")).toHaveText("Pulling a shot Pouring");
  // Above the tabs, as its status gives it, with its last Shot; no list repeats it.
  const status = page.getByRole("group", { name: "Status" });
  await expect(status).toContainText("Pulling a shot · Pouring");
  await expect(field(page, "Machine state")).toHaveCount(0);
  await expectLastShot(status);
  const workflow = page.getByRole("region", { name: "Workflow" });
  await workflow.getByRole("button", { name: "About Workflow", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toHaveText(/^What it is set up to pull next, as its tablet reported at /);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const expected: [string, string][] = [
    ["Profile", "Londonium"],
    // Its profile's first step's, as Streamline's Brew tile shows it.
    ["Brew temperature", "89 °C"],
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
  await expect(workflow.locator("dt")).toHaveText(expected.map(([term]) => term));

  // A barista dials in, and the shot ends. The Live View follows the machine
  // state as it comes, and the page loads the Workflow less often.
  tablet.setWorkflow(derivedWorkflow({ targetYield: 40, grinderSetting: "7.5" }));
  tablet.reportState("idle", "idle");
  await expect(field(state, "Machine State")).toHaveText("Idle");
  await afterDetailsPolls(page, () => expect(field(workflow, "Yield")).toHaveText("40 g", { timeout: CHECK_MS }));
  await expect(field(workflow, "Grind setting")).toHaveText("7.5");
  await expect(status).toContainText("Idle");
  // When it was last seen, to the second, is with its hardware.
  await openMachineTab(page, "Setup");
  await expect(field(page.locator('dl[aria-label="Hardware"]'), "Last seen")).toHaveText(/^\w{3} \d+, \d{4}, \d+:\d\d:\d\d [AP]M$/);
  await page.goto("/machines");
  await expect(machineRow(page, "Bar 1").getByRole("cell").nth(3)).toHaveText("Idle");
});

test("a Machine whose tablet has reported nothing says so", async ({ page }) => {
  await createMachine(page, "Spare");
  await page.goto("/machines");
  const row = machineRow(page, "Spare");
  await expect(row.getByRole("cell").nth(2)).toHaveText(/^Offline\s*Never connected$/);
  await expect(row.getByRole("cell").nth(3)).toHaveText("Not reported");
  await expect(row.getByRole("cell").nth(4)).toHaveText("No Shots yet");
  await expect(row.getByRole("cell").nth(5)).toHaveText("None");

  await row.getByRole("link", { name: "Spare" }).click();
  await expect(page.getByRole("region", { name: "Live View" })).toContainText("Offline, never seen.");
  const status = page.getByRole("group", { name: "Status" });
  await expect(status).toContainText("Never connected");
  await expect(status).toContainText("No Shots yet");
  await expect(page.getByRole("region", { name: "Workflow" })).toContainText("Its tablet has not reported it yet.");
});

test("the Machine page asks for its status every 5 s, and for what its open tab shows every 30 s", async ({ page }) => {
  await createMachine(page, "Polled");
  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  const requested: string[] = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  const answered: string[] = [];
  // Once its body has arrived, not just its headers: the page times its next load from when it has read the answer.
  page.on("requestfinished", (request) => answered.push(new URL(request.url()).pathname));
  await page.goto("/machines");
  await machineRow(page, "Polled").getByRole("link", { name: "Polled" }).click();
  await expect(page.getByRole("heading", { name: "Polled", level: 1 })).toBeVisible();

  const status = `/api${new URL(page.url()).pathname}`;
  // What each tab reads, only while it is open; the Settings History is shown closed, reading nothing until opened.
  const tabs: ["Now" | "Activity" | "Settings" | "Setup", string[]][] = [
    ["Now", ["/workflow"].map((path) => `${status}${path}`).concat("/api/shots/summary")],
    ["Activity", ["/use", "/activity"].map((path) => `${status}${path}`)],
    [
      "Settings",
      [
        "/workflow",
        "/paired-devices",
        "/collections/appSettings",
        "/collections/machineSettings",
        "/collections/advancedSettings",
        "/collections/machineCalibration",
        "/collections/sensorCalibration",
      ].map((path) => `${status}${path}`),
    ],
    ["Setup", ["/tablet-versions", "/collections", "/set-aside-deliveries"].map((path) => `${status}${path}`)],
  ];
  const times = (path: string) => requested.filter((requestedPath) => requestedPath === path).length;
  // No two tabs one after the other read the same path, so what the tab before still had on its way counts for neither.
  for (const [tab, rest] of tabs) {
    if (tab !== "Now") {
      requested.length = 0;
      answered.length = 0;
      await openMachineTab(page, tab);
    }
    const restTimes = () => rest.map(times);
    await expect.poll(restTimes, tab).toEqual(rest.map(() => 1));
    // Each load's next is timed from when it was answered, so the clock moves on only once all have been. The page sends
    // more requests at once than the browser keeps open to one server, so some wait for others.
    await expect.poll(() => rest.map((path) => answered.filter((answeredPath) => answeredPath === path).length), tab).toEqual(rest.map(() => 1));
    const statusTimes = times(status);

    await page.clock.fastForward(POLL_MS);
    await expect.poll(() => times(status), tab).toBeGreaterThan(statusTimes);
    expect(restTimes(), tab).toEqual(rest.map(() => 1));

    await page.clock.fastForward(DETAILS_POLL_MS);
    await expect.poll(restTimes, tab).toEqual(rest.map(() => 2));
  }
});

/** That `scope` gives Bar 1's last Shot, pulled on Oct 4, 2026 at 2:14 PM in New York: how long ago, linked to the Shot, the time to the minute in its tooltip. */
async function expectLastShot(scope: Locator) {
  const page = scope.page();
  const time = scope.getByRole("button", { name: /^Oct 4\b/ });
  await expect(scope.getByRole("link", { name: /\d+\.\d s$/ })).toHaveAttribute("href", /^\/shots\//);
  await time.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Oct 4, 2026, 2:14 PM EDT");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
}
