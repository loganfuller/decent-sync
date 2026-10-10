import { expect as baseExpect, type Page, test } from "@playwright/test";
import { globalIdOf } from "@decent-sync/protocol";
import { shotFixture } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// Shots linked to the Library (ticket #92): each Library item's page lists
// the Shots that used it, and the Shots list filters by Bean Batch and by
// Grinder. Simulated tablets running the built plugin, at a lab and a cafe
// sharing a batch, each with a Grinder of its own, pull Shots naming them
// by their own ids.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
const expect = baseExpect.configure({ timeout: 15_000 });

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };
const tablets: SimulatedTablet[] = [];

type Record_ = Record<string, unknown>;

test.beforeEach(async ({ page }) => {
  const setup = await page.request.post("/api/setup", { data: admin });
  if (setup.status() === 409) await page.request.post("/api/session", { data: admin });
  else baseExpect(setup.status()).toBe(201);
});

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("a batch's page lists its Shots from both Locations, and the Shots list filters by Bean Batch and by Grinder", async ({ page }) => {
  const lab = await post<{ location: { id: string } }>(page, "/api/locations", { name: "Roastery lab", timeZone: "America/Chicago" });
  const cafe = await post<{ location: { id: string } }>(page, "/api/locations", { name: "Belmont", timeZone: "America/Chicago" });
  const labTablet = await tabletAt(page, "Lab group", lab.location.id, "27001");
  const cafeTablet = await tabletAt(page, "Belmont 1", cafe.location.id, "27002");
  const { bean } = await post<{ bean: { id: string } }>(page, "/api/beans", { content: { roaster: "Roux Bakehouse", name: "Linked Sidra" } });
  const { batch } = await post<{ batch: { id: string } }>(page, "/api/bean-batches", {
    beanId: bean.id,
    content: { roastDate: "2026-10-04" },
    locations: [{ locationId: lab.location.id }, { locationId: cafe.location.id }],
  });
  const labGrinder = (await post<{ grinder: { id: string } }>(page, "/api/grinders", { locationId: lab.location.id, content: { model: "Lab EK43" } })).grinder;
  const cafeGrinder = (await post<{ grinder: { id: string } }>(page, "/api/grinders", { locationId: cafe.location.id, content: { model: "Belmont Mythos" } })).grinder;
  const local = (tablet: SimulatedTablet, grinderId: string) => ({
    beanBatchId: tablet.batches().find((record) => globalIdOf(record) === batch.id)?.id,
    grinderId: tablet.grinders().find((record) => globalIdOf(record) === grinderId)?.id,
  });
  await expect.poll(() => Object.values(local(labTablet, labGrinder.id)).every(Boolean)).toBe(true);
  await expect.poll(() => Object.values(local(cafeTablet, cafeGrinder.id)).every(Boolean)).toBe(true);

  labTablet.pullShot(shotWith("lab-linked", "27001", local(labTablet, labGrinder.id), 80));
  cafeTablet.pullShot(shotWith("cafe-linked", "27002", local(cafeTablet, cafeGrinder.id), 70));
  // A Shot naming a batch the Library lacks stays unlinked, and listed.
  labTablet.pullShot(shotWith("lab-unlinked", "27001", { beanBatchId: "a-batch-the-library-lacks" }, 60));
  await expect.poll(async () => ((await (await page.request.get("/api/shots")).json()) as { total: number }).total).toBe(3);

  await page.goto(`/library/bean-batches/${batch.id}`);
  const shots = page.getByRole("table", { name: "Shots with this Bean Batch" });
  await expect(shots.getByRole("row")).toHaveCount(3);
  await expect(shots.getByRole("row", { name: /Lab group.*Lab EK43 .* 80$/ })).toBeVisible();
  await expect(shots.getByRole("row", { name: /Belmont 1.*Belmont Mythos .* 70$/ })).toBeVisible();

  // Its Shots in the Shots list, filtered by it.
  await page.getByRole("link", { name: "Filter the Shots list by it" }).click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?beanBatchId=${batch.id}$`));
  const list = page.getByRole("table", { name: "Shots" });
  await expect(list.getByRole("row")).toHaveCount(3);
  await expect(page.getByLabel("Bean Batch", { exact: true })).toHaveText("Linked Sidra, roasted 2026-10-04");

  // By Grinder, each Location's own.
  await page.getByLabel("Bean Batch", { exact: true }).click();
  await page.getByRole("option", { name: "Any Bean Batch" }).click();
  await expect(list.getByRole("row")).toHaveCount(4);
  await page.getByLabel("Grinder", { exact: true }).click();
  await page.getByRole("option", { name: "Belmont Mythos, Belmont" }).click();
  await expect(page).toHaveURL(new RegExp(`grinderId=${cafeGrinder.id}`));
  await expect(list.getByRole("row")).toHaveCount(2);
  await expect(list.getByRole("row", { name: /Belmont 1/ })).toBeVisible();

  // Shots linked to no batch.
  await page.getByLabel("Grinder", { exact: true }).click();
  await page.getByRole("option", { name: "Any Grinder" }).click();
  await page.getByLabel("Bean Batch", { exact: true }).click();
  await page.getByRole("option", { name: "Not linked to a Bean Batch" }).click();
  await expect(list.getByRole("row")).toHaveCount(2);
  await list.getByRole("row").nth(1).getByRole("link").first().click();
  await expect(field(page.getByLabel("Shot", { exact: true }), "Bean Batch")).toHaveText("Not in the Library");

  // A linked Shot's page links to what it used.
  await page.goto("/shots/lab-linked");
  await expect(field(page.getByLabel("Shot", { exact: true }), "Grinder")).toHaveText("Lab EK43");
  await page.getByRole("link", { name: "Linked Sidra, roasted 2026-10-04" }).click();
  await expect(page.getByRole("heading", { name: "Linked Sidra, roasted 2026-10-04", level: 1 })).toBeVisible();
});

/** The test tablet's Shot pulled on the Machine of that serial, naming the batch and Grinder by the ids given, rated as given. */
function shotWith(id: string, serial: string, context: Record_, enjoyment: number): Record_ {
  const fixture = shotFixture();
  const workflow = fixture.workflow as Record_;
  return {
    ...fixture,
    id,
    annotations: { ...(fixture.annotations as Record_), enjoyment },
    workflow: {
      ...workflow,
      machine: { ...(workflow.machine as Record_), serialNumber: serial },
      context: { ...(workflow.context as Record_), grinderId: null, ...context },
    },
  };
}

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(path, { data });
  baseExpect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as T;
}

/** A Machine at the Location, its tablet connected, polling every 5 s of its time, which runs 50 times faster here. */
async function tabletAt(page: Page, name: string, locationId: string, serial: string): Promise<SimulatedTablet> {
  const { token } = await post<{ token: string }>(page, "/api/machines", { name, locationId });
  const tablet = SimulatedTablet.load({
    settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 },
    api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] },
    timeScale: 50,
  });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}

function field(within: ReturnType<Page["getByLabel"]>, term: string) {
  return within.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}
