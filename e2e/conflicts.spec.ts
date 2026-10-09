import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import { globalIdOf } from "@decent-sync/protocol";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// Conflicts and each Library item's history in the management interface
// (ADR-0020). Two simulated tablets running the built plugin at a lab, and
// one at a cafe, hold a Bean; the lab's two edit the same field while
// offline, and the later edit wins everywhere, the earlier kept as a
// Conflict. Using its value makes it current on every tablet that holds the
// Bean; dismissing one changes nothing else.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
const expect = baseExpect.configure({ timeout: 15_000 });

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };
const tablets: SimulatedTablet[] = [];

test.beforeEach(async ({ page }) => {
  const setup = await page.request.post("/api/setup", { data: admin });
  if (setup.status() === 409) await page.request.post("/api/session", { data: admin });
  else baseExpect(setup.status()).toBe(201);
});

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("a Conflict made through two tablets is listed and noted on its item, whose page shows its history, and using its value makes it current on every tablet", async ({
  page,
}) => {
  const { one, two, cafe, beanId } = await sharedBean(page, "Used", "16101");
  await conflictOver(page, beanId, one, two, cafe, { notes: "Peach and jasmine" }, { notes: "Blueberry" });

  await page.goto("/library");
  await page.getByRole("navigation", { name: "Library" }).getByRole("link", { name: "Conflicts" }).click();
  await expect(page.getByRole("heading", { name: "Conflicts", level: 1 })).toBeVisible();
  const row = rows(page.getByRole("table", { name: "Conflicts" })).filter({ hasText: "Roux Used Guji" });
  await expect(row.getByRole("cell").nth(1)).toHaveText("Notes");
  await expect(row.getByRole("cell").nth(2)).toContainText("Peach and jasmine");
  await expect(row.getByRole("cell").nth(2)).toContainText("Used lab 1");
  await expect(row.getByRole("cell").nth(3)).toContainText("Blueberry");
  await expect(row.getByRole("cell").nth(3)).toContainText("Used lab 2");

  // Its Bean's page notes it, and shows its history: joining the Library, then each edit that was kept.
  await row.getByRole("link", { name: "Roux Used Guji" }).click();
  await expect(page.getByRole("heading", { name: "Used Guji", level: 1 })).toBeVisible();
  const open = page.getByRole("region", { name: "Open Conflicts" });
  await expect(rows(open.getByRole("table", { name: "Conflicts" }))).toHaveCount(1);
  const history = rows(page.getByRole("table", { name: "History" }));
  await expect(history).toHaveCount(3);
  await expect(history.nth(0)).toContainText("Used lab 2");
  await expect(history.nth(0)).toContainText("NotesBlueberry");
  await expect(history.nth(2)).toContainText("Used lab 1");
  await expect(history.nth(2)).toContainText("NameUsed Guji");

  await open.getByRole("button", { name: "Use the losing value of Notes" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Use this value" }).click();
  await expect(open).toBeHidden();
  await expect(field(page.getByLabel("Coffee", { exact: true }), "Notes")).toHaveText("Peach and jasmine");
  await expect(history).toHaveCount(4);
  await expect(history.nth(0)).toContainText("You, here");
  await expect(history.nth(0)).toContainText("NotesPeach and jasmine");
  for (const tablet of [one, two, cafe]) await expect.poll(() => heldBean(tablet, beanId)?.notes).toBe("Peach and jasmine");

  await page.goto("/library/conflicts");
  await expect(page.getByText("No open Conflicts.")).toBeVisible();
});

test("dismissing a Conflict closes it and changes nothing else", async ({ page }) => {
  const { one, two, cafe, beanId } = await sharedBean(page, "Dismissed", "16111");
  await conflictOver(page, beanId, one, two, cafe, { country: "Ethiopia" }, { country: "Kenya" });

  await page.goto("/library/conflicts");
  const table = page.getByRole("table", { name: "Conflicts" });
  await expect(rows(table)).toHaveCount(1);
  await table.getByRole("button", { name: "Dismiss the Conflict about Country of Roux Dismissed Guji" }).click();
  await expect(page.getByText("No open Conflicts.")).toBeVisible();

  await page.goto(`/library/beans/${beanId}`);
  await expect(field(page.getByLabel("Coffee", { exact: true }), "Country")).toHaveText("Kenya");
  await expect(page.getByRole("region", { name: "Open Conflicts" })).toBeHidden();
  await expect(rows(page.getByRole("table", { name: "History" }))).toHaveCount(3);
  for (const tablet of [one, two, cafe]) baseExpect(heldBean(tablet, beanId)?.country).toBe("Kenya");
});

/** A lab with two tablets and a cafe with one, each holding the same Bean, entered at both. */
async function sharedBean(page: Page, name: string, serial: string) {
  const lab = await createLocation(page, `${name} lab`);
  const cafeLocation = await createLocation(page, `${name} cafe`);
  const one = await tabletAt(page, `${name} lab 1`, lab, serial);
  const two = await tabletAt(page, `${name} lab 2`, lab, String(Number(serial) + 1));
  const cafe = await tabletAt(page, `${name} cafe 1`, cafeLocation, String(Number(serial) + 2));
  await one.addBean({ roaster: "Roux", name: `${name} Guji` });
  await expect.poll(() => two.beans().find((record) => record.name === `${name} Guji` && globalIdOf(record))).toBeTruthy();
  const beanId = globalIdOf(two.beans().find((record) => record.name === `${name} Guji`)!)!;
  await cafe.addBean({ roaster: "Roux", name: `${name} Guji` });
  await expect.poll(() => globalIdOf(cafe.beans().find((record) => record.name === `${name} Guji`) ?? {})).toBe(beanId);
  return { one, two, cafe, beanId };
}

/**
 * The lab's two tablets, offline, edit the same field of the Bean, the first one first; its edit is taken in, then
 * the second's, made without seeing it, wins everywhere, and the first is kept as a Conflict.
 */
async function conflictOver(page: Page, beanId: string, one: SimulatedTablet, two: SimulatedTablet, cafe: SimulatedTablet, earlier: Record<string, unknown>, later: Record<string, unknown>) {
  one.loseNetwork();
  two.loseNetwork();
  await one.editBean(heldBean(one, beanId)!.id, earlier);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await two.editBean(heldBean(two, beanId)!.id, later);
  one.restoreNetwork();
  await expect.poll(() => heldBean(cafe, beanId)).toMatchObject(earlier);
  two.restoreNetwork();
  for (const tablet of [one, two, cafe]) await expect.poll(() => heldBean(tablet, beanId)).toMatchObject(later);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/beans/${beanId}/conflicts`)).json()) as { conflicts: unknown[] }).conflicts.length)
    .toBe(1);
}

function heldBean(tablet: SimulatedTablet, id: string): Record<string, unknown> | undefined {
  return tablet.beans().find((record) => globalIdOf(record) === id);
}

async function createLocation(page: Page, name: string): Promise<{ id: string; name: string }> {
  const response = await page.request.post("/api/locations", { data: { name, timeZone: "America/Chicago" } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string; name: string } }).location;
}

/** A Machine at the Location, its tablet connected, polling every 5 s of its time, which runs 50 times faster here. */
async function tabletAt(page: Page, name: string, location: { id: string }, serial: string): Promise<SimulatedTablet> {
  const response = await page.request.post("/api/machines", { data: { name, locationId: location.id } });
  baseExpect(response.status()).toBe(201);
  const { token } = (await response.json()) as { token: string };
  const tablet = SimulatedTablet.load({
    settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 },
    api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] },
    timeScale: 50,
  });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}

/** A table's rows below its header. */
function rows(table: Locator) {
  return table.getByRole("row").filter({ hasNot: table.page().getByRole("columnheader") });
}

function field(within: Locator, term: string) {
  return within.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}
