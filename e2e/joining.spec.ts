import { expect as baseExpect, type Locator, type Page, test } from "@playwright/test";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// A Machine joining a Location brings what its tablet holds to the Library
// (ADR-0018), and its page lists it, so an Admin can Archive duplicates.
// Simulated tablets running the built plugin: Uptown's enters a coffee, and
// a Machine with no Location, whose tablet holds a coffee of the same
// roaster and name, another coffee with a batch, and a grinder, is assigned
// Uptown on its page. Hardware ids are made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
// Machine pages poll the server every few seconds.
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

test("a Machine's page lists what its tablet brought to the Library as it joined a Location, each linking to its page", async ({ page }) => {
  const uptown = await createLocation(page, "Uptown");
  const uptownTablet = await tabletOf(page, "Uptown group", uptown.id, "24001");
  await uptownTablet.addBean({ roaster: "Roux Bakehouse", name: "Guji Hambela", notes: "Uptown's notes" });
  await expect.poll(async () => beanNames(page)).toEqual(["Guji Hambela"]);

  // A Machine with no Location: what its barista enters is captured, but not taken into the Library.
  const traveller = await tabletOf(page, "Traveller", null, "24002");
  await traveller.addBean({ roaster: " roux bakehouse", name: "GUJI HAMBELA" });
  const sidamo = await traveller.addBean({ roaster: "Roux Bakehouse", name: "Sidamo Bensa" });
  await traveller.addBatch(sidamo.id, { roastDate: "2026-10-02", weight: 500 });
  await traveller.addGrinder({ model: "Mazzer Philos" });
  const machine = await machineNamed(page, "Traveller");
  await expect.poll(async () => (await reported(page, machine.id, "grinders"))?.length).toBe(1);

  await page.goto(`/machines/${machine.id}`);
  await expect(page.getByRole("heading", { name: "Traveller", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Brought to the Library" })).toHaveCount(0);
  // An unassigned Machine is assigned its first Location.
  const assign = page.getByRole("region", { name: "Location" }).getByRole("form", { name: "Assign" });
  await assign.getByRole("combobox", { name: "Assign to" }).click();
  await page.getByRole("option", { name: "Uptown" }).click();
  await assign.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByRole("region", { name: "Location" }).getByRole("listitem")).toHaveCount(1);
  // What it brought is taken in once its tablet's reports reach Uptown; the page reads it again every 30 s, or on opening.
  await expect.poll(async () => (await broughtCount(page, machine.id))).toBe(4);
  await page.reload();

  const brought = page.getByRole("table", { name: "Brought to the Library" });
  const row = (name: string) => rows(brought).filter({ has: page.getByRole("link", { name, exact: true }) });
  await expect(rows(brought)).toHaveCount(4);
  await expect(row("Roux Bakehouse Guji Hambela").getByRole("cell").nth(1)).toHaveText("Bean");
  await expect(row("Roux Bakehouse Guji Hambela").getByRole("cell").nth(2)).toHaveText("Matched one the Library had");
  await expect(row("Roux Bakehouse Sidamo Bensa").getByRole("cell").nth(2)).toHaveText("Added to the Library");
  await expect(row("Sidamo Bensa, roasted 2026-10-02").getByRole("cell").nth(1)).toHaveText("Bean Batch");
  await expect(row("Mazzer Philos").getByRole("cell").nth(1)).toHaveText("Grinder");
  for (const name of ["Roux Bakehouse Guji Hambela", "Roux Bakehouse Sidamo Bensa", "Sidamo Bensa, roasted 2026-10-02", "Mazzer Philos"]) {
    await expect(row(name).getByRole("cell").nth(3)).toHaveText("Uptown");
  }
  // The coffee it matched is Uptown's Bean, whose page an Admin opens from here.
  await expect.poll(async () => beanNames(page)).toEqual(["Guji Hambela", "Sidamo Bensa"]);
  await row("Roux Bakehouse Guji Hambela").getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Guji Hambela", level: 1 })).toBeVisible();
});

async function createLocation(page: Page, name: string): Promise<{ id: string; name: string }> {
  const response = await page.request.post("/api/locations", { data: { name, timeZone: "America/Chicago" } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string; name: string } }).location;
}

/**
 * A Machine at the Location, or at none, its tablet connected, polling every 5 s of its time, which runs 50 times
 * faster here. Its Decaid holds no beans, batches or grinders, and only Decaid's bundled Profiles, as a fresh install.
 */
async function tabletOf(page: Page, name: string, locationId: string | null, serial: string): Promise<SimulatedTablet> {
  const response = await page.request.post("/api/machines", { data: { name, ...(locationId === null ? {} : { locationId }) } });
  baseExpect(response.status()).toBe(201);
  const { token } = (await response.json()) as { token: string };
  const api = derivedDe1Pro({ serial });
  const tablet = SimulatedTablet.load({
    settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 },
    api: {
      ...api,
      "/beans": [],
      "/bean-batches": [],
      "/grinders": [],
      "/profiles": (api["/profiles"] as Record<string, unknown>[]).filter((profile) => profile.isDefault === true),
    },
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

/** The value of the Machine's collection as its tablet last reported it, through the REST API. */
async function reported(page: Page, machineId: string, name: string): Promise<unknown[] | undefined> {
  const { collection } = (await (await page.request.get(`/api/machines/${machineId}/collections/${name}`)).json()) as { collection: { value: unknown[] } | null };
  return collection?.value;
}

/** How many items the Machine brought to the Library, through the REST API. */
async function broughtCount(page: Page, machineId: string): Promise<number> {
  return ((await (await page.request.get(`/api/machines/${machineId}/brought`)).json()) as { brought: unknown[] }).brought.length;
}

/** The names of the Library's Beans, through the REST API. */
async function beanNames(page: Page): Promise<string[]> {
  const { beans } = (await (await page.request.get("/api/beans")).json()) as { beans: { name: string }[] };
  return beans.map((bean) => bean.name);
}

/** A table's rows below its header. */
function rows(table: Locator) {
  return table.getByRole("row").filter({ hasNot: table.page().getByRole("columnheader") });
}
