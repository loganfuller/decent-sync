import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// The Library's Beans and Bean Batches in the management interface.
// Simulated tablets running the built plugin, at two Locations, add beans and
// batches in Decaid as baristas do; each joins the Library at its tablet's
// Location, or, a Bean, becomes the Bean with the same roaster and name, and
// is offered there.
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

test("the Beans list shows each Bean and the Locations offering it, and a Bean's page shows what it is", async ({ page }) => {
  const lab = await createLocation(page, "Roastery lab");
  const uptown = await createLocation(page, "Uptown");
  const labTablet = await tabletAt(page, "Lab group", lab, "15001");
  const uptownTablet = await tabletAt(page, "Uptown group", uptown, "15002");

  await labTablet.addBean({ roaster: "Roux Bakehouse", name: "Guji Hambela", country: "Ethiopia", region: "Guji", variety: ["74110", "74112"], processing: "washed" });
  await uptownTablet.addBean({ roaster: "Sandbox Coffee Roasters", name: "Washed Heirloom", decaf: true, decafProcess: "Swiss Water" });
  await expect.poll(async () => offeredAt(page, "Guji Hambela")).toEqual(["Roastery lab"]);
  // Uptown then enters the lab's coffee too: the same Bean, now offered at both.
  await uptownTablet.addBean({ roaster: " roux bakehouse", name: "GUJI HAMBELA " });
  await expect.poll(async () => offeredAt(page, "Guji Hambela")).toEqual(["Roastery lab", "Uptown"]);
  await expect.poll(async () => offeredAt(page, "Washed Heirloom")).toEqual(["Uptown"]);

  await page.goto("/");
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Beans", level: 1 })).toBeVisible();
  await expect(rows(page.getByRole("table", { name: "Beans" }))).toHaveText([
    ["Guji Hambela", "Roux Bakehouse", "Roastery lab, Uptown", "Roastery lab", ""].join(""),
    ["Washed Heirloom", "Sandbox Coffee Roasters", "Uptown", "Uptown", ""].join(""),
  ]);

  await page.getByRole("link", { name: "Guji Hambela" }).click();
  await expect(page.getByRole("heading", { name: "Guji Hambela", level: 1 })).toBeVisible();
  const library = page.getByLabel("In the Library", { exact: true });
  await expect(field(library, "Offered at")).toHaveText("Roastery lab, Uptown");
  await expect(field(library, "Created at")).toHaveText("Roastery lab");
  const coffee = page.getByLabel("Coffee", { exact: true });
  await expect(field(coffee, "Roaster")).toHaveText("Roux Bakehouse");
  await expect(field(coffee, "Country")).toHaveText("Ethiopia");
  await expect(field(coffee, "Variety")).toHaveText("74110, 74112");
  await expect(field(coffee, "Decaf")).toHaveText("No");
  await expect(field(coffee, "Altitude")).toHaveText("-");

  await page.getByRole("link", { name: "← Beans" }).click();
  await page.getByRole("link", { name: "Washed Heirloom" }).click();
  await expect(field(page.getByLabel("Coffee", { exact: true }), "Decaf")).toHaveText("Yes, Swiss Water");
});

test("the Bean Batches list shows each batch's Locations and its remaining weight at each, and a batch's page shows them with its roast", async ({ page }) => {
  const lab = await createLocation(page, "Batch lab");
  const cafe = await createLocation(page, "Batch cafe");
  const labTablet = await tabletAt(page, "Batch lab group", lab, "15011");
  const travellerTablet = await tabletAt(page, "Batch lab group 2", lab, "15012");
  const cafeTablet = await tabletAt(page, "Batch cafe group", cafe, "15013");

  const guji = await labTablet.addBean({ roaster: "Roux Bakehouse", name: "Batch Guji", country: "Ethiopia" });
  const labBatch = await labTablet.addBatch(guji.id, { roastDate: "2026-10-01", roastLevel: "light", weight: 250, price: 18.5, currency: "USD", notes: "Lab roast" });
  const heirloom = await cafeTablet.addBean({ roaster: "Sandbox Coffee Roasters", name: "Batch Heirloom" });
  await cafeTablet.addBatch(heirloom.id, {});
  await expect.poll(async () => batchAt(page, "Batch Guji")).toEqual([["Batch lab", 250]]);
  await labTablet.editBatch(labBatch.id, { weightRemaining: 180.5 });
  await expect.poll(async () => batchAt(page, "Batch Guji")).toEqual([["Batch lab", 180.5]]);

  // The lab's second group moves to the cafe, its tablet still holding the lab's batch, archived there, which a
  // barista un-archives: the batch is at the cafe too, where no weight was entered yet.
  const traveller = await machineNamed(page, "Batch lab group 2");
  baseExpect((await page.request.post(`/api/machines/${traveller.id}/location-history`, { data: { locationId: cafe.id } })).status()).toBe(201);
  await expect.poll(() => travellerTablet.batches().find((record) => record.roastLevel === "light")?.archived).toBe(true);
  await travellerTablet.editBatch(travellerTablet.batches().find((record) => record.roastLevel === "light")!.id, { archived: false });
  await expect.poll(async () => batchAt(page, "Batch Guji")).toEqual([["Batch cafe", null], ["Batch lab", 180.5]]);
  await expect.poll(async () => batchAt(page, "Batch Heirloom")).toEqual([["Batch cafe", null]]);

  await page.goto("/");
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("navigation", { name: "Library" }).getByRole("link", { name: "Bean Batches" }).click();
  await expect(page.getByRole("heading", { name: "Bean Batches", level: 1 })).toBeVisible();
  await expect(rows(page.getByRole("table", { name: "Bean Batches" }))).toHaveText([
    ["Batch Guji, roasted 2026-10-01", "Roux Bakehouse", "Batch cafe (no weight entered), Batch lab (180.5 g)", "Batch lab", ""].join(""),
    ["Batch Heirloom, no roast date", "Sandbox Coffee Roasters", "Batch cafe (no weight entered)", "Batch cafe", ""].join(""),
  ]);

  await page.getByRole("link", { name: "Batch Guji, roasted 2026-10-01" }).click();
  await expect(page.getByRole("heading", { name: "Batch Guji, roasted 2026-10-01", level: 1 })).toBeVisible();
  const locations = page.getByRole("table", { name: "Locations" });
  await expect(rows(locations).locator("td:nth-child(-n+2)")).toHaveText(["Batch cafe", "no weight entered", "Batch lab", "180.5 g"]);
  const roast = page.getByLabel("Roast", { exact: true });
  await expect(field(roast, "Roasted")).toHaveText("2026-10-01");
  await expect(field(roast, "Roast level")).toHaveText("light");
  await expect(field(roast, "Weight")).toHaveText("250 g");
  await expect(field(roast, "Price")).toHaveText("18.5 USD");
  await expect(field(roast, "Notes")).toHaveText("Lab roast");
  await expect(field(page.getByLabel("In the Library", { exact: true }), "Created at")).toHaveText("Batch lab");

  // Its Bean's page lists its batches.
  await page.getByRole("link", { name: "Batch Guji", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Batch Guji", level: 1 })).toBeVisible();
  await expect(field(page.getByLabel("In the Library", { exact: true }), "Offered at")).toHaveText("Batch cafe, Batch lab");
  await expect(rows(page.getByRole("table", { name: "Batches" }))).toHaveText([
    ["Batch Guji, roasted 2026-10-01", "Batch cafe (no weight entered), Batch lab (180.5 g)"].join(""),
  ]);
});

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
    api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [] },
    timeScale: 50,
  });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}

/** A Machine of that name, through the REST API. */
async function machineNamed(page: Page, name: string): Promise<{ id: string }> {
  const { machines } = (await (await page.request.get("/api/machines")).json()) as { machines: { id: string; name: string }[] };
  return machines.find((machine) => machine.name === name)!;
}

/** Where the Library's batch of the Bean of that name is, by Location name, with its remaining weight there, through the REST API. */
async function batchAt(page: Page, bean: string): Promise<[string, number | null][] | undefined> {
  const { batches } = (await (await page.request.get("/api/bean-batches")).json()) as {
    batches: { bean: { name: string }; locations: { location: { name: string }; remainingWeight: number | null }[] }[];
  };
  return batches.find((batch) => batch.bean.name === bean)?.locations.map((here) => [here.location.name, here.remainingWeight]);
}

/** The Locations offering the Library's Bean of that name, through the REST API. */
async function offeredAt(page: Page, name: string): Promise<string[] | undefined> {
  const { beans } = (await (await page.request.get("/api/beans")).json()) as { beans: { name: string; offeredAt: { name: string }[] }[] };
  return beans.find((bean) => bean.name === name)?.offeredAt.map((location) => location.name);
}

/** A table's rows below its header. */
function rows(table: Locator) {
  return table.getByRole("row").filter({ hasNot: table.page().getByRole("columnheader") });
}

function field(within: Locator, term: string) {
  return within.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}
