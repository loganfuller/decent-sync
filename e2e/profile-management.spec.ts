import { expect as baseExpect, type Page, test } from "@playwright/test";
import { SimulatedTablet, derivedDe1Pro, derivedProfile, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";

// Showing and hiding Profiles at Locations in the management interface,
// which is how a lab Profile is promoted to a cafe, and Archiving and
// deleting them there (ticket #88). A simulated tablet running the built
// plugin at the lab creates each Profile, as Profiles have no REST create;
// what each Location's tablets are written of them is
// server/test/library-profile-management.test.ts's.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
const expect = baseExpect.configure({ timeout: 15_000 });

const tablets: SimulatedTablet[] = [];

test.beforeEach(({ page }) => signInAsAdmin(page));

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("a lab Profile is shown at cafes, and hidden at one of them again", async ({ page }) => {
  const lab = await createLocation(page, "Roastery lab");
  await createLocation(page, "Uptown");
  await createLocation(page, "Belmont");
  const labTablet = await tabletAt(page, "Lab group", lab, "17001");
  const record = await labTablet.addProfile(derivedProfile("Lab Bloom", 8.5));
  const id = String(record.id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(id)}`)).status()).toBe(200);

  await page.goto(`/library/profiles/${encodeURIComponent(id)}`);
  await expect(page.getByRole("heading", { name: "Lab Bloom", level: 1 })).toBeVisible();
  const shownAt = (name: string) => page.getByRole("switch", { name: `Shown at ${name}` });
  await expect(shownAt("Roastery lab")).toBeChecked();
  await expect(shownAt("Uptown")).not.toBeChecked();
  await expect(shownAt("Belmont")).not.toBeChecked();

  await shownAt("Uptown").click();
  await expect(shownAt("Uptown")).toBeChecked();
  await shownAt("Belmont").click();
  await expect(shownAt("Belmont")).toBeChecked();

  await shownAt("Uptown").click();
  await expect(shownAt("Uptown")).not.toBeChecked();
  await expect(shownAt("Belmont")).toBeChecked();
  await expect(shownAt("Roastery lab")).toBeChecked();

  // The list shows where it is shown now.
  await page.goto("/library/profiles");
  const row = page.getByRole("table", { name: "Profiles" }).getByRole("row").filter({ has: page.getByRole("link", { name: "Lab Bloom", exact: true }) });
  await expect(row.getByRole("cell").nth(2)).toHaveText("Belmont, Roastery lab");
});

test("a Profile is Archived, keeping where it was shown, restored, and deleted by an Admin", async ({ page }) => {
  const lab = await createLocation(page, "Archive lab");
  const cafe = await createLocation(page, "Archive cafe");
  const labTablet = await tabletAt(page, "Archive lab group", lab, "17011");
  const record = await labTablet.addProfile(derivedProfile("Retired Bloom", 7.25));
  const id = String(record.id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(id)}`)).status()).toBe(200);
  baseExpect((await page.request.put(`/api/profiles/${encodeURIComponent(id)}/locations/${cafe.id}`, { data: { shown: true } })).status()).toBe(200);

  await page.goto(`/library/profiles/${encodeURIComponent(id)}`);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("heading", { name: "Retired Bloom", level: 1 })).toContainText("Archived");
  await expect(page.getByText(/It is Archived, so it is shown nowhere/)).toBeVisible();
  // Each Location's choice is kept.
  await expect(page.getByRole("switch", { name: "Shown at Archive cafe" })).toBeChecked();

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Shown at Archive cafe" })).toBeChecked();

  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Profiles", level: 1 })).toBeVisible();
  // The heading shows before the list has loaded, so wait for the list, or for its saying there are none.
  await expect(page.getByRole("table", { name: "Profiles" }).or(page.getByText(/^No Profiles yet\./))).toBeVisible();
  await expect(page.getByRole("link", { name: "Retired Bloom", exact: true })).toHaveCount(0);
});

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
