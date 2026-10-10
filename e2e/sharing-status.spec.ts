import { expect as baseExpect, type Page, test } from "@playwright/test";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// A Machine's page shows its sharing status: how many changes are waiting for
// its tablet, the last change it applied, and the writes it refused, with
// Decaid's answer. A simulated tablet running the built plugin, whose Decaid
// refuses one Bean; hardware ids are made up.
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

test("a Machine's page shows the changes waiting for its tablet, the last it applied, and a write it refused, with Decaid's answer", async ({ page }) => {
  const location = await page.request.post("/api/locations", { data: { name: "Uptown", timeZone: "America/Chicago" } });
  baseExpect(location.status()).toBe(201);
  const uptown = ((await location.json()) as { location: { id: string } }).location;
  const created = await page.request.post("/api/machines", { data: { name: "Uptown group", locationId: uptown.id } });
  baseExpect(created.status()).toBe(201);
  const { machine, token } = (await created.json()) as { machine: { id: string }; token: string };
  const tablet = SimulatedTablet.load({
    settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 },
    api: { ...derivedDe1Pro({ serial: "25201" }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] },
    timeScale: 50,
  });
  tablets.push(tablet);
  // Its Decaid refuses one coffee, as one it cannot cast.
  tablet.refuseWrites = ({ method, route, body }) =>
    method === "POST" && route === "/beans" && (body as { name?: unknown }).name === "Refused Blend"
      ? { status: 400, body: { error: "type 'int' is not a subtype of type 'String?' in type cast" } }
      : undefined;
  await tablet.waitForLog(/^Connected to /);

  await offer(page, uptown.id, "Refused Blend");
  await offer(page, uptown.id, "House Blend");
  await expect.poll(() => tablet.beans().map((record) => record.name)).toEqual(["House Blend"]);

  await page.goto(`/machines/${machine.id}`);
  const sharing = page.getByRole("region", { name: "Sharing" });
  await expect(sharing.getByText("None: its tablet is up to date")).toBeVisible();
  await expect(sharing.getByText(/^Bean Batch .* written, /)).toBeVisible();
  const refused = sharing.getByRole("table", { name: "Changes its tablet refused" });
  const row = refused.getByRole("row", { name: /Refused Blend/ });
  await expect(row.getByRole("link", { name: "Bean Roux Refused Blend" })).toBeVisible();
  await expect(row.getByText("400")).toBeVisible();
  await expect(row.getByText(/type 'int' is not a subtype/)).toBeVisible();

  // Offline, what the Location offers meanwhile waits for it, and is written once it connects again.
  tablet.loseNetwork();
  await offer(page, uptown.id, "Seasonal");
  await expect(sharing.getByText("2 changes, written once its tablet connects")).toBeVisible();
  tablet.restoreNetwork();
  await expect(sharing.getByText("None: its tablet is up to date")).toBeVisible();
  baseExpect(tablet.beans().map((record) => record.name).sort()).toEqual(["House Blend", "Seasonal"]);
  // The Bean refused stays refused until it changes again.
  await expect(refused.getByRole("row", { name: /Refused Blend/ })).toBeVisible();
});

/** Offers a new Bean at the Location with a batch there, through the REST API. */
async function offer(page: Page, locationId: string, name: string): Promise<void> {
  const created = await page.request.post("/api/beans", { data: { content: { roaster: "Roux", name } } });
  baseExpect(created.status()).toBe(201);
  const { bean } = (await created.json()) as { bean: { id: string } };
  const batch = await page.request.post("/api/bean-batches", { data: { beanId: bean.id, content: { roastDate: "2026-10-05" }, locations: [{ locationId }] } });
  baseExpect(batch.status()).toBe(201);
}
