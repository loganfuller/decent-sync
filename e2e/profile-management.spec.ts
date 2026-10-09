import { expect as baseExpect, type Page, test } from "@playwright/test";
import { SimulatedTablet, derivedDe1Pro, derivedProfile, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// Showing and hiding Profiles at Locations in the management interface,
// which is how a lab Profile is promoted to a cafe, and Archiving and
// deleting them there (ticket #88). Simulated tablets running the built
// plugin, at several Locations, are written what each Location shows.
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

test("showing a lab Profile at a cafe writes it to the cafe's tablets, shown, and hiding it there hides it on them and nowhere else", async ({ page }) => {
  const lab = await createLocation(page, "Roastery lab");
  const uptown = await createLocation(page, "Uptown");
  const belmont = await createLocation(page, "Belmont");
  const labTablet = await tabletAt(page, "Lab group", lab, "17001");
  const uptownTablets = [await tabletAt(page, "Uptown 1", uptown, "17002"), await tabletAt(page, "Uptown 2", uptown, "17003")];
  const belmontTablet = await tabletAt(page, "Belmont 1", belmont, "17004");
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
  for (const tablet of uptownTablets) await expect.poll(() => visibilityOn(tablet, id)).toBe("visible");
  expect(visibilityOn(belmontTablet, id)).toBeUndefined();
  await shownAt("Belmont").click();
  await expect.poll(() => visibilityOn(belmontTablet, id)).toBe("visible");

  await shownAt("Uptown").click();
  await expect(shownAt("Uptown")).not.toBeChecked();
  for (const tablet of uptownTablets) await expect.poll(() => visibilityOn(tablet, id)).toBe("hidden");
  expect(visibilityOn(belmontTablet, id)).toBe("visible");
  expect(visibilityOn(labTablet, id)).toBe("visible");

  // The list shows where it is shown now.
  await page.goto("/library/profiles");
  const row = page.getByRole("table", { name: "Profiles" }).getByRole("row").filter({ has: page.getByRole("link", { name: "Lab Bloom", exact: true }) });
  await expect(row.getByRole("cell").nth(2)).toHaveText("Belmont, Roastery lab");
});

test("Archiving a Profile hides it on every tablet, restoring it shows it again where it was shown, and an Admin deletes one", async ({ page }) => {
  const lab = await createLocation(page, "Archive lab");
  const cafe = await createLocation(page, "Archive cafe");
  const labTablet = await tabletAt(page, "Archive lab group", lab, "17011");
  const cafeTablet = await tabletAt(page, "Archive cafe group", cafe, "17012");
  const record = await labTablet.addProfile(derivedProfile("Retired Bloom", 7.25));
  const id = String(record.id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(id)}`)).status()).toBe(200);
  baseExpect((await page.request.put(`/api/profiles/${encodeURIComponent(id)}/locations/${cafe.id}`, { data: { shown: true } })).status()).toBe(200);
  await expect.poll(() => visibilityOn(cafeTablet, id)).toBe("visible");

  await page.goto(`/library/profiles/${encodeURIComponent(id)}`);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("heading", { name: "Retired Bloom", level: 1 })).toContainText("Archived");
  await expect(page.getByText(/It is Archived, so it is shown nowhere/)).toBeVisible();
  for (const tablet of [labTablet, cafeTablet]) await expect.poll(() => visibilityOn(tablet, id)).toBe("hidden");
  // Each Location's choice is kept.
  await expect(page.getByRole("switch", { name: "Shown at Archive cafe" })).toBeChecked();

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
  for (const tablet of [labTablet, cafeTablet]) await expect.poll(() => visibilityOn(tablet, id)).toBe("visible");

  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Profiles", level: 1 })).toBeVisible();
  for (const tablet of [labTablet, cafeTablet]) await expect.poll(() => visibilityOn(tablet, id)).toBeUndefined();
  baseExpect((await page.request.get(`/api/profiles/${encodeURIComponent(id)}`)).status()).toBe(404);
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

/** The tablet's record of the Profile's visibility, or undefined if it holds none. */
function visibilityOn(tablet: SimulatedTablet, id: string): unknown {
  return tablet.profiles().find((record) => record.id === id)?.visibility;
}
