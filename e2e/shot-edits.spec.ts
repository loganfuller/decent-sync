import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { derivedShot, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { ASSISTANT_ENV, type TestApp, authorizationUrl, pkce, serveTestApp } from "../server/test/support/test-app.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field, openCard, rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// A Shot's rating and note on its page (#514, ADR-0031): edited there by an
// Admin, and by Staff for a Shot at a Location they work at; the page saying
// that an edit awaits its tablet until the tablet has it; and its card of
// the edits made through the server, closed until opened, with who made
// each, the Connected App one was made through, and one dropped for a later
// change on the tablet marked so. A Viewer and Staff elsewhere read all of
// it and have no control. Simulated tablets running the built plugin hold
// Shots derived from a scrubbed real record, changing only their id, time,
// recorded hardware, rating and note, and carry out Decaid's own Shot
// update. The Connected App is a loopback test app. Serials are made up,
// from 51451.
const server = useFreshServer({ env: { ...ASSISTANT_ENV, SYNC_HEARTBEAT_SECONDS: "1" } });

const SHOT = "belmont-espresso";
const LAB_SHOT = "lab-espresso";

/** Belmont's tablet, which the first test loads and the later ones use. */
let belmontTablet: SimulatedTablet;
let app: TestApp;
test.beforeAll(async () => {
  app = await serveTestApp("Test Assistant");
});
test.afterAll(async () => {
  await app?.close();
});
test.beforeEach(({ page }) => signInAsAdmin(page));

test("an Admin rates a Shot and edits its note on its page, which says the edit awaits its tablet until the tablet has it", async ({ page }) => {
  const belmont = await createLocation(page, "Belmont");
  const lab = await createLocation(page, "Lab", "America/Denver");
  belmontTablet = await adopt(page, "Belmont 1", "51451", belmont.id, shotAt(SHOT, "2026-11-10T15:00:00Z", "51451", { enjoyment: 4, espressoNotes: "Sour at first" }));
  await adopt(page, "Lab 1", "51452", lab.id, shotAt(LAB_SHOT, "2026-11-10T16:00:00Z", "51452", {}));

  await page.goto(`/shots/${SHOT}`);
  const card = page.getByRole("region", { name: "Rating and note", exact: true });
  await expect(field(card, "Rating")).toHaveText("4");
  await expect(field(card, "Note")).toHaveText("Sour at first");
  await expectTip(card, "Rating and note", /^How the Shot was judged\. The rating runs from 1 to 10: DYE2 on a tablet shows it as five stars, two points a star\./);
  const standing = card.getByRole("status", { name: "Edits and the tablet" });
  await expect(standing).toHaveCount(0);
  // Its Annotations leave the two to this card.
  const annotations = page.getByRole("region", { name: "Annotations" });
  await expect(annotations.locator("dt", { hasText: /^(Enjoyment|Notes|Rating|Note)$/ })).toHaveCount(0);

  // Its tablet is off, as overnight.
  belmontTablet.loseNetwork();
  await expect.poll(() => online(page, "Belmont 1")).toBe(false);

  await card.getByRole("button", { name: "Edit its rating and note" }).click();
  const form = card.getByRole("form", { name: "Edit its rating and note" });
  // The form starts from what the Shot holds, and offers unrated and each whole rating.
  const rating = form.getByRole("combobox", { name: "Rating" });
  await expect(rating).toHaveText("4");
  await expect(form.getByLabel("Note")).toHaveValue("Sour at first");
  await rating.click();
  await expect(page.getByRole("option")).toHaveText(["Unrated", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  await page.getByRole("option", { name: "8", exact: true }).click();
  await form.getByLabel("Note").fill("Sweeter once it cooled.\nKeep this grind.");
  await form.getByRole("button", { name: "Save" }).click();

  // Shown at once, with where the edit stands in plain sight and what explains it behind its info icon.
  await expect(form).toHaveCount(0);
  await expect(field(card, "Rating")).toHaveText("8");
  await expect(field(card, "Note")).toHaveText("Sweeter once it cooled.\nKeep this grind.");
  await expect(standing).toHaveText("Awaiting its tablet");
  await expectTip(
    card,
    "Awaiting its tablet",
    "An edit of its rating or note made away from the tablet that holds this Shot is not written there yet, as while that tablet is off. Its Skin and DYE2 show the Shot as it was until then. Where the same is changed on that tablet later than the edit, the tablet's stands.",
  );
  expect(await onTablet(belmontTablet, SHOT)).toEqual({ enjoyment: 4, espressoNotes: "Sour at first" });
  // The Shots list shows the rating too.
  await page.goto("/shots");
  const listed = page.getByRole("table", { name: "Shots" });
  await expect(listed.getByRole("columnheader", { name: "Rating", exact: true })).toBeVisible();
  const ratings = (await listed.getByRole("columnheader").allTextContents()).indexOf("Rating");
  await expect(rows(listed).filter({ has: page.locator(`a[href$="/shots/${SHOT}"]`) }).getByRole("cell").nth(ratings)).toHaveText("8");

  // The page says so until the tablet has the edit, without being loaded again.
  await page.goto(`/shots/${SHOT}`);
  await expect(standing).toHaveText("Awaiting its tablet");
  belmontTablet.restoreNetwork();
  await expect(standing).toHaveCount(0, { timeout: 30_000 });
  expect(await onTablet(belmontTablet, SHOT)).toEqual({ enjoyment: 8, espressoNotes: "Sweeter once it cooled.\nKeep this grind." });
  await expect(field(card, "Rating")).toHaveText("8");

  // Saving with nothing changed makes no edit, and clearing both reads as unrated with no note.
  await card.getByRole("button", { name: "Edit its rating and note" }).click();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  expect(await edits(page, SHOT)).toHaveLength(1);
  await card.getByRole("button", { name: "Edit its rating and note" }).click();
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toHaveCount(0);
  expect(await edits(page, SHOT)).toHaveLength(1);
});

test("the card of edits, closed until opened, lists each with who made it, the Connected App one was made through, and one dropped for a later change on the tablet", async ({ page }) => {
  // One through an assistant, connected as the Admin, which may read and change.
  const { verifier, challenge } = pkce();
  await page.goto(authorizationUrl(server.url(), app, challenge));
  await page.getByRole("radiogroup", { name: "What it may do" }).getByRole("radio", { name: "Read and change" }).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page).toHaveURL(new RegExp(`^${app.redirectUri.replace(/[.?]/g, "\\$&")}\\?`));
  const accessToken = await exchange(page, verifier);
  await callTool(page, accessToken, "edit_shot", { id: SHOT, rating: 9 });
  await expect.poll(async () => (await edits(page, SHOT)).map((edit) => edit.state)).toEqual(["written", "written"]);

  // And one made here while the tablet is off, whose rating a barista then changes on the tablet, later, before it reconnects.
  belmontTablet.loseNetwork();
  await expect.poll(() => online(page, "Belmont 1")).toBe(false);
  expect((await page.request.patch(`/api/shots/${SHOT}`, { data: { rating: 3 } })).status()).toBe(200);
  // The edit is timed by the server's clock and the tablet's change by the tablet's, so a second passes between them (docs/AI_BUILD_NOTES.md).
  await page.waitForTimeout(1_100);
  expect((await belmontTablet.callApi("PUT", `/shots/${SHOT}`, { annotations: { enjoyment: 6 } })).status).toBe(200);
  belmontTablet.restoreNetwork();
  await expect.poll(async () => (await edits(page, SHOT)).map((edit) => edit.state), { timeout: 30_000 }).toEqual(["dropped", "written", "written"]);

  await page.goto(`/shots/${SHOT}`);
  // The tablet's later rating stands.
  await expect(field(page.getByRole("region", { name: "Rating and note", exact: true }), "Rating")).toHaveText("6");
  const card = page.getByRole("region", { name: "Rating and note edits" });
  await expect(card.getByRole("table")).toHaveCount(0);
  await expectTip(card, "Rating and note edits", /^Each edit of this Shot's rating or note made away from the tablet that holds it, newest first: here, or through a Connected App, such as an assistant\./);
  await openCard(page, "Rating and note edits");
  const listed = rows(card.getByRole("table", { name: "Rating and note edits" }));
  await expect(listed).toHaveCount(3);
  expect(await cells(listed)).toEqual([
    ["You", "Rating: 3", "Dropped for a later change on the tablet"],
    ["You, through Test Assistant", "Rating: 9", "Written to its tablet"],
    ["You", "Rating: 8Note: Sweeter once it cooled.\nKeep this grind.", "Written to its tablet"],
  ]);
  // Each at its time on Belmont's clock, as the page's other times are.
  await expect(listed.first().getByRole("cell").first()).toHaveText(/^Nov \d+, 2026, \d+:\d\d [AP]M C[SD]T$/);
});

test("a Viewer and Staff elsewhere read a Shot's rating, note and edits, with no control editing them, and Staff at its Location edit it", async ({ page, browser }) => {
  const { locations } = (await (await page.request.get("/api/locations")).json()) as { locations: { id: string; name: string }[] };
  const lab = locations.find((location) => location.name === "Lab")!;

  for (const role of ["viewer", "staff"] as const) {
    await asNew(page, browser, role, role === "staff" ? lab.id : undefined, async (theirs) => {
      await theirs.goto(`/shots/${SHOT}`);
      const card = theirs.getByRole("region", { name: "Rating and note", exact: true });
      await expect(field(card, "Rating")).toHaveText("6");
      await expect(field(card, "Note")).toHaveText("Sweeter once it cooled.\nKeep this grind.");
      await expect(card.getByRole("button", { name: "About Rating and note", exact: true })).toBeVisible();
      await expect(card.getByRole("button", { name: "Edit its rating and note" })).toHaveCount(0);
      // The edits too, naming no other account.
      const edits = await openCard(theirs, "Rating and note edits");
      expect((await cells(rows(edits.getByRole("table")))).map(([by]) => by)).toEqual(["An account", "An account, through Test Assistant", "An account"]);

      // Staff at the Lab edit the Lab's Shot, which then names them.
      await theirs.goto(`/shots/${LAB_SHOT}`);
      await expect(field(card, "Rating")).toHaveText("Unrated");
      await expect(field(card, "Note")).toHaveText("None");
      if (role === "viewer") return expect(card.getByRole("button", { name: "Edit its rating and note" })).toHaveCount(0);
      await card.getByRole("button", { name: "Edit its rating and note" }).click();
      const form = card.getByRole("form", { name: "Edit its rating and note" });
      await form.getByRole("combobox", { name: "Rating" }).click();
      await theirs.getByRole("option", { name: "7", exact: true }).click();
      await form.getByRole("button", { name: "Save" }).click();
      await expect(field(card, "Rating")).toHaveText("7");
      await expect(field(card, "Note")).toHaveText("None");
      const made = await openCard(theirs, "Rating and note edits");
      expect((await cells(rows(made.getByRole("table")))).map(([by, change]) => [by, change])).toEqual([["You", "Rating: 7"]]);
    });
  }

  // The Admin reads who it was.
  await page.goto(`/shots/${LAB_SHOT}`);
  const made = await openCard(page, "Rating and note edits");
  expect((await cells(rows(made.getByRole("table")))).map(([by]) => by)).toEqual(["Sam Staff"]);
});

/** A Shot pulled at a UTC time on the hardware of that serial, derived from the real one with the annotations given beside its own. */
function shotAt(id: string, pulledAt: string, serial: string, annotations: Record<string, unknown>): Record<string, unknown> {
  const fixture = shotFixture();
  const workflow = fixture.workflow as Record<string, Record<string, unknown>>;
  return derivedShot(id, {
    timestamp: pulledAt,
    workflow: { ...workflow, machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial } },
    annotations: { ...(fixture.annotations as Record<string, unknown>), ...annotations },
  });
}

/**
 * Creates a Machine, at the Location since long before its Shot was pulled,
 * and loads a simulated tablet on its hardware holding the Shot, kept until
 * the file's tests have run; resolves once the server lists the Shot.
 */
async function adopt(page: Page, name: string, serial: string, locationId: string, shot: Record<string, unknown>): Promise<SimulatedTablet> {
  const response = await page.request.post("/api/machines", { data: { name } });
  expect(response.status()).toBe(201);
  const { machine, token } = (await response.json()) as { machine: { id: string }; token: string };
  const moved = await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId, effectiveFrom: "2025-01-01T00:00:00Z" } });
  expect(moved.status()).toBe(201);
  const tablet = server.keep(() =>
    SimulatedTablet.load({ settings: settingsFor({ serverUrl: server.url(), token }), api: withShots(derivedDe1Pro({ model: "DE1Pro", serial }), [shot]), timeScale: 50 }),
  );
  await expect.poll(async () => (await page.request.get(`/api/shots/${String(shot.id)}`)).status()).toBe(200);
  return tablet;
}

/** Whether the Machine is online, as the Machines list says. */
async function online(page: Page, name: string): Promise<boolean | undefined> {
  const { machines } = (await (await page.request.get("/api/machines")).json()) as { machines: { name: string; online: boolean }[] };
  return machines.find((machine) => machine.name === name)?.online;
}

/** What the tablet's own Decaid holds of the Shot's rating and note. */
async function onTablet(tablet: SimulatedTablet, id: string): Promise<Record<string, unknown>> {
  const { body } = await tablet.callApi("GET", `/shots/${id}`);
  const { enjoyment, espressoNotes } = (body as { annotations: Record<string, unknown> }).annotations;
  return { enjoyment, espressoNotes };
}

/** The Shot's edits as the REST API lists them, newest first. */
async function edits(page: Page, id: string): Promise<{ state: string }[]> {
  return ((await (await page.request.get(`/api/shots/${id}`)).json()) as { shot: { edits: { state: string }[] } }).shot.edits;
}

/** Each row's By, Change and Tablet cells, as the card of edits shows them. */
async function cells(listed: Locator): Promise<string[][]> {
  return Promise.all((await listed.all()).map(async (row) => (await row.getByRole("cell").allInnerTexts()).slice(1).map((text) => text.replace(/\n(?=Note: )/, ""))));
}

/** Exchanges the code the app's redirect last received, as the app does, for its access token. */
async function exchange(page: Page, verifier: string): Promise<string> {
  const response = await page.request.post("/api/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: app.callbacks.at(-1)!.get("code")!,
      code_verifier: verifier,
      redirect_uri: app.redirectUri,
      client_id: app.clientId,
      resource: `${server.url()}/api/mcp`,
    },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Calls a tool as the app does, with its access token, which must succeed. */
async function callTool(page: Page, accessToken: string, name: string, args: Record<string, unknown>): Promise<void> {
  const response = await page.request.post("/api/mcp", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.status()).toBe(200);
  // As JSON, or as a server-sent event carrying it.
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))!.slice("data: ".length);
  expect((JSON.parse(json) as { result: { isError?: boolean } }).result.isError).toBeFalsy();
}

/** Runs `work` with a page signed in as a new account: Staff working at the Location, or a Viewer. */
async function asNew(page: Page, browser: Browser, role: "staff" | "viewer", locationId: string | undefined, work: (page: Page) => Promise<void>) {
  const response = await page.request.post("/api/invites", { data: { email: `${role}@example.com`, role, locationIds: locationId ? [locationId] : [] } });
  expect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const context = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await context.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, {
      data: { name: role === "staff" ? "Sam Staff" : "Val Viewer", password: "account password 1" },
    });
    expect(accepted.status()).toBe(201);
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}
