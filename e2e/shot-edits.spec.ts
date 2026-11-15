import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { derivedShot, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { Refusal, SimulatedTablet, derivedDe1Pro, settingsFor } from "../server/test/support/simulated-tablet.js";
import { ASSISTANT_ENV, type TestApp, authorizationUrl, pkce, serveTestApp } from "../server/test/support/test-app.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field, openCard, rows } from "./support/locators.js";
import { CHECK_MS, afterStatusPolls } from "./support/polling.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// A Shot's rating and note on its page (#514, ADR-0031): edited there by an
// Admin, and by Staff for a Shot at a Location they work at, the rating as
// five stars, two points of Decaid's rating a star, as DYE2 has it; the page saying
// that an edit awaits its tablet until the tablet has it; and its card of
// the edits made through the server, closed until opened, with who made
// each, the Connected App one was made through, and one dropped for a later
// change on the tablet marked so; and the page saying that an edit has no
// tablet to reach. A Viewer and Staff elsewhere read all of
// it and have no control. Simulated tablets running the built plugin hold
// Shots derived from a scrubbed real record, changing only their id, time,
// recorded hardware, rating and note, and carry out Decaid's own Shot
// update. The Connected App is a loopback test app. Serials are made up,
// from 51451.
const server = useFreshServer({ env: { ...ASSISTANT_ENV, SYNC_HEARTBEAT_SECONDS: "1" } });

const SHOT = "belmont-espresso";
/** Belmont's too, which its tablet comes to hold no longer. */
const GONE = "belmont-deleted";
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
  belmontTablet = await adopt(page, "Belmont 1", "51451", belmont.id, [
    shotAt(SHOT, "2026-11-10T15:00:00Z", "51451", { enjoyment: 4, espressoNotes: "Sour at first" }),
    shotAt(GONE, "2026-11-10T15:10:00Z", "51451", {}),
  ]);
  await adopt(page, "Lab 1", "51452", lab.id, [shotAt(LAB_SHOT, "2026-11-10T16:00:00Z", "51452", {})]);

  await page.goto(`/shots/${SHOT}`);
  const card = page.getByRole("region", { name: "Rating and note", exact: true });
  // In stars, as DYE2 shows it: two points of Decaid's rating a star.
  await expect(field(card, "Rating")).toHaveText("2 stars");
  await expect(field(card, "Note")).toHaveText("Sour at first");
  await expectTip(card, "Rating and note", /^How the Shot was judged\. The rating is up to 5 stars, as DYE2 and a Skin show it on a tablet: each star is two points of the rating from 0 to 10 that Decaid keeps/);
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
  // The form starts from what the Shot holds, and offers five stars, one pressed at a time.
  const stars = form.getByRole("radiogroup", { name: "Rating" }).getByRole("radio");
  await expect(stars).toHaveCount(5);
  expect(await Promise.all((await stars.all()).map((star) => star.getAttribute("aria-label")))).toEqual(["1 star", "2 stars", "3 stars", "4 stars", "5 stars"]);
  await expect(form.getByRole("radio", { checked: true })).toHaveAccessibleName("2 stars");
  await expect(form.getByLabel("Note")).toHaveValue("Sour at first");
  await form.getByRole("radio", { name: "4 stars" }).click();
  await expect(form.getByRole("radio", { checked: true })).toHaveAccessibleName("4 stars");
  await form.getByLabel("Note").fill("Sweeter once it cooled.\nKeep this grind.");
  await form.getByRole("button", { name: "Save" }).click();

  // Shown at once, with where the edit stands in plain sight and what explains it behind its info icon.
  await expect(form).toHaveCount(0);
  await expect(field(card, "Rating")).toHaveText("4 stars");
  await expect(field(card, "Note")).toHaveText("Sweeter once it cooled.\nKeep this grind.");
  await expect(standing).toHaveText("Awaiting its tablet");
  await expectTip(
    card,
    "Awaiting its tablet",
    "An edit of its rating or note made away from the tablet that holds this Shot is not written there yet, as while that tablet is off or its plugin is older than this release. Its Skin and DYE2 show the Shot as it was until then. Where the same is changed on that tablet later than the edit, the tablet's stands. An edit whose tablet never connects again, as one replaced, waits for good.",
  );
  expect(await onTablet(belmontTablet, SHOT)).toEqual({ enjoyment: 4, espressoNotes: "Sour at first" });
  // The Shots list shows the rating too.
  await page.goto("/shots");
  const listed = page.getByRole("table", { name: "Shots" });
  await expect(listed.getByRole("columnheader", { name: "Rating", exact: true })).toBeVisible();
  const ratings = (await listed.getByRole("columnheader").allTextContents()).indexOf("Rating");
  const ratingOf = (id: string) => rows(listed).filter({ has: page.locator(`a[href$="/shots/${id}"]`) }).getByRole("cell").nth(ratings);
  await expect(ratingOf(SHOT)).toHaveText("4 stars");
  // And none for a Shot unrated, as its page says Unrated.
  await expect(ratingOf(GONE)).toHaveText("-");

  // The page says so until the tablet has the edit, without being loaded again: it reads the Shot again as often as
  // a Machine's page reads its status, while an edit awaits.
  await page.clock.install();
  await page.goto(`/shots/${SHOT}`);
  await expect(standing).toHaveText("Awaiting its tablet");
  belmontTablet.restoreNetwork();
  await afterStatusPolls(page, () => expect(standing).toHaveCount(0, { timeout: CHECK_MS }));
  // Four stars are 8 of Decaid's 10, as DYE2 would write them.
  expect(await onTablet(belmontTablet, SHOT)).toEqual({ enjoyment: 8, espressoNotes: "Sweeter once it cooled.\nKeep this grind." });
  await expect(field(card, "Rating")).toHaveText("4 stars");

  // Saving with nothing changed makes no edit; pressing the star chosen again leaves none, which Cancel drops.
  await card.getByRole("button", { name: "Edit its rating and note" }).click();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  expect(await edits(page, SHOT)).toHaveLength(1);
  await card.getByRole("button", { name: "Edit its rating and note" }).click();
  await form.getByRole("radio", { name: "4 stars" }).click();
  await expect(form.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(form.getByText("Unrated", { exact: true })).toBeVisible();
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toHaveCount(0);
  expect(await edits(page, SHOT)).toHaveLength(1);
});

test("the card of edits, closed until opened, lists each with who made it, the Connected App one was made through, and one dropped for a later change on the tablet, and a Shot its tablet no longer holds says so", async ({ page }) => {
  // One through an assistant, connected as the Admin, which may read and change.
  const { verifier, challenge } = pkce();
  await page.goto(authorizationUrl(server.url(), app, challenge));
  await page.getByRole("radiogroup", { name: "What it may do" }).getByRole("radio", { name: "Read and change" }).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page).toHaveURL(new RegExp(`^${app.redirectUri.replace(/[.?]/g, "\\$&")}\\?`));
  const accessToken = await exchange(page, verifier);
  await callTool(page, accessToken, "edit_shot", { id: SHOT, rating: 9 });
  await expect.poll(async () => (await edits(page, SHOT)).map((edit) => edit.state)).toEqual(["written", "written"]);
  // A rating between two stars reads as it is, and the form starts from the stars DYE2 would show: saved untouched, it sends none.
  await page.goto(`/shots/${SHOT}`);
  const rated = page.getByRole("region", { name: "Rating and note", exact: true });
  await expect(field(rated, "Rating")).toHaveText("4.5 stars");
  await rated.getByRole("button", { name: "Edit its rating and note" }).click();
  await expect(rated.getByRole("radio", { checked: true })).toHaveAccessibleName("5 stars");
  await rated.getByRole("button", { name: "Save" }).click();
  await expect(rated.getByRole("form")).toHaveCount(0);
  expect(await edits(page, SHOT)).toHaveLength(2);

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
  await expect(field(page.getByRole("region", { name: "Rating and note", exact: true }), "Rating")).toHaveText("3 stars");
  const card = page.getByRole("region", { name: "Rating and note edits" });
  await expect(card.getByRole("table")).toHaveCount(0);
  await expectTip(card, "Rating and note edits", /^Each edit of this Shot's rating or note made away from the tablet that holds it, newest first: here, or through a Connected App, such as an assistant\./);
  await openCard(page, "Rating and note edits");
  const listed = rows(card.getByRole("table", { name: "Rating and note edits" }));
  await expect(listed).toHaveCount(3);
  expect(await cells(listed)).toEqual([
    ["You", "Rating: 1.5 stars", "Dropped for a later change on the tablet"],
    ["You, through Test Assistant", "Rating: 4.5 stars", "Written to its tablet"],
    ["You", "Rating: 4 starsNote: Sweeter once it cooled.\nKeep this grind.", "Written to its tablet"],
  ]);
  // Each at its time on Belmont's clock, as the page's other times are.
  await expect(listed.first().getByRole("cell").first()).toHaveText(/^[A-Z][a-z]{2} \d+, \d{4}, \d+:\d\d [AP]M C[SD]T$/);

  // A Shot its tablet no longer holds, as one deleted there: its edit stays here, and the page says it has no tablet to reach.
  belmontTablet.refuseFor(`/shots/${GONE}`, new Refusal(404, { error: "Shot not found" }));
  expect((await page.request.patch(`/api/shots/${GONE}`, { data: { rating: 5 } })).status()).toBe(200);
  await expect.poll(async () => (await edits(page, GONE)).map((edit) => edit.state)).toEqual(["noTablet"]);
  await page.goto(`/shots/${GONE}`);
  const gone = page.getByRole("region", { name: "Rating and note", exact: true });
  await expect(field(gone, "Rating")).toHaveText("2.5 stars");
  await expect(gone.getByRole("status", { name: "Edits and the tablet" })).toHaveText("No tablet to reach");
  await expectTip(gone, "No tablet to reach", "The tablet that held this Shot answered that it no longer holds it, as when the Shot is deleted there. Its latest edit is kept here, and written to no tablet.");
  await openCard(page, "Rating and note edits");
  expect(await cells(listed)).toEqual([["You", "Rating: 2.5 stars", "No tablet to reach"]]);
});

test("a Viewer and Staff elsewhere read a Shot's rating, note and edits, with no control editing them, and Staff at its Location edit it", async ({ page, browser }) => {
  const { locations } = (await (await page.request.get("/api/locations")).json()) as { locations: { id: string; name: string }[] };
  const lab = locations.find((location) => location.name === "Lab")!;

  for (const role of ["viewer", "staff"] as const) {
    await asNew(page, browser, role, role === "staff" ? lab.id : undefined, async (theirs) => {
      await theirs.goto(`/shots/${SHOT}`);
      const card = theirs.getByRole("region", { name: "Rating and note", exact: true });
      await expect(field(card, "Rating")).toHaveText("3 stars");
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
      await form.getByRole("radio", { name: "3 stars" }).click();
      await form.getByRole("button", { name: "Save" }).click();
      await expect(field(card, "Rating")).toHaveText("3 stars");
      await expect(field(card, "Note")).toHaveText("None");
      const made = await openCard(theirs, "Rating and note edits");
      expect((await cells(rows(made.getByRole("table")))).map(([by, change]) => [by, change])).toEqual([["You", "Rating: 3 stars"]]);
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
 * Creates a Machine, at the Location since long before its Shots were
 * pulled, and loads a simulated tablet on its hardware holding the Shots,
 * kept until the file's tests have run; resolves once the server lists them.
 */
async function adopt(page: Page, name: string, serial: string, locationId: string, shots: Record<string, unknown>[]): Promise<SimulatedTablet> {
  const response = await page.request.post("/api/machines", { data: { name } });
  expect(response.status()).toBe(201);
  const { machine, token } = (await response.json()) as { machine: { id: string }; token: string };
  const moved = await page.request.post(`/api/machines/${machine.id}/location-history`, { data: { locationId, effectiveFrom: "2025-01-01T00:00:00Z" } });
  expect(moved.status()).toBe(201);
  const tablet = server.keep(() =>
    SimulatedTablet.load({ settings: settingsFor({ serverUrl: server.url(), token }), api: withShots(derivedDe1Pro({ model: "DE1Pro", serial }), shots), timeScale: 50 }),
  );
  for (const shot of shots) await expect.poll(async () => (await page.request.get(`/api/shots/${String(shot.id)}`)).status()).toBe(200);
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
