import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// The Library's Beans in the management interface. Simulated tablets running
// the built plugin, at two Locations, add beans in Decaid as baristas do;
// each joins the Library at its tablet's Location, or becomes the Bean with
// the same roaster and name, and is offered there.
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
    api: { ...derivedDe1Pro({ serial }), "/beans": [] },
    timeScale: 50,
  });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  return tablet;
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
