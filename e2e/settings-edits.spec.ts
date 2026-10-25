import { expect as baseExpect, type Browser, type Page, test } from "@playwright/test";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { DETAILS_POLL_MS } from "./support/polling.js";
import { createLocation, createMachine, signInAsAdmin } from "./support/seed.js";

// Settings Edits of a Machine's settings on its page (ticket #224): the
// Settings card's General section's Edit form, for an Admin and for Staff,
// disabled while the Machine is offline, and an edit shown as pending, then
// applied or refused. A simulated tablet running the built plugin takes the
// writes as Decaid v0.9.0 does; hardware ids are made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
// Machine pages poll the server every few seconds.
const expect = baseExpect.configure({ timeout: 15_000 });

const tablets: SimulatedTablet[] = [];

test.beforeEach(({ page }) => signInAsAdmin(page));

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("an Admin changes a Machine's fan threshold, shown pending and then applied, and is told why an edit during a Shot was refused", async ({ page }) => {
  const belmont = await createLocation(page, "Belmont");
  const { machine, token } = await createMachine(page, "Belmont left", belmont.id);
  const tablet = await tabletOf(token, "22401");
  await reported(page, machine.id);
  await page.goto(`/machines/${machine.id}`);

  const general = page.getByRole("region", { name: "General", exact: true });
  await expect(general.getByRole("definition").first()).toBeVisible();
  await general.getByRole("button", { name: "Edit General" }).click();
  const form = general.getByRole("form", { name: "Edit General" });
  // The fields an Admin may change, with their notes, and the rest in their place, read-only, what sets each in its tooltip.
  const fan = form.getByLabel("Fan threshold (°C)");
  await expect(fan).toHaveValue("50");
  await expect(form.getByText("Resets when the Machine reconnects. Streamline puts back a value set in its settings page when that page next opens.")).toBeVisible();
  await expect(form.getByRole("combobox", { name: "Steam purge mode" })).toHaveText("Normal");
  const readOnly = form.getByLabel("General, read-only");
  await expect(readOnly.getByRole("term")).toHaveText(["Steam flow", "Hot water flow", "Flush flow", "Flush temperature", "Flush time-out", "Tank temperature", "USB charger"]);
  await readOnly.getByRole("button", { name: "About Steam flow" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Set by the Workflow");

  await fan.fill("40");
  await form.getByRole("button", { name: "Save" }).click();
  const status = general.getByRole("status");
  await expect(status).toContainText("Pending");
  await expect(status).toContainText("Fan threshold: 40 °C. Sent to the Machine, waiting for its answer.");
  await expect(status).toContainText("Applied");
  await expect(status).toContainText("Fan threshold: 40 °C.");
  // Its values come from the latest report, read back after the write.
  await expect(general.getByRole("definition").first()).toHaveText("40 °C");
  baseExpect(tablet.writes.filter((write) => write === "POST /machine/settings")).toHaveLength(1);

  // A Shot is being pulled: the edit is refused with the Machine's state, and nothing is written. The last edit's
  // status stays while the form is open, until another is saved.
  tablet.reportState("espresso", "pouring");
  await general.getByRole("button", { name: "Edit General" }).click();
  await expect(status).toContainText("Applied");
  await form.getByRole("combobox", { name: "Steam purge mode" }).click();
  await page.getByRole("option", { name: "Two Tap Stop" }).click();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(status).toContainText("Not changed");
  await expect(status).toContainText("The Machine was busy (espresso). Edit it again once it is idle.");
  baseExpect(tablet.writes.filter((write) => write === "POST /machine/settings")).toHaveLength(1);
});

test("Staff at the Machine's Location change its steam purge mode, Staff elsewhere have no Edit, and Edit is disabled while the Machine is offline", async ({ page, browser }) => {
  const uptown = await createLocation(page, "Uptown");
  const downtown = await createLocation(page, "Downtown");
  const { machine, token } = await createMachine(page, "Uptown bar", uptown.id);
  const tablet = await tabletOf(token, "22402");
  await reported(page, machine.id);

  await asStaff(page, browser, "sam@example.com", uptown.id, async (samsPage) => {
    await samsPage.goto(`/machines/${machine.id}`);
    const general = samsPage.getByRole("region", { name: "General", exact: true });
    await general.getByRole("button", { name: "Edit General" }).click();
    const form = general.getByRole("form", { name: "Edit General" });
    await expect(form.getByLabel("Fan threshold (°C)")).toHaveValue("50");
    await form.getByRole("combobox", { name: "Steam purge mode" }).click();
    await samsPage.getByRole("option", { name: "Two Tap Stop" }).click();
    await form.getByRole("button", { name: "Save" }).click();
    await expect(general.getByRole("status")).toContainText("Applied");
    await expect(general.getByRole("status")).toContainText("Steam purge mode: Two Tap Stop.");
    await expect.poll(async () => ((await tablet.callApi("GET", "/machine/settings")).body as { steamPurgeMode: number }).steamPurgeMode).toBe(1);
  });
  await asStaff(page, browser, "dee@example.com", downtown.id, async (deesPage) => {
    await deesPage.goto(`/machines/${machine.id}`);
    const general = deesPage.getByRole("region", { name: "General", exact: true });
    await expect(general.getByText("Steam purge mode")).toBeVisible();
    await expect(general.getByRole("button", { name: "Edit General" })).toHaveCount(0);
  });

  // Offline, Edit is disabled, and says why.
  await tablet.unload();
  await page.goto(`/machines/${machine.id}`);
  const general = page.getByRole("region", { name: "General", exact: true });
  await expect(page.getByLabel("Status").getByText("Offline", { exact: true })).toBeVisible();
  await expect(general.getByRole("button", { name: "Edit General" })).toBeDisabled();
  await expect(general.getByText("Settings can be changed only while the Machine is online, and its Tablet connected.")).toBeVisible();
});

test("an edit made over the report the form opened with is refused as changed since, though the page loaded a newer report meanwhile", async ({ page }) => {
  const lab = await createLocation(page, "Lab");
  const { machine, token } = await createMachine(page, "Lab bench", lab.id);
  const tablet = await tabletOf(token, "22403");
  await reported(page, machine.id);
  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto(`/machines/${machine.id}`);
  const general = page.getByRole("region", { name: "General", exact: true });
  await general.getByRole("button", { name: "Edit General" }).click();
  const form = general.getByRole("form", { name: "Edit General" });
  const fan = form.getByLabel("Fan threshold (°C)");
  await expect(fan).toHaveValue("50");
  await fan.fill("40");

  // A barista sets 30 on the Tablet, which the page loads with what its tablet reported while the form is open.
  baseExpect((await tablet.callApi("POST", "/machine/settings", { fan: 30 })).status).toBe(202);
  await expect.poll(async () => (await machineSettings(page, machine.id))?.fan).toBe(30);
  const loaded = page.waitForResponse((response) => response.url().endsWith(`/machines/${machine.id}/collections/machineSettings`));
  await page.clock.fastForward(DETAILS_POLL_MS);
  await loaded;

  // Saved over the report the form opened with, so the barista's change is not overwritten.
  await form.getByRole("button", { name: "Save" }).click();
  const status = general.getByRole("status");
  await expect(status).toContainText("Not changed");
  await expect(status).toContainText("It was changed on the Tablet since the values shown. It holds Fan threshold: 30 °C.");
  baseExpect(((await tablet.callApi("GET", "/machine/settings")).body as { fan: number }).fan).toBe(30);
  baseExpect(tablet.writes.filter((write) => write === "POST /machine/settings")).toHaveLength(0);
});

test("an edit the Machine answered before the server answered its making still shows the values read back", async ({ page }) => {
  const annex = await createLocation(page, "Annex");
  const { machine, token } = await createMachine(page, "Annex bar", annex.id);
  await tabletOf(token, "22404");
  await reported(page, machine.id);
  await page.goto(`/machines/${machine.id}`);
  const general = page.getByRole("region", { name: "General", exact: true });
  await expect(general.getByRole("definition").first()).toHaveText("50 °C");
  await general.getByRole("button", { name: "Edit General" }).click();
  const form = general.getByRole("form", { name: "Edit General" });
  await form.getByLabel("Fan threshold (°C)").fill("40");
  // The server reads the edit back for its answer only once the Machine has answered it, as when the plugin is quick.
  await page.route(`**/api/machines/${machine.id}/settings-edits`, async (route) => {
    const response = await route.fetch();
    const { settingsEdit } = (await response.json()) as { settingsEdit: { id: string } };
    const read = async () => (await (await page.request.get(`/api/machines/${machine.id}/settings-edits/${settingsEdit.id}`)).json()) as { settingsEdit: { outcome: string | null } };
    await expect.poll(async () => (await read()).settingsEdit.outcome).toBe("applied");
    await route.fulfill({ response, json: await read() });
  });
  await form.getByRole("button", { name: "Save" }).click();
  await expect(general.getByRole("status")).toContainText("Applied");
  await expect(general.getByRole("definition").first()).toHaveText("40 °C");
});

/** A tablet connected with the token, polling every 5 s of its time, which runs 50 times faster here. */
async function tabletOf(token: string, serial: string): Promise<SimulatedTablet> {
  const tablet = SimulatedTablet.load({
    settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 },
    api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [] },
    timeScale: 50,
  });
  tablets.push(tablet);
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}

/** Resolves once the server holds the Machine's settings as its tablet reported them, which its page loads on opening. */
async function reported(page: Page, machineId: string): Promise<void> {
  await expect.poll(async () => (await machineSettings(page, machineId)) !== undefined).toBe(true);
}

/** The Machine's settings as the server holds them from its tablet's latest available report, or undefined before one. */
async function machineSettings(page: Page, machineId: string): Promise<Record<string, unknown> | undefined> {
  const { collection } = (await (await page.request.get(`/api/machines/${machineId}/collections/machineSettings`)).json()) as {
    collection: { available: boolean; value: Record<string, unknown> } | null;
  };
  return collection?.available ? collection.value : undefined;
}

/** Runs `work` with a page signed in as a new Staff member working at the Location. */
async function asStaff(page: Page, browser: Browser, email: string, locationId: string, work: (staffPage: Page) => Promise<void>): Promise<void> {
  const response = await page.request.post("/api/invites", { data: { email, role: "staff", locationIds: [locationId] } });
  baseExpect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const context = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await context.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, {
      data: { name: "Staff", email, password: "staff password 1" },
    });
    baseExpect(accepted.status()).toBe(201);
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}
