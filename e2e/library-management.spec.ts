import { expect as baseExpect, type Page, test } from "@playwright/test";
import { globalIdOf } from "@decent-sync/protocol";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// Creating and editing the Library's Beans and Bean Batches in the
// management interface, and adding and finishing batches at Locations
// there (ticket #87). Simulated tablets running the built plugin, at several
// Locations, are written what each Location offers.
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

test("a batch created here at a Location is written, with its Bean, to that Location's tablets and no others", async ({ page }) => {
  const uptown = await createLocation(page, "Uptown");
  const downtown = await createLocation(page, "Downtown");
  const uptownTablets = [await tabletAt(page, "Uptown 1", uptown, "16001"), await tabletAt(page, "Uptown 2", uptown, "16002")];
  const downtownTablet = await tabletAt(page, "Downtown 1", downtown, "16003");

  await page.goto("/library/beans");
  await page.getByRole("button", { name: "New Bean" }).click();
  const newBean = page.getByRole("dialog", { name: "New Bean" });
  await newBean.getByLabel("Roaster", { exact: true }).fill("Roux Bakehouse");
  await newBean.getByLabel("Name", { exact: true }).fill("Uptown Gesha");
  await newBean.getByLabel("Country", { exact: true }).fill("Panama");
  await newBean.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Uptown Gesha", level: 1 })).toBeVisible();
  await expect(field(page.getByLabel("In the Library", { exact: true }), "Offered at")).toHaveText("Nowhere");

  await page.getByRole("button", { name: "New batch" }).click();
  const newBatch = page.getByRole("dialog", { name: "New batch of Uptown Gesha" });
  await newBatch.getByLabel("Roast date", { exact: true }).fill("2026-10-03");
  await newBatch.getByLabel("Weight (g)", { exact: true }).fill("1000");
  await newBatch.getByLabel("Uptown", { exact: true }).check();
  await newBatch.getByLabel("Remaining weight at Uptown (g)").fill("850");
  await newBatch.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Uptown Gesha, roasted 2026-10-03", level: 1 })).toBeVisible();
  const batchId = page.url().split("/").pop()!;

  for (const tablet of uptownTablets) {
    await expect.poll(() => tablet.beans().find((record) => record.name === "Uptown Gesha")).toMatchObject({ roaster: "Roux Bakehouse", country: "Panama" });
    await expect.poll(() => tablet.batches().find((record) => globalIdOf(record) === batchId)).toMatchObject({ weight: 1000, weightRemaining: 850, archived: false });
  }
  expect(downtownTablet.beans()).toEqual([]);
  expect(downtownTablet.batches()).toEqual([]);
  const where = page.getByRole("table", { name: "Locations" });
  await expect(where.getByRole("row", { name: /^Uptown 850 g/ })).toBeVisible();
  await expect(where.getByLabel("Remaining weight at Uptown (g)")).toHaveValue("850");

  // Its Bean, edited here, is written to every tablet that holds it.
  await page.getByRole("link", { name: "Uptown Gesha" }).click();
  await page.getByRole("button", { name: "Edit the coffee" }).click();
  const coffee = page.getByRole("form", { name: "Edit the coffee" });
  await coffee.getByLabel("Notes", { exact: true }).fill("Jasmine, bergamot");
  await coffee.getByRole("button", { name: "Save" }).click();
  await expect(field(page.getByLabel("Coffee", { exact: true }), "Notes")).toHaveText("Jasmine, bergamot");
  for (const tablet of uptownTablets) await expect.poll(() => tablet.beans().find((record) => record.name === "Uptown Gesha")?.notes).toBe("Jasmine, bergamot");
});

test("adding a lab batch at a cafe writes it, and its Bean, to the cafe's tablets, and finishing it there archives it on them", async ({ page }) => {
  const lab = await createLocation(page, "Roastery lab");
  const belmont = await createLocation(page, "Belmont");
  const labTablet = await tabletAt(page, "Lab group", lab, "16011");
  const belmontTablets = [await tabletAt(page, "Belmont 1", belmont, "16012"), await tabletAt(page, "Belmont 2", belmont, "16013")];
  const bean = await labTablet.addBean({ roaster: "Roux Bakehouse", name: "Lab Sidra" });
  await labTablet.addBatch(bean.id, { roastDate: "2026-10-04", weight: 250 });
  await expect.poll(async () => (await batchesOf(page, "Lab Sidra")).length).toBe(1);

  await page.goto("/library/bean-batches");
  await page.getByRole("link", { name: "Lab Sidra, roasted 2026-10-04" }).click();
  const adding = page.getByRole("form", { name: "Add it at a Location" });
  await adding.getByLabel("Add it at").click();
  await page.getByRole("option", { name: "Belmont" }).click();
  await adding.getByRole("button", { name: "Add" }).click();
  const where = page.getByRole("table", { name: "Locations" });
  await expect(where.getByRole("row", { name: /^Belmont no weight entered/ })).toBeVisible();
  const batchId = page.url().split("/").pop()!;
  for (const tablet of belmontTablets) {
    await expect.poll(() => tablet.beans().find((record) => record.name === "Lab Sidra")).toMatchObject({ archived: false });
    await expect.poll(() => tablet.batches().find((record) => globalIdOf(record) === batchId)).toMatchObject({ archived: false });
  }

  await where.getByLabel("Remaining weight at Belmont (g)").fill("200");
  await where.getByRole("button", { name: "Set the remaining weight at Belmont" }).click();
  for (const tablet of belmontTablets) await expect.poll(() => tablet.batches().find((record) => globalIdOf(record) === batchId)?.weightRemaining).toBe(200);

  await where.getByRole("button", { name: "Finish it at Belmont" }).click();
  await expect(field(page.getByLabel("Finished", { exact: true }), "Belmont")).toContainText("with 200 g");
  await expect(where.getByRole("row", { name: /^Belmont/ })).toHaveCount(0);
  for (const tablet of belmontTablets) await expect.poll(() => tablet.batches().find((record) => globalIdOf(record) === batchId)?.archived).toBe(true);
  // The lab still has it.
  expect(labTablet.batches().find((record) => globalIdOf(record) === batchId)).toMatchObject({ archived: false });
});

test("creating a Bean whose roaster and name the Library has is refused, with a link to that Bean", async ({ page }) => {
  const created = await page.request.post("/api/beans", { data: { content: { roaster: "Sandbox Coffee Roasters", name: "Washed Heirloom" } } });
  baseExpect(created.status()).toBe(201);

  await page.goto("/library/beans");
  await page.getByRole("button", { name: "New Bean" }).click();
  const newBean = page.getByRole("dialog", { name: "New Bean" });
  await newBean.getByLabel("Roaster", { exact: true }).fill("sandbox coffee roasters");
  await newBean.getByLabel("Name", { exact: true }).fill(" WASHED HEIRLOOM ");
  await newBean.getByRole("button", { name: "Create" }).click();
  await expect(newBean.getByRole("alert")).toContainText("The Library has this Bean already");
  await newBean.getByRole("link", { name: "Washed Heirloom" }).click();
  await expect(page.getByRole("heading", { name: "Washed Heirloom", level: 1 })).toBeVisible();
  const { beans } = (await (await page.request.get("/api/beans")).json()) as { beans: { name: string }[] };
  expect(beans.filter((bean) => bean.name.toLowerCase().includes("heirloom"))).toHaveLength(1);
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
    api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] },
    timeScale: 50,
  });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}

/** The Library's batches of the Bean of that name, through the REST API. */
async function batchesOf(page: Page, bean: string): Promise<{ id: string }[]> {
  const { batches } = (await (await page.request.get("/api/bean-batches")).json()) as { batches: { id: string; bean: { name: string } }[] };
  return batches.filter((batch) => batch.bean.name === bean);
}

function field(within: ReturnType<Page["getByLabel"]>, term: string) {
  return within.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}
