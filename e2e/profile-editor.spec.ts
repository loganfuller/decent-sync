import fs from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { NO_DYE2_LISTS } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";

// Seam 3 for #579: Drafts and the editor. A simulated tablet at the Lab
// saves a soak Profile with an exit, a limit and a step of no length, and
// holds Decaid's bundled Classic Italian espresso. Edit on the soak's page
// starts a Draft of it, changed through the inspector, the keyboard and a
// handle dragged on the graph, its steps added, moved and deleted, checked,
// undone and redone; New Profile starts others from a starting shape, a
// duplicate and a file; the Library lists them; a Viewer sees none. Serials
// are made up, from 57951.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

type Fields = Record<string, unknown>;

/** Classic Italian espresso, which Decaid bundles, by the id Decaid gives it. */
const CLASSIC = "profile:39e939592679fb194706";

const classicRecord = (JSON.parse(fs.readFileSync(new URL("../server/test/fixtures/decaid/profile-ids-v0.9.2/profile-ids.json", import.meta.url), "utf8")) as { bundled: Fields[] }).bundled.find(
  (record) => record.id === CLASSIC,
)!;

/** A soak Profile: a fast fill that moves on over 4 bar, a step of no length, then 6 bar with the flow held back. */
function soak(title: string): Fields {
  const step = (fields: Fields) => ({ transition: "fast", exit: null, volume: 0, weight: null, temperature: 90, sensor: "coffee", limiter: null, ...fields });
  return {
    title,
    author: "Decent Sync fixtures",
    notes: "",
    beverage_type: "espresso",
    version: "2",
    steps: [
      step({ name: "Fill", pump: "flow", flow: 8, seconds: 15, exit: { type: "pressure", condition: "over", value: 4 } }),
      step({ name: "Settle", pump: "flow", flow: 0, seconds: 0, exit: { type: "pressure", condition: "under", value: 1 } }),
      step({ name: "Percolation", pump: "pressure", pressure: 6, seconds: 60, temperature: 88, limiter: { value: 1.5, range: 2.5 } }),
    ],
    target_volume: null,
    target_weight: 40,
    target_volume_count_start: 2,
    tank_temperature: 0,
  };
}

interface SavedDraft {
  saves: number;
  profile: { title: string; target_volume_count_start: number; steps: Array<Fields & { name: string }> };
}

let soakId: string;

/** The Draft as the server holds it, once its page has saved what it shows. */
async function saved(page: Page): Promise<SavedDraft> {
  await expect(page.getByText("saving…")).toHaveCount(0);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  return ((await (await page.request.get(`/api/drafts/${id}`)).json()) as { draft: SavedDraft }).draft;
}

const inspector = (page: Page) => page.getByRole("region", { name: "Inspector" });
const stepsCard = (page: Page) => page.getByRole("region", { name: "Steps" });
const checks = (page: Page) => page.getByRole("region", { name: "Checks" });

test.beforeEach(({ page }) => signInAsAdmin(page));

test("Edit on a Profile's page starts a Draft of it, saved as it changes in the inspector, drawn against the version it started from", async ({ page }) => {
  const lab = await createLocation(page, "Draft lab");
  const lab1 = await tabletAt(page, server, "Draft lab group", lab, "57951", { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [classicRecord], ...NO_DYE2_LISTS });
  soakId = String((await lab1.addProfile(soak("Lab Soak"))).id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(soakId)}`)).status()).toBe(200);

  await page.goto(`/library/profiles/${encodeURIComponent(soakId)}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(/\/library\/drafts\//);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lab Soak Draft");
  await expect(page.getByText("Will publish as a new version of Lab Soak")).toBeVisible();
  // Unchanged, its steps are the Profile's own.
  await expect(checks(page).getByText('Its steps are those of "Lab Soak", which the Library has.')).toBeVisible();
  const graph = page.getByRole("region", { name: "How it runs" });
  await expect(graph.getByText("Lab Soak, simulated")).toBeVisible();
  await expect(graph.locator("[data-baseline]")).toHaveCount(1);

  // The percolation's target, through the inspector: the graph simulates again, its figures said against the version it started from.
  await stepsCard(page).getByRole("button", { name: "Select step 3, Percolation" }).click();
  await expect(inspector(page).getByRole("tab", { name: "Step 3" })).toHaveAttribute("data-state", "active");
  await inspector(page).getByLabel("Target").fill("8");
  await expect(graph.getByRole("definition").filter({ hasText: /than Lab Soak$/ }).first()).toBeVisible();
  await expect(checks(page).getByText("Nothing stops this from publishing")).toBeVisible();
  expect((await saved(page)).profile.steps[2]).toMatchObject({ pressure: 8 });

  // Held to what the machine accepts.
  await inspector(page).getByLabel("Target").fill("13");
  await expect(inspector(page).getByText("Held to 0 to 12 bar, what the machine accepts")).toBeVisible();
  expect((await saved(page)).profile.steps[2]).toMatchObject({ pressure: 12 });

  // A later step's temperature is given against the first's.
  const temperature = inspector(page).getByLabel("Temperature");
  await expect(temperature).toHaveValue("-2");
  await expect(inspector(page).getByText("88 °C at a 90 °C brew")).toBeVisible();
  await temperature.fill("-4");
  expect((await saved(page)).profile.steps[2]).toMatchObject({ temperature: 86 });

  // The whole Profile.
  await inspector(page).getByRole("tab", { name: "Whole Profile" }).click();
  await inspector(page).getByLabel("Title").fill("Lab Soak, hotter");
  const brew = inspector(page).getByLabel("Brew temperature");
  await brew.fill("92");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lab Soak, hotter Draft");
  expect((await saved(page)).profile).toMatchObject({ title: "Lab Soak, hotter", steps: [{ temperature: 92 }, { temperature: 92 }, { temperature: 88 }] });
  // Typed a key at a time, the values on the way, 1 and 10, hold no step to the range: each moves from where it was.
  await brew.fill("");
  await brew.pressSequentially("100");
  await brew.blur();
  expect((await saved(page)).profile).toMatchObject({ steps: [{ temperature: 100 }, { temperature: 100 }, { temperature: 96 }] });
  await brew.fill("92");
  expect((await saved(page)).profile).toMatchObject({ steps: [{ temperature: 92 }, { temperature: 92 }, { temperature: 88 }] });
});

test("the selected step's handles move with the keyboard and by dragging, its maximum time a bracket past its band where it exits early", async ({ page }) => {
  await page.goto("/library/profiles");
  await page.getByRole("region", { name: "Drafts" }).getByRole("link", { name: /^Open the Draft Lab Soak, hotter$/ }).click();
  await stepsCard(page).getByRole("button", { name: "Select step 1, Fill" }).click();
  const graph = page.getByRole("region", { name: "How it runs" });
  const target = graph.getByRole("slider", { name: "Fill's target, ml/s" });
  const exit = graph.getByRole("slider", { name: "Fill's exit, pressure over, bar" });
  const bracket = graph.getByRole("slider", { name: "Fill's maximum time, s" });
  await expect(bracket).toHaveAttribute("aria-valuenow", "15");
  // The fill exits over 4 bar long before its 15 s: its bracket sits past its band's end.
  const band = await graph.locator('[data-step-band="0"]').boundingBox();
  const bracketBox = await bracket.boundingBox();
  expect(bracketBox!.x).toBeGreaterThan(band!.x + band!.width);

  await target.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(target).toHaveAttribute("aria-valuenow", "6.9");
  await bracket.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(bracket).toHaveAttribute("aria-valuenow", "14.5");
  expect((await saved(page)).profile.steps[0]).toMatchObject({ flow: 6.9, seconds: 14.5 });

  // The exit, dragged up its lane.
  const box = (await exit.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 20, { steps: 5 });
  await page.mouse.up();
  const raised = Number(await exit.getAttribute("aria-valuenow"));
  expect(raised).toBeGreaterThan(4);
  expect((await saved(page)).profile.steps[0]).toMatchObject({ exit: { type: "pressure", condition: "over", value: raised } });
});

test("steps are added, duplicated, moved and deleted, with preinfusion kept on its step, and every change undone and redone", async ({ page }) => {
  await page.goto("/library/profiles");
  await page.getByRole("region", { name: "Drafts" }).getByRole("link", { name: /^Open the Draft Lab Soak, hotter$/ }).click();
  const names = () => stepsCard(page).getByRole("button", { name: /^Select step/ });
  await expect(names()).toHaveText([/^1Fill/, /^2SettlePreinfusion ends/, /^3Percolation/]);

  await stepsCard(page).getByRole("button", { name: "Select step 1, Fill" }).click();
  await stepsCard(page).getByRole("button", { name: "Add a step" }).click();
  await expect(names()).toHaveText([/^1Fill/, /^2New step/, /^3SettlePreinfusion ends/, /^4Percolation/]);
  await stepsCard(page).getByRole("button", { name: "Move Settle down" }).click();
  await expect(names()).toHaveText([/^1Fill/, /^2New step/, /^3Percolation/, /^4SettlePreinfusion ends/]);
  await inspector(page).getByRole("button", { name: "Duplicate the step" }).click();
  await expect(names()).toHaveCount(5);
  await inspector(page).getByRole("button", { name: "Delete the step" }).click();
  await expect(names()).toHaveCount(4);
  expect((await saved(page)).profile).toMatchObject({ target_volume_count_start: 4, steps: [{ name: "Fill" }, { name: "New step" }, { name: "Percolation" }, { name: "Settle" }] });

  // Undone back to the three steps, with the toolbar's button and from the keyboard, and redone once.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(names()).toHaveCount(5);
  await page.getByRole("button", { name: "Undo" }).click();
  await page.locator("body").press("ControlOrMeta+z");
  await page.locator("body").press("ControlOrMeta+z");
  await expect(names()).toHaveText([/^1Fill/, /^2SettlePreinfusion ends/, /^3Percolation/]);
  await page.locator("body").press("ControlOrMeta+Shift+z");
  await expect(names()).toHaveCount(4);
  expect((await saved(page)).profile.target_volume_count_start).toBe(3);
});

test("the checks name their step, both kinds, and choosing one selects it", async ({ page }) => {
  await page.goto("/library/profiles");
  await page.getByRole("region", { name: "Drafts" }).getByRole("link", { name: /^Open the Draft Lab Soak, hotter$/ }).click();
  await stepsCard(page).getByRole("button", { name: "Select step 2, New step" }).click();
  await inspector(page).getByLabel("Or at a weight of").fill("4");
  await expect(inspector(page).getByText("Needs a scale")).toBeVisible();
  await inspector(page).getByLabel("Name").fill("");
  const advice = checks(page).getByRole("region", { name: "Advice" });
  await expect(advice.getByRole("button", { name: "Step 2 ends at a weight in the cup, which needs a scale connected." })).toBeVisible();
  await expect(checks(page).getByRole("region", { name: "Stops it publishing" }).getByText("Step 2 has no name.")).toBeVisible();
  await stepsCard(page).getByRole("button", { name: "Select step 1, Fill" }).click();
  await advice.getByRole("button", { name: /^Step 2 ends at a weight/ }).click();
  await expect(inspector(page).getByRole("tab", { name: "Step 2" })).toHaveAttribute("data-state", "active");
  await inspector(page).getByLabel("Name").fill("Soak");
  await expect(checks(page).getByText("Nothing stops this from publishing")).toBeVisible();
});

test("a save made after someone else's is taken, and the page says another came between", async ({ page }) => {
  await page.goto("/library/profiles");
  await page.getByRole("region", { name: "Drafts" }).getByRole("link", { name: /^Open the Draft Lab Soak, hotter$/ }).click();
  await expect(inspector(page)).toBeVisible();
  // Saved meanwhile elsewhere, as by a colleague.
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const { draft } = (await (await page.request.get(`/api/drafts/${id}`)).json()) as { draft: SavedDraft };
  expect((await page.request.put(`/api/drafts/${id}`, { data: { profile: { ...draft.profile, notes: "Saved elsewhere" }, saves: draft.saves } })).status()).toBe(200);
  await inspector(page).getByRole("tab", { name: "Whole Profile" }).click();
  await inspector(page).getByLabel("Author").fill("Lab lead");
  await expect(page.getByText(/^Another save came between: You, here saved this Draft .+ after you opened it, and your change was saved over it\.$/)).toBeVisible();
  // The later save wins: the notes saved elsewhere are gone with it.
  expect((await saved(page)).profile).toMatchObject({ author: "Lab lead", notes: "" });
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText(/^Another save came between/)).toHaveCount(0);
});

test("New Profile starts a Draft from a starting shape, a duplicate of a bundled Profile or a file, which is held to the ranges", async ({ page }) => {
  // A bundled Profile's page offers Duplicate, not Edit.
  await page.goto(`/library/profiles/${encodeURIComponent(CLASSIC)}`);
  await expect(page.getByRole("button", { name: "Duplicate" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);

  await page.goto("/library/profiles");
  await page.getByRole("link", { name: "New Profile" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("New Profile");
  await expect(page.getByRole("button", { name: /^Start from / })).toHaveText([/^Classic 9 bar/, /^Declining lever/, /^Steady flow/, /^Blooming/, /^Long and gentle/, /^Blank/]);
  await page.getByRole("button", { name: "Start from Blooming" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blooming Draft");
  await expect(page.getByText("Will publish as a new Profile, from Blooming")).toBeVisible();
  await expect(page.getByRole("region", { name: "How it runs" }).getByText("Blooming as it started, simulated")).toBeVisible();

  await page.goto("/library/profiles/new");
  await page.getByRole("combobox", { name: "The Profile to duplicate" }).click();
  await page.getByRole("option", { name: "Classic Italian espresso (bundled)" }).click();
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Classic Italian espresso copy Draft");
  await expect(page.getByText("Will publish as a new Profile, a copy of Classic Italian espresso")).toBeVisible();

  await page.goto("/library/profiles/new");
  const tooHigh = { ...soak("From a file"), steps: (soak("").steps as Fields[]).map((step) => (step.pump === "pressure" ? { ...step, pressure: 13 } : step)) };
  await page.getByLabel("A profile file to import").setInputFiles({ name: "from-a-file.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(tooHigh)) });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("From a file Draft");
  await expect(page.getByText('Held to what the machine accepts, from the file: Step 3, "Percolation": its pressure from 13 to 12.')).toBeVisible();
  await page.goto("/library/profiles/new");
  await page.getByLabel("A profile file to import").setInputFiles({ name: "not.json", mimeType: "application/json", buffer: Buffer.from("not json") });
  await expect(page.getByText("not.json is not JSON, so not a profile Decaid reads.")).toBeVisible();
});

test("the Library lists Drafts above its Profiles, each with what it will become and who saved it last, and a Draft discarded is gone", async ({ page }) => {
  await page.goto("/library/profiles");
  const drafts = page.getByRole("region", { name: "Drafts" });
  await expect(drafts.getByRole("listitem")).toHaveCount(4);
  await expect(drafts.getByRole("listitem").filter({ hasText: "Lab Soak, hotter" })).toContainText(/A new version of Lab Soak · saved .+ by You, here/);
  await expect(drafts.getByRole("listitem").filter({ hasText: "Blooming" })).toContainText("A new Profile, from Blooming");
  await drafts.getByRole("button", { name: "Discard the Draft Blooming" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
  await expect(drafts.getByRole("listitem")).toHaveCount(3);
  // Above the Profiles.
  const draftsBox = (await drafts.boundingBox())!;
  const profilesBox = (await page.getByRole("table", { name: "Profiles" }).boundingBox())!;
  expect(draftsBox.y).toBeLessThan(profilesBox.y);

  // From its own page, too, back to the Library.
  await drafts.getByRole("link", { name: "Open the Draft From a file" }).click();
  await page.getByRole("button", { name: "Discard the Draft From a file" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/\/library\/profiles$/);
  await expect(drafts.getByRole("listitem")).toHaveCount(2);
});

test("a step's maximum time dragged to nothing keeps its handles, and the axes follow the run once it is let go", async ({ page }) => {
  const { draft } = (await (await page.request.post("/api/drafts", { data: { shape: "lever" } })).json()) as { draft: SavedDraft & { id: string } };
  await page.goto(`/library/drafts/${draft.id}`);
  await stepsCard(page).getByRole("button", { name: "Select step 2, Peak" }).click();
  const graph = page.getByRole("region", { name: "How it runs" });
  const bracket = graph.getByRole("slider", { name: "Peak's maximum time, s" });
  await expect(bracket).toHaveAttribute("aria-valuenow", "4");
  const box = (await bracket.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 200, box.y + box.height / 2, { steps: 8 });
  await expect(bracket).toHaveAttribute("aria-valuenow", "0");
  await page.mouse.up();
  expect((await saved(page)).profile.steps[1]).toMatchObject({ seconds: 0 });
  // Still there to bring it back.
  await expect(graph.getByRole("slider", { name: "Peak's target, bar" })).toBeVisible();
  await bracket.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(bracket).toHaveAttribute("aria-valuenow", "5");
  // The axes held still for the drag are let go: a longer run widens them.
  const svg = graph.locator("svg[data-graph-end]").first();
  const before = Number(await svg.getAttribute("data-graph-end"));
  await inspector(page).getByRole("tab", { name: "Whole Profile" }).click();
  await inspector(page).getByLabel("Stop at weight").fill("150");
  await expect.poll(async () => Number(await svg.getAttribute("data-graph-end"))).toBeGreaterThan(before);
  await page.getByRole("button", { name: /^Discard the Draft/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/\/library\/profiles$/);
});

test("a Draft discarded elsewhere while open stops being saved, and says it is gone", async ({ page }) => {
  const { draft } = (await (await page.request.post("/api/drafts", { data: { shape: "classic" } })).json()) as { draft: SavedDraft & { id: string } };
  await page.goto(`/library/drafts/${draft.id}`);
  await expect(inspector(page)).toBeVisible();
  expect((await page.request.delete(`/api/drafts/${draft.id}`)).status()).toBe(204);
  const puts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes(`/api/drafts/${draft.id}`)) puts.push(request.url());
  });
  await inspector(page).getByRole("tab", { name: "Whole Profile" }).click();
  await inspector(page).getByLabel("Author").fill("Gone meanwhile");
  await expect(page.getByRole("alert")).toHaveText("There is no such Draft. It may have been published or discarded.");
  await page.waitForTimeout(2_000);
  expect(puts).toHaveLength(1);
});

test("at phone width, a Draft's page fits the screen", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: server.url(), viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  try {
    const phone = await context.newPage();
    await signInAsAdmin(phone);
    await phone.goto("/library/profiles");
    await phone.getByRole("region", { name: "Drafts" }).getByRole("link", { name: /^Open the Draft Lab Soak, hotter$/ }).click();
    await expect(phone.getByRole("region", { name: "Inspector" })).toBeVisible();
    await expect(phone.getByRole("region", { name: "How it runs" }).locator("[data-run]")).toHaveCount(1);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
    await phone.goto("/library/profiles/new");
    await expect(phone.getByRole("button", { name: "Start from Blank" })).toBeVisible();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
  } finally {
    await context.close();
  }
});

test("a Viewer sees no Draft and starts none", async ({ page, browser }) => {
  const { drafts } = (await (await page.request.get("/api/drafts")).json()) as { drafts: { id: string }[] };
  await asViewer(page, browser, async (viewer) => {
    await viewer.goto("/library/profiles");
    await expect(viewer.getByRole("table", { name: "Profiles" })).toBeVisible();
    await expect(viewer.getByRole("region", { name: "Drafts" })).toHaveCount(0);
    await expect(viewer.getByRole("link", { name: "New Profile" })).toHaveCount(0);
    await viewer.goto(`/library/profiles/${encodeURIComponent(soakId)}`);
    await expect(viewer.getByRole("region", { name: "How it runs" })).toBeVisible();
    await expect(viewer.getByRole("button", { name: /^(Edit|Duplicate)$/ })).toHaveCount(0);
    await viewer.goto(`/library/drafts/${drafts[0]!.id}`);
    await expect(viewer.getByRole("alert")).toHaveText("A Viewer sees no Drafts.");
    expect((await viewer.request.get("/api/drafts")).status()).toBe(403);
  });
});

/** Runs `work` with a page signed in as a new Viewer. */
async function asViewer(page: Page, browser: Browser, work: (page: Page) => Promise<void>) {
  const response = await page.request.post("/api/invites", { data: { email: "viewer-579@example.com", role: "viewer", locationIds: [] } });
  expect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const context = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await context.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: { name: "Val Viewer", password: "account password 1" } });
    expect(accepted.status()).toBe(201);
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}
