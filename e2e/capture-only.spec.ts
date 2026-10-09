import { expect as baseExpect, type Page, test } from "@playwright/test";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";

// A Machine's page shows whether it is a Capture-only Machine, and why: it
// has no Location, or an Admin turned its sharing off, which an Admin does
// there, and turns back on, so it joins its Location again; Staff see why,
// but have no switch. A simulated tablet running the built plugin; hardware
// ids are made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
// Machine pages poll the server every few seconds.
const expect = baseExpect.configure({ timeout: 15_000 });

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };
const sam = { name: "Sam Staff", email: "sam@example.com", password: "staff password 1" };
const tablets: SimulatedTablet[] = [];

test.beforeEach(async ({ page }) => {
  const setup = await page.request.post("/api/setup", { data: admin });
  if (setup.status() === 409) await page.request.post("/api/session", { data: admin });
  else baseExpect(setup.status()).toBe(201);
});

test.afterAll(async () => {
  await Promise.all(tablets.map((tablet) => tablet.unload()));
});

test("a Machine with no Location shows it is capture-only because it has none", async ({ page }) => {
  const machine = await createMachine(page, "Home machine", null);
  await page.goto(`/machines/${machine.id}`);
  await expect(page.getByRole("heading", { name: "Home machine", level: 1 })).toBeVisible();
  await expect(page.getByText("Capture-only", { exact: true }).first()).toBeVisible();
  const sharing = page.getByRole("region", { name: "Sharing" });
  await expect(sharing.getByText("It has no Location.")).toBeVisible();
  await expect(sharing.getByText("An Admin turned its sharing off.")).toHaveCount(0);
  await expect(sharing.getByRole("switch", { name: "Share the Library" })).toBeChecked();
});

test("an Admin turns a Machine's sharing off on its page, making it capture-only, and back on, so it joins its Location again", async ({ page, browser }) => {
  const uptown = await createLocation(page, "Uptown");
  const machine = await createMachine(page, "Uptown group", uptown.id);
  const tablet = await tabletOf(machine.token, "25101");
  await page.goto(`/machines/${machine.id}`);
  const sharing = page.getByRole("region", { name: "Sharing" });
  await expect(sharing.getByText("Shared at Uptown")).toBeVisible();
  await expect(page.getByText("Capture-only", { exact: true })).toHaveCount(0);

  await sharing.getByRole("switch", { name: "Share the Library" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Turn sharing off for Uptown group?" });
  await confirm.getByRole("button", { name: "Turn sharing off" }).click();
  await expect(sharing.getByText("An Admin turned its sharing off.")).toBeVisible();
  await expect(sharing.getByText("It has no Location.")).toHaveCount(0);
  await expect(sharing.getByRole("switch", { name: "Share the Library" })).not.toBeChecked();
  await expect(page.getByText("Capture-only", { exact: true }).first()).toBeVisible();

  // Staff working at Uptown see why, but have no switch.
  const response = await page.request.post("/api/invites", { data: { email: sam.email, role: "staff", locationIds: [uptown.id] } });
  baseExpect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const samsBrowser = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await samsBrowser.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: sam });
    baseExpect(accepted.status()).toBe(201);
    const samsPage = await samsBrowser.newPage();
    await samsPage.goto(`/machines/${machine.id}`);
    const samsSharing = samsPage.getByRole("region", { name: "Sharing" });
    await expect(samsSharing.getByText("An Admin turned its sharing off.")).toBeVisible();
    await expect(samsSharing.getByRole("switch")).toHaveCount(0);
  } finally {
    await samsBrowser.close();
  }

  // A coffee its barista enters meanwhile is captured, but stays out of the Library.
  await tablet.addBean({ roaster: "Roux Bakehouse", name: "Guji Hambela" });
  await expect.poll(async () => (await reported(page, machine.id, "beans"))?.length).toBe(1);
  baseExpect(await beanNames(page)).toEqual([]);

  await sharing.getByRole("switch", { name: "Share the Library" }).click();
  await page.getByRole("alertdialog", { name: "Turn sharing back on for Uptown group?" }).getByRole("button", { name: "Turn sharing on" }).click();
  await expect(sharing.getByText("Shared at Uptown")).toBeVisible();
  await expect(sharing.getByRole("switch", { name: "Share the Library" })).toBeChecked();
  // It joined Uptown, bringing the coffee, which its page lists once read again.
  await expect.poll(async () => beanNames(page)).toEqual(["Guji Hambela"]);
  await page.reload();
  await expect(page.getByRole("table", { name: "Brought to the Library" }).getByRole("link", { name: "Roux Bakehouse Guji Hambela" })).toBeVisible();
});

async function createLocation(page: Page, name: string): Promise<{ id: string; name: string }> {
  const response = await page.request.post("/api/locations", { data: { name, timeZone: "America/Chicago" } });
  baseExpect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string; name: string } }).location;
}

/** A Machine at the Location, or at none, through the REST API, with its token. */
async function createMachine(page: Page, name: string, locationId: string | null): Promise<{ id: string; token: string }> {
  const response = await page.request.post("/api/machines", { data: { name, ...(locationId === null ? {} : { locationId }) } });
  baseExpect(response.status()).toBe(201);
  const { machine, token } = (await response.json()) as { machine: { id: string }; token: string };
  return { id: machine.id, token };
}

/**
 * A tablet connected with the token, polling every 5 s of its time, which runs 50 times faster here. Its Decaid holds
 * no beans, batches or grinders, and only Decaid's bundled Profiles, as a fresh install.
 */
async function tabletOf(token: string, serial: string): Promise<SimulatedTablet> {
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

/** The value of the Machine's collection as its tablet last reported it, through the REST API. */
async function reported(page: Page, machineId: string, name: string): Promise<unknown[] | undefined> {
  const { collection } = (await (await page.request.get(`/api/machines/${machineId}/collections/${name}`)).json()) as { collection: { value: unknown[] } | null };
  return collection?.value;
}

/** The names of the Library's Beans, through the REST API. */
async function beanNames(page: Page): Promise<string[]> {
  const { beans } = (await (await page.request.get("/api/beans")).json()) as { beans: { name: string }[] };
  return beans.map((bean) => bean.name);
}
