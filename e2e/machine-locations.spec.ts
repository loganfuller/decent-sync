import { expect as baseExpect, type Page, test } from "@playwright/test";
import { RawConnection, helloWith } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// Machines at Locations, as an Admin whose browser is in Tokyo while the
// Locations are in the US: Location History times are shown and entered in
// each Location's own time zone. Hardware ids are made up.
const server = useFreshServer();
test.use({ timezoneId: "Asia/Tokyo" });
// Machine pages poll the server every few seconds.
const expect = baseExpect.configure({ timeout: 15_000 });

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };

test.beforeEach(async ({ page }) => {
  // The first test sets the server up; later ones sign in. Both sign the page's context in.
  const setup = await page.request.post("/api/setup", { data: admin });
  if (setup.status() === 409) await page.request.post("/api/session", { data: admin });
  else baseExpect(setup.status()).toBe(201);
});

test("a machine entry created at a Location shows it in the Machines list and on its page", async ({ page }) => {
  await createLocation(page, "Lab", "America/Denver");
  await createLocation(page, "Uptown", "America/Chicago");
  await createLocation(page, "Belmont", "America/Chicago");

  await page.goto("/machines");
  const form = page.getByRole("form", { name: "New Machine" });
  await expect(form.getByRole("combobox", { name: "Location" })).toHaveText("No Location");
  await form.getByLabel("Name").fill("Lab 1");
  await form.getByRole("combobox", { name: "Location" }).click();
  await page.getByRole("option", { name: "Lab" }).click();
  await form.getByRole("button", { name: "Create Machine" }).click();
  await expect(page.getByRole("region", { name: "Token for Lab 1" })).toBeVisible();
  await expect(locationCell(page, "Lab 1")).toHaveText("Lab");
  // Ready for the next one, which starts unassigned.
  await expect(form.getByRole("combobox", { name: "Location" })).toHaveText("No Location");
  await form.getByLabel("Name").fill("Spare");
  await form.getByRole("button", { name: "Create Machine" }).click();
  await expect(locationCell(page, "Spare")).toHaveText("No Location");

  await page.getByRole("link", { name: "Lab 1", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lab 1", level: 1 })).toBeVisible();
  await expect(field(page, "Location")).toHaveText("Lab");
  await expect(field(page, "Since")).toContainText(/M[DS]T$/);
  await expect(history(page).getByRole("listitem")).toHaveCount(1);
});

test("moving a Machine between Locations, and correcting when it moved, shows in its Location History", async ({ page }) => {
  await page.goto("/machines");
  await page.getByRole("link", { name: "Lab 1", exact: true }).click();
  const location = page.getByRole("region", { name: "Location" });

  const move = location.getByRole("form", { name: "Move" });
  await move.getByRole("combobox", { name: "Move to" }).click();
  // It is already at the Lab.
  await expect(page.getByRole("option", { name: "Lab" })).toHaveCount(0);
  await page.getByRole("option", { name: "Uptown" }).click();
  await move.getByRole("button", { name: "Move" }).click();

  await expect(field(page, "Location")).toHaveText("Uptown");
  const entries = history(page).getByRole("listitem");
  await expect(entries).toHaveCount(2);
  // Newest first, each in its own Location's time zone.
  await expect(entries.nth(0)).toContainText("Uptown");
  await expect(entries.nth(0)).toContainText(/C[DS]T/);
  await expect(entries.nth(1)).toContainText("Lab");
  await expect(entries.nth(1)).toContainText(/M[DS]T/);

  // It was at the Lab from January, by the Lab's clock.
  await history(page).getByRole("button", { name: "Correct arrival at Lab" }).click();
  const lab = history(page).getByRole("form", { name: "Correct arrival at Lab" });
  await expect(lab).toContainText("America/Denver");
  await lab.getByLabel("Arrived").fill("2026-01-15T08:30");
  await lab.getByRole("button", { name: "Save" }).click();
  await expect(lab).toHaveCount(0);
  await expect(entries.nth(1)).toContainText("From Jan 15, 2026, 8:30 AM MST");

  // And moved to Uptown in February, which cannot come before it reached the Lab.
  await history(page).getByRole("button", { name: "Correct arrival at Uptown" }).click();
  const uptown = history(page).getByRole("form", { name: "Correct arrival at Uptown" });
  await uptown.getByLabel("Arrived").fill("2026-01-01T09:00");
  await uptown.getByRole("button", { name: "Save" }).click();
  await expect(uptown.getByRole("alert")).toHaveText("Choose a time after it arrived at Lab");
  await uptown.getByLabel("Arrived").fill("2026-02-01T09:00");
  await uptown.getByRole("button", { name: "Save" }).click();
  await expect(uptown).toHaveCount(0);
  await expect(entries.nth(0)).toContainText("From Feb 1, 2026, 9:00 AM CST");
  await expect(field(page, "Since")).toHaveText("Feb 1, 2026, 9:00 AM CST");

  // The times were entered in each Location's zone, not the browser's.
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  expect(await storedHistory(page, id)).toEqual([
    ["Lab", "2026-01-15T15:30:00.000Z"],
    ["Uptown", "2026-02-01T15:00:00.000Z"],
  ]);

  await page.reload();
  await expect(field(page, "Location")).toHaveText("Uptown");
  await expect(entries).toHaveCount(2);
});

test("a mistaken move is removed, and an entry's Location corrected without changing its time", async ({ page }) => {
  await page.goto("/machines");
  await page.getByRole("link", { name: "Lab 1", exact: true }).click();
  const move = page.getByRole("region", { name: "Location" }).getByRole("form", { name: "Move" });
  await move.getByRole("combobox", { name: "Move to" }).click();
  await page.getByRole("option", { name: "Belmont" }).click();
  await move.getByRole("button", { name: "Move" }).click();
  const entries = history(page).getByRole("listitem");
  await expect(entries).toHaveCount(3);
  await expect(field(page, "Location")).toHaveText("Belmont");

  // That move was a mistake.
  await entries.filter({ hasText: "Belmont" }).getByRole("button", { name: "Remove" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove Lab 1's arrival at Belmont?" });
  await expect(dialog).toContainText("credited to Uptown, where it was before");
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(entries).toHaveCount(2);
  await expect(field(page, "Location")).toHaveText("Uptown");

  // In February it went to Belmont, not Uptown; when it went stays as it was.
  await history(page).getByRole("button", { name: "Correct arrival at Uptown" }).click();
  const february = history(page).getByRole("form", { name: "Correct arrival at Uptown" });
  await february.getByRole("combobox", { name: "Location" }).click();
  await page.getByRole("option", { name: "Belmont" }).click();
  await february.getByRole("button", { name: "Save" }).click();
  await expect(february).toHaveCount(0);
  await expect(field(page, "Location")).toHaveText("Belmont");
  await expect(entries.nth(0)).toContainText("Belmont");
  await expect(entries.nth(0)).toContainText("From Feb 1, 2026, 9:00 AM CST");

  // And in January it went to Uptown: the time entered stays the same moment, shown in Uptown's time zone.
  await history(page).getByRole("button", { name: "Correct arrival at Lab" }).click();
  const january = history(page).getByRole("form", { name: "Correct arrival at Lab" });
  await expect(january.getByLabel("Arrived")).toHaveValue("2026-01-15T08:30");
  await january.getByRole("combobox", { name: "Location" }).click();
  await page.getByRole("option", { name: "Uptown" }).click();
  await expect(january.getByLabel("Arrived")).toHaveValue("2026-01-15T09:30");
  await expect(january).toContainText("America/Chicago");
  await january.getByRole("button", { name: "Save" }).click();
  await expect(january).toHaveCount(0);
  await expect(entries.nth(1)).toContainText("From Jan 15, 2026, 9:30 AM CST");

  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  expect(await storedHistory(page, id)).toEqual([
    ["Uptown", "2026-01-15T15:30:00.000Z"],
    ["Belmont", "2026-02-01T15:00:00.000Z"],
  ]);
});

test("an unassigned Machine is assigned its first Location", async ({ page }) => {
  await page.goto("/machines");
  await page.getByRole("link", { name: "Spare", exact: true }).click();
  await expect(field(page, "Location")).toHaveText("No Location");
  await expect(history(page)).toHaveCount(0);

  const assign = page.getByRole("form", { name: "Assign" });
  await assign.getByRole("combobox", { name: "Assign to" }).click();
  await page.getByRole("option", { name: "Uptown" }).click();
  await assign.getByRole("button", { name: "Assign" }).click();
  await expect(field(page, "Location")).toHaveText("Uptown");
  await expect(history(page).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("form", { name: "Move" })).toBeVisible();
});

test("a machine entry created for a Pending Machine starts at the Location chosen", async ({ page }) => {
  // Mover's tablet reports its own hardware, then moves onto a machine without an entry.
  const response = await page.request.post("/api/machines", { data: { name: "Mover" } });
  baseExpect(response.status()).toBe(201);
  const { token } = (await response.json()) as { token: string };
  const connections: RawConnection[] = [];
  try {
    for (const serial of ["10101", "10102"]) {
      const raw = await RawConnection.open(server.url());
      connections.push(raw);
      raw.send(helloWith(token, { machine: { model: "DE1Pro", serial }, connectionId: "00:00:5E:00:53:41" }));
      baseExpect(await raw.message(0)).toMatchObject({ type: "welcome" });
    }
  } finally {
    await Promise.all(connections.map((raw) => raw.terminate()));
  }

  await page.goto("/machines");
  const pending = page.getByRole("list", { name: "Pending Machines", exact: true }).getByRole("listitem").filter({ hasText: "DE1Pro serial 10102" });
  await pending.getByRole("button", { name: "Create machine entry" }).click();
  const form = page.getByRole("form", { name: "New machine entry for DE1Pro serial 10102" });
  await form.getByLabel("Name").fill("Lab 2");
  await form.getByRole("combobox", { name: "Location" }).click();
  await page.getByRole("option", { name: "Lab" }).click();
  await form.getByRole("button", { name: "Create Machine" }).click();
  await expect(page.getByRole("region", { name: "Token for Lab 2" })).toBeVisible();
  await expect(locationCell(page, "Lab 2")).toHaveText("Lab");
});

async function createLocation(page: Page, name: string, timeZone: string): Promise<{ id: string }> {
  const response = await page.request.post("/api/locations", { data: { name, timeZone } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string } }).location;
}

/** A Machine's Location History as the REST API stores it: Location names and times. */
async function storedHistory(page: Page, id: string) {
  const { machine } = (await (await page.request.get(`/api/machines/${id}`)).json()) as {
    machine: { locationHistory: { location: { name: string }; effectiveFrom: string }[] };
  };
  return machine.locationHistory.map((entry) => [entry.location.name, entry.effectiveFrom]);
}

function machineRow(page: Page, name: string) {
  return page
    .getByRole("table", { name: "Machines" })
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
}

/** A Machine's Location in the Machines list, the third column. */
function locationCell(page: Page, name: string) {
  return machineRow(page, name).getByRole("cell").nth(2);
}

function history(page: Page) {
  return page.getByRole("list", { name: "Location History" });
}

/** The value of a field on a Machine page, by its term. */
function field(page: Page, term: string) {
  return page.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}

test("a time the clocks repeat keeps its moment when only the Location is corrected, and one they skip is refused", async ({ page }) => {
  const harbor = await createLocation(page, "Harbor", "America/New_York");
  const response = await page.request.post("/api/machines", { data: { name: "Fall back", locationId: harbor.id } });
  baseExpect(response.status()).toBe(201);
  const { machine } = (await response.json()) as { machine: { id: string; locationHistory: { id: string }[] } };
  // The second 1:30 AM of New York's fall-back night, with seconds the form does not show.
  const arrived = await page.request.patch(`/api/machines/${machine.id}/location-history/${machine.locationHistory[0]!.id}`, {
    data: { effectiveFrom: "2025-11-02T06:30:42.123Z" },
  });
  baseExpect(arrived.status()).toBe(200);

  await page.goto(`/machines/${machine.id}`);
  const entries = history(page).getByRole("listitem");
  await expect(entries.nth(0)).toContainText("From Nov 2, 2025, 1:30 AM EST");
  await history(page).getByRole("button", { name: "Correct arrival at Harbor" }).click();
  const harborForm = history(page).getByRole("form", { name: "Correct arrival at Harbor" });
  // A time changed and changed back is still the recorded moment.
  await harborForm.getByLabel("Arrived").fill("2025-11-02T01:31");
  await harborForm.getByLabel("Arrived").fill("2025-11-02T01:30");
  await harborForm.getByRole("combobox", { name: "Location" }).click();
  await page.getByRole("option", { name: "Lab" }).click();
  await harborForm.getByRole("button", { name: "Save" }).click();
  await expect(harborForm).toHaveCount(0);
  await expect(entries.nth(0)).toContainText("Lab");
  expect(await storedHistory(page, machine.id)).toEqual([["Lab", "2025-11-02T06:30:42.123Z"]]);

  // A time entered at the Lab keeps its moment back in New York, where it reads the same as the
  // recorded time: the first 1:30 AM, an hour before the recorded second one.
  await history(page).getByRole("button", { name: "Correct arrival at Lab" }).click();
  const labForm = history(page).getByRole("form", { name: "Correct arrival at Lab" });
  await expect(labForm.getByLabel("Arrived")).toHaveValue("2025-11-02T00:30");
  await labForm.getByLabel("Arrived").fill("2025-11-01T23:30");
  await labForm.getByRole("combobox", { name: "Location" }).click();
  await page.getByRole("option", { name: "Harbor" }).click();
  await expect(labForm.getByLabel("Arrived")).toHaveValue("2025-11-02T01:30");
  await labForm.getByRole("button", { name: "Save" }).click();
  await expect(labForm).toHaveCount(0);
  expect(await storedHistory(page, machine.id)).toEqual([["Harbor", "2025-11-02T05:30:00.000Z"]]);

  // 2:30 AM never happened in New York on the night its clocks went forward.
  await history(page).getByRole("button", { name: "Correct arrival at Harbor" }).click();
  const springForm = history(page).getByRole("form", { name: "Correct arrival at Harbor" });
  await springForm.getByLabel("Arrived").fill("2026-03-08T02:30");
  await springForm.getByRole("button", { name: "Save" }).click();
  await expect(springForm.getByRole("alert")).toContainText("That time does not exist in America/New_York");
  expect(await storedHistory(page, machine.id)).toEqual([["Harbor", "2025-11-02T05:30:00.000Z"]]);
  await springForm.getByLabel("Arrived").fill("2026-03-08T03:30");
  await springForm.getByRole("button", { name: "Save" }).click();
  await expect(springForm).toHaveCount(0);
  expect(await storedHistory(page, machine.id)).toEqual([["Harbor", "2026-03-08T07:30:00.000Z"]]);
});

test("an open correction follows another Admin's change to its entry, and saving sends only what was changed", async ({ page }) => {
  const { locations } = (await (await page.request.get("/api/locations")).json()) as { locations: { id: string; name: string }[] };
  const [uptown, belmont] = ["Uptown", "Belmont"].map((name) => locations.find((location) => location.name === name)!);
  const response = await page.request.post("/api/machines", { data: { name: "Shared", locationId: uptown!.id } });
  baseExpect(response.status()).toBe(201);
  const { machine } = (await response.json()) as { machine: { id: string; locationHistory: { id: string }[] } };
  const entry = `/api/machines/${machine.id}/location-history/${machine.locationHistory[0]!.id}`;
  baseExpect((await page.request.patch(entry, { data: { effectiveFrom: "2026-01-10T15:00:00Z" } })).status()).toBe(200);

  await page.goto(`/machines/${machine.id}`);
  await history(page).getByRole("button", { name: "Correct arrival at Uptown" }).click();
  const form = history(page).getByRole("form");
  await expect(form.getByLabel("Arrived")).toHaveValue("2026-01-10T09:00");

  // Another Admin corrects the entry while the form is open; the page's polling brings it in.
  baseExpect((await page.request.patch(entry, { data: { locationId: belmont!.id, effectiveFrom: "2026-01-12T15:00:00Z" } })).status()).toBe(200);
  await expect(form.getByLabel("Arrived")).toHaveValue("2026-01-12T09:00");
  await expect(form.getByRole("combobox", { name: "Location" })).toHaveText("Belmont");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  expect(await storedHistory(page, machine.id)).toEqual([["Belmont", "2026-01-12T15:00:00.000Z"]]);
});
