import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import { derivedShot, withShots } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, de1ProOnDecaid087, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { afterDetailsPolls } from "./support/polling.js";

// Deliveries from a Machine's tablet that the server could not store, on the
// Machine's page, as an Admin. A simulated tablet running the built plugin
// sends the test tablet's Shot and one derived from it with a NUL in its
// notes, which PostgreSQL cannot hold (see the fixtures' README); its serial
// is the fixtures' made-up 10001.
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

test("a Shot that cannot be stored is listed on its Machine's page, without what it carried, and the Shots after it are stored", async ({ page }) => {
  const token = await createMachine(page, "Bar 1");
  const unstorable = derivedShot("nul-shot", { annotations: { espressoNotes: "Jammy\u0000, long finish" } });
  const tablet = SimulatedTablet.load({
    settings: settingsFor({ serverUrl: server.url(), token }),
    api: withShots(de1ProOnDecaid087(), [unstorable, derivedShot("bar-shot")]),
  });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);

  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto("/machines");
  await machineRow(page, "Bar 1").getByRole("link", { name: "Bar 1" }).click();
  const setAside = page.getByRole("region", { name: "Deliveries set aside" });
  // Loaded every 30 s, as is all but the Machine's status.
  await afterDetailsPolls(page, () => baseExpect(setAside).toContainText("1 delivery from its tablet could not be stored", { timeout: 2_000 }));
  const rows = setAside.getByRole("table", { name: "Deliveries set aside" }).getByRole("row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).getByRole("cell")).toHaveText([/^\w{3} \d+, \d{4}, /, "Shot", "nul-shot", /^.+ \((?:22P05|22021)\)$/]);
  // Stored after it: the Shot pulled on Oct 4.
  await expect(field(page, "Last Shot")).toHaveText(/^Oct 4, 2026, /);
  baseExpect((await page.request.get("/api/shots/bar-shot")).status()).toBe(200);
  baseExpect((await page.request.get("/api/shots/nul-shot")).status()).toBe(404);
  // Never what it carried.
  baseExpect(await page.content()).not.toContain("Jammy");
});

test("a Machine with nothing set aside lists none", async ({ page }) => {
  await createMachine(page, "Bar 2");
  await page.goto("/machines");
  const read = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/set-aside-deliveries") && response.ok());
  await machineRow(page, "Bar 2").getByRole("link", { name: "Bar 2" }).click();
  await read;
  await expect(page.getByRole("heading", { name: "Bar 2", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Deliveries set aside" })).toHaveCount(0);
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
