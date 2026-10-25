import { expect as baseExpect, type Browser, type Page, test } from "@playwright/test";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { rows } from "./support/locators.js";
import { DETAILS_POLL_MS } from "./support/polling.js";
import { createLocation, createMachine, signInAsAdmin } from "./support/seed.js";

// Settings Edits of a Machine's settings on its page (ticket #224): the
// Settings card's General section's Edit form, for an Admin and for Staff,
// disabled while the Machine is offline, and an edit shown as pending, then
// applied or refused, or not confirmed until a late answer replaces the mark
// (#225), and the Settings Edits card listing each edit, for an Admin and
// for Staff (#226), and the Advanced and Flow calibration sections' forms,
// an Admin's only (#227). A simulated tablet running the built plugin takes the writes as
// Decaid v0.9.0 does; hardware ids are made up.
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

test("an edit whose Tablet's connection drops during its write is shown not confirmed, then applied, answered late", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Lakeview");
  // At real time, so Decaid's write is held for less than its 30 s fetch timeout.
  const tablet = await tabletOf(token, "22501", 1);
  await reported(page, machine.id);
  await page.goto(`/machines/${machine.id}`);

  const general = page.getByRole("region", { name: "General", exact: true });
  await general.getByRole("button", { name: "Edit General" }).click();
  const form = general.getByRole("form", { name: "Edit General" });
  await form.getByLabel("Fan threshold (°C)").fill("40");
  const write = tablet.holdRequests("POST", "/machine/settings");
  await form.getByRole("button", { name: "Save" }).click();
  const status = general.getByRole("status");
  await expect(status).toContainText("Pending");
  await expect.poll(() => write.arrived).toBe(1);

  // The connection drops while Decaid writes: the edit is no longer awaited.
  tablet.dropConnections();
  await expect(status).toContainText("Not confirmed");
  await expect(status).toContainText("Fan threshold: 40 °C. The section shows the values last reported.");
  await status.getByRole("button", { name: "About Not confirmed" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("The Machine didn't answer within a minute, or its connection closed first.");

  // The write finishes, and its answer reaches the server on the Tablet's next connection.
  write.release();
  await expect(status).toContainText("Applied, answered late");
  await expect(status).toContainText("Fan threshold: 40 °C.");
  await expect(general.getByRole("definition").first()).toHaveText("40 °C");
});

test("the Settings Edits card lists each edit newest first, naming accounts to an Admin, and to Staff their own as theirs and others' as the Library's history does", async ({ page, browser }) => {
  const harbour = await createLocation(page, "Harbour");
  const { machine, token } = await createMachine(page, "Harbour bar", harbour.id);
  // At real time, so Decaid's held requests stay within its 30 s fetch timeout and the edits' time left.
  const tablet = await tabletOf(token, "22601", 1);
  await reported(page, machine.id);

  // An Admin's edit, applied.
  const applied = await makeEdit(page, machine.id, { fan: 40 }, { fan: 50 });
  await expect.poll(async () => (await editOf(page, machine.id, applied)).outcome).toBe("applied");
  // Another, whose write is under way as the connection drops: not confirmed, then applied by a late answer.
  const write = tablet.holdRequests("POST", "/machine/settings");
  const late = await makeEdit(page, machine.id, { fan: 30 }, { fan: 40 });
  await expect.poll(() => write.arrived).toBe(1);
  tablet.dropConnections();
  await expect.poll(async () => (await editOf(page, machine.id, late)).outcome).toBe("notConfirmed");
  await online(page, machine.id);
  write.release();
  await expect.poll(async () => (await editOf(page, machine.id, late)).late).toBe(true);
  // And one whose connection drops before its write, which stays not confirmed.
  const state = tablet.holdRequests("GET", "/machine/state");
  const notConfirmed = await makeEdit(page, machine.id, { fan: 35 }, { fan: 30 });
  await expect.poll(() => state.arrived).toBe(1);
  tablet.dropConnections();
  await expect.poll(async () => (await editOf(page, machine.id, notConfirmed)).outcome).toBe("notConfirmed");
  await online(page, machine.id);
  state.release();
  await expect.poll(async () => (await editOf(page, machine.id, notConfirmed)).answeredAt).not.toBeNull();

  await asStaff(page, browser, "pat@example.com", harbour.id, async (patsPage) => {
    // Pat's edit expects a steam purge mode the Machine no longer holds, and is refused as changed since.
    const refused = await makeEdit(patsPage, machine.id, { steamPurgeMode: 0 }, { steamPurgeMode: 1 });
    await expect.poll(async () => (await editOf(patsPage, machine.id, refused)).outcome).toBe("refused");
    await patsPage.goto(`/machines/${machine.id}`);
    const card = patsPage.getByRole("region", { name: "Settings Edits" });
    const edits = rows(card.getByRole("table", { name: "Settings Edits" }));
    await expect(edits).toHaveCount(4);
    // Pat's own edit is theirs; the Admin's are by an account, unnamed, as the Library's history shows Staff.
    await expect(edits.nth(0).getByRole("cell")).toHaveText([
      /\S/,
      "You",
      "General",
      "Steam purge mode: Two Tap Stop to Normal",
      "Not changedIt was changed on the Tablet since the values shown. It holds Steam purge mode: Normal.",
    ]);
    await expect(edits.nth(1).getByRole("cell")).toHaveText([/\S/, "An account", "General", "Fan threshold: 30 °C to 35 °C", "Not confirmed"]);
    await expect(edits.nth(2).getByRole("cell")).toHaveText([/\S/, "An account", "General", "Fan threshold: 40 °C to 30 °C", "Applied, answered late"]);
    await expect(edits.nth(3).getByRole("cell")).toHaveText([/\S/, "An account", "General", "Fan threshold: 50 °C to 40 °C", "Applied"]);
  });

  // An Admin sees Pat's edit by Pat's name, and their own as theirs.
  await page.goto(`/machines/${machine.id}`);
  const edits = rows(page.getByRole("region", { name: "Settings Edits" }).getByRole("table", { name: "Settings Edits" }));
  await expect(edits.locator("td:nth-child(2)")).toHaveText(["Staff", "You", "You", "You"]);
  await expect(edits.locator("td:nth-child(5)")).toHaveText([/^Not changed/, "Not confirmed", "Applied, answered late", "Applied"]);
});

test("the Settings Edits card says so while a Machine has none, and lists an edit made on the page once it is answered", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Pier");
  await tabletOf(token, "22602");
  await reported(page, machine.id);
  await page.goto(`/machines/${machine.id}`);
  const card = page.getByRole("region", { name: "Settings Edits" });
  await expect(card.getByText("None of its settings have been changed here.")).toBeVisible();

  const general = page.getByRole("region", { name: "General", exact: true });
  await general.getByRole("button", { name: "Edit General" }).click();
  await general.getByRole("form", { name: "Edit General" }).getByLabel("Fan threshold (°C)").fill("45");
  await general.getByRole("form", { name: "Edit General" }).getByRole("button", { name: "Save" }).click();
  await expect(general.getByRole("status")).toContainText("Applied");
  // Listed without waiting for the card's next poll.
  await expect(rows(card.getByRole("table", { name: "Settings Edits" })).getByRole("cell")).toHaveText([/\S/, "You", "General", "Fan threshold: 50 °C to 45 °C", "Applied"]);
});

test("an Admin changes a Machine's heater voltage and warmup flow, offered only the two voltages with the restart reminder, and its flow multiplier, which the Machine stores otherwise", async ({ page }) => {
  const roastery = await createLocation(page, "Roastery");
  const { machine, token } = await createMachine(page, "Roastery bar", roastery.id);
  const tablet = await tabletOf(token, "22701");
  await reported(page, machine.id);
  await page.goto(`/machines/${machine.id}`);

  const advanced = page.getByRole("region", { name: "Advanced", exact: true });
  await advanced.getByRole("button", { name: "Edit Advanced" }).click();
  const form = advanced.getByRole("form", { name: "Edit Advanced" });
  const warmup = form.getByLabel("Heater warmup flow (ml/s)");
  await expect(warmup).toHaveValue("2");
  await expect(form.getByLabel("Heater test flow (ml/s)")).toHaveValue("4");
  await expect(form.getByLabel("Idle temperature (°C)")).toHaveValue("99");
  await expect(form.getByLabel("Heater test time-out (s)")).toHaveValue("1");
  await expect(form.getByText("Restart the Machine after changing it for the change to take effect.")).toBeVisible();
  await expect(form.getByRole("combobox", { name: "Refill kit" })).toHaveText("Auto-Detect");
  await expect(form.getByText("Resets when the Machine reconnects. Streamline puts back a value set in its settings page when that page next opens.")).toBeVisible();
  const voltage = form.getByRole("combobox", { name: "Heater voltage" });
  await expect(voltage).toHaveText("110 V");
  await voltage.click();
  await expect(page.getByRole("option")).toHaveText(["110 V", "220 V"]);
  await page.getByRole("option", { name: "220 V" }).click();
  await warmup.fill("2.3");
  await form.getByRole("button", { name: "Save" }).click();
  const status = advanced.getByRole("status");
  await expect(status).toContainText("Applied");
  await expect(status).toContainText("Heater warmup flow: 2.3 ml/s; Heater voltage: 220 V.");
  await expect.poll(async () => ((await tablet.callApi("GET", "/machine/settings/advanced")).body as { heaterVoltage: number }).heaterVoltage).toBe(230);
  // The Machine reads it back in tenths as 2.3000000000000003, which the form opens on its step. Changed again, it is
  // sent expecting the value as reported, not as shown, and the fields left as they opened are not sent.
  await advanced.getByRole("button", { name: "Edit Advanced" }).click();
  await expect(warmup).toHaveValue("2.3");
  await warmup.fill("2.4");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(status).toHaveText("AppliedHeater warmup flow: 2.4 ml/s.");
  // Read back as 2.4000000000000004 and retyped as 2.40, it is no change, and nothing is sent.
  await advanced.getByRole("button", { name: "Edit Advanced" }).click();
  await warmup.fill("2.40");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  baseExpect(tablet.writes.filter((write) => write === "POST /machine/settings/advanced")).toHaveLength(2);

  // A barista sets a voltage Decaid holds as unset (-1), which the form shows as it is rather than as no choice.
  baseExpect((await tablet.callApi("POST", "/machine/settings/advanced", { heaterVoltage: 300 })).status).toBe(202);
  await expect.poll(async () => ((await (await page.request.get(`/api/machines/${machine.id}/collections/advancedSettings`)).json()) as { collection: { value: { heaterVoltage: number } } }).collection.value.heaterVoltage).toBe(-1);
  await page.reload();
  await advanced.getByRole("button", { name: "Edit Advanced" }).click();
  await expect(form.getByRole("combobox", { name: "Heater voltage" })).toHaveText("-1");
  await form.getByRole("button", { name: "Cancel" }).click();

  // Decaid truncates 1.001 to the thousandth below, so the Machine holds 1.
  const calibration = page.getByRole("region", { name: "Flow calibration", exact: true });
  await calibration.getByRole("button", { name: "Edit Flow calibration" }).click();
  const multiplier = calibration.getByRole("form", { name: "Edit Flow calibration" }).getByLabel("Flow multiplier");
  await expect(multiplier).toHaveValue("1.1");
  await multiplier.fill("1.001");
  await calibration.getByRole("button", { name: "Save" }).click();
  await expect(calibration.getByRole("status")).toContainText("Stored otherwise");
  await expect(calibration.getByRole("status")).toContainText("The Machine holds another value than was asked for: Flow multiplier: 1.");
  await expect(calibration.getByRole("definition").first()).toHaveText("1");
  await expect(rows(page.getByRole("region", { name: "Settings Edits" }).getByRole("table", { name: "Settings Edits" })).nth(0).getByRole("cell")).toHaveText([
    /\S/,
    "You",
    "Flow calibration",
    "Flow multiplier: 1.1 to 1.001",
    "Stored otherwiseThe Machine holds another value than was asked for: Flow multiplier: 1.",
  ]);
});

test("Staff at the Machine's Location have no Edit for its advanced settings or flow calibration", async ({ page, browser }) => {
  const mill = await createLocation(page, "Mill");
  const { machine, token } = await createMachine(page, "Mill bar", mill.id);
  await tabletOf(token, "22702");
  await reported(page, machine.id);
  await asStaff(page, browser, "kim@example.com", mill.id, async (kimsPage) => {
    await kimsPage.goto(`/machines/${machine.id}`);
    await expect(kimsPage.getByRole("region", { name: "General", exact: true }).getByRole("button", { name: "Edit General" })).toBeVisible();
    const advanced = kimsPage.getByRole("region", { name: "Advanced", exact: true });
    await expect(advanced.getByText("Heater voltage")).toBeVisible();
    await expect(advanced.getByRole("button", { name: "Edit Advanced" })).toHaveCount(0);
    const calibration = kimsPage.getByRole("region", { name: "Flow calibration", exact: true });
    await expect(calibration.getByText("Flow multiplier")).toBeVisible();
    await expect(calibration.getByRole("button", { name: "Edit Flow calibration" })).toHaveCount(0);
  });
});

/** Makes an edit of the Machine's General settings through the REST API as the page's account, and resolves with its id. */
async function makeEdit(page: Page, machineId: string, fields: Record<string, unknown>, expected: Record<string, unknown>): Promise<string> {
  const response = await page.request.post(`/api/machines/${machineId}/settings-edits`, { data: { collection: "machineSettings", fields, expected } });
  baseExpect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { settingsEdit: { id: string } }).settingsEdit.id;
}

/** One of the Machine's edits, read as the page's account. */
async function editOf(page: Page, machineId: string, id: string): Promise<{ outcome: string | null; late: boolean; answeredAt: string | null }> {
  const { settingsEdit } = (await (await page.request.get(`/api/machines/${machineId}/settings-edits/${id}`)).json()) as {
    settingsEdit: { outcome: string | null; late: boolean; answeredAt: string | null };
  };
  return settingsEdit;
}

/** Resolves once the Machine is online, as its tablet's connection makes it. */
async function online(page: Page, machineId: string): Promise<void> {
  await expect.poll(async () => ((await (await page.request.get(`/api/machines/${machineId}`)).json()) as { machine: { online: boolean } }).machine.online).toBe(true);
}

/** A tablet connected with the token, polling every 5 s of its time, which runs `timeScale` times faster. */
async function tabletOf(token: string, serial: string, timeScale = 50): Promise<SimulatedTablet> {
  const tablet = SimulatedTablet.load({
    settings: { ...settingsFor({ serverUrl: server.url(), token }), PollSeconds: 5 },
    api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [] },
    timeScale,
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
