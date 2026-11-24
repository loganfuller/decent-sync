import fs from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { NO_DYE2_LISTS } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { graphClashes } from "./support/graph-text.js";
import { boxes } from "./support/layout.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";

// Seam 3 for #579: Drafts and the editor. A simulated tablet at the Lab
// saves a soak Profile with an exit, a limit and a step of no length, and
// holds Decaid's bundled Classic Italian espresso. Edit on the soak's page
// starts a Draft of it, changed through the inspector, the keyboard and a
// handle dragged on the graph, its steps added, moved and deleted, checked,
// undone and redone; New Profile starts others from a starting shape, a
// duplicate and a file; the Library lists them; a Viewer sees none. Serials
// are made up, from 57951. What the graph writes is measured against the
// selected step's handles, their tags and the bracket (#621), and the axes'
// numbers against those handles, each other and the cup row's names (#637).
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
/** The checks' status beside Publish (#623), named for what it says. */
const checksStatus = (page: Page) => page.getByRole("button", { name: /^Checks: / });
/** The list of checks the status opens. */
const checks = (page: Page) => page.getByRole("dialog", { name: "Checks" });

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
  // Unchanged, it is the Profile itself: nothing to publish, which no check calls a fault (#667).
  await expect(page.getByText("No changes from Lab Soak yet")).toBeVisible();
  await expect(checksStatus(page)).toHaveAccessibleName(/^Checks: Nothing stops publishing/);
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  const graph = page.getByRole("region", { name: "How it runs" });
  await expect(graph.getByText("Lab Soak, simulated")).toBeVisible();
  await expect(graph.locator("[data-baseline]")).toHaveCount(1);

  // The percolation's target, through the inspector: the graph simulates again, its figures said against the version it started from.
  await stepsCard(page).getByRole("button", { name: "Select step 3, Percolation" }).click();
  await expect(inspector(page).getByRole("tab", { name: "Step 3" })).toHaveAttribute("data-state", "active");
  await inspector(page).getByLabel("Target").fill("8");
  await expect(graph.getByRole("definition").filter({ hasText: /than Lab Soak$/ }).first()).toBeVisible();
  await expect(checksStatus(page)).toHaveAccessibleName(/^Checks: Nothing stops publishing/);
  expect((await saved(page)).profile.steps[2]).toMatchObject({ pressure: 8 });

  // Held to what the machine accepts.
  await inspector(page).getByLabel("Target").fill("13");
  await expect(inspector(page).getByText("Held to 0 to 12 bar, what the machine accepts")).toBeVisible();
  expect((await saved(page)).profile.steps[2]).toMatchObject({ pressure: 12 });

  // A later step's temperature is given against the first's, its value in plain sight; what explains a field is behind an icon beside its label.
  const temperature = inspector(page).getByLabel("Temperature", { exact: true });
  await expect(temperature).toHaveValue("-2");
  await expect(inspector(page).getByText("88 °C at a 90 °C brew")).toBeVisible();
  await temperature.fill("-4");
  expect((await saved(page)).profile.steps[2]).toMatchObject({ temperature: 86 });

  // The whole Profile.
  await inspector(page).getByRole("tab", { name: "Whole Profile" }).click();
  for (const field of ["brew temperature", "stop at weight", "stop at volume"]) await expect(inspector(page).getByRole("button", { name: `About ${field}` })).toBeVisible();
  await expect(inspector(page).getByText("A Recipe's yield replaces it")).toHaveCount(0);
  await inspector(page).getByLabel("Title").fill("Lab Soak, hotter");
  const brew = inspector(page).getByLabel("Brew temperature", { exact: true });
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
  const [band, bracketBox] = await boxes(graph.locator('[data-step-band="0"]'), bracket);
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

test("a Draft's graph writes nothing under a handle, its tag or the bracket, whose tag covers no band's text, and says a selected step's exit once, its axes' numbers clear on a phone", async ({ page }) => {
  // #621's Draft: a flow step of at most 40 s that moves on over 4 bar, then 9 bar.
  const step = (fields: Fields) => ({ transition: "fast", exit: null, volume: 0, weight: null, temperature: 93, sensor: "coffee", limiter: null, ...fields });
  const file = {
    title: "Long pre-brew",
    author: "Decent Sync fixtures",
    notes: "",
    beverage_type: "espresso",
    version: "2",
    steps: [step({ name: "Pre-brew", pump: "flow", flow: 1.5, seconds: 40, exit: { type: "pressure", condition: "over", value: 4 } }), step({ name: "Full brew", pump: "pressure", pressure: 9, seconds: 60 })],
    target_volume: null,
    target_weight: 36,
    target_volume_count_start: 1,
    tank_temperature: 0,
  };
  const created = await page.request.post("/api/drafts", { data: { file } });
  expect(created.status()).toBe(201);
  const { draft } = (await created.json()) as { draft: { id: string } };
  await page.goto(`/library/drafts/${draft.id}`);
  const graph = page.getByRole("region", { name: "How it runs" });
  await expect(graph.locator("svg[data-graph-end]")).toBeVisible();

  // Its second step selected, the first's exit is named in its lane.
  await stepsCard(page).getByRole("button", { name: "Select step 2, Full brew" }).click();
  await expect(graph.getByRole("slider", { name: "Full brew's target, bar" })).toBeVisible();
  await expect(graph.locator("[data-exit='0'] text")).toHaveText("Moves on over 4 bar");
  expect(await graphClashes(graph)).toEqual([]);

  // Selected, its exit is said by its handle's tag alone, on its threshold.
  await stepsCard(page).getByRole("button", { name: "Select step 1, Pre-brew" }).click();
  await expect(graph.locator("[data-handle-tag='exit']")).toHaveText("Over 4 bar");
  await expect(graph.locator("[data-exit='0'] line")).toHaveCount(1);
  await expect(graph.locator("[data-exit='0'] text")).toHaveCount(0);
  await expect(graph.getByText(/over 4 bar$/i)).toHaveText(["35.1 s · over 4 bar", "Over 4 bar"]);

  // The maximum time's bracket stands past its band, in the next: its tag is under the first lane, below each band's name and outcome.
  const tag = graph.locator("[data-handle-tag='seconds']");
  await expect(tag).toHaveText("At most 40.0 s");
  const widths: [number, number][] = [
    [1280, 720],
    [393, 852],
    [1710, 985],
  ];
  const drawn = graph.locator("svg[data-graph-end]");
  let drawnAt = "";
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    // Laid out again at its new width, nothing is over anything.
    await expect(drawn).not.toHaveAttribute("width", drawnAt);
    drawnAt = (await drawn.getAttribute("width"))!;
    await expect.poll(() => graphClashes(graph), { message: `at ${width} px` }).toEqual([]);
    const texts = graph.locator("[data-step-band] text");
    expect(await texts.count()).toBe(4);
    const each = await texts.all();
    const bracket = graph.getByRole("slider", { name: "Pre-brew's maximum time, s" });
    const [tagBox, next, bracketBox, ...textBoxes] = await boxes(tag, graph.locator("[data-step-band='1']"), bracket, ...each);
    expect(bracketBox!.x).toBeGreaterThan(next!.x);
    for (const [index, box] of textBoxes.entries()) {
      expect(tagBox!.y, `${await each[index]!.textContent()} at ${width} px`).toBeGreaterThanOrEqual(box!.y + box!.height);
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  expect((await page.request.delete(`/api/drafts/${draft.id}`)).status()).toBe(204);

  // Other first steps whose handles stand where something is written, at a laptop's and a phone's width.
  const brew = step({ name: "Full brew", pump: "pressure", pressure: 9, seconds: 60 });
  const others = [
    // A pause at 0 bar: its target stands on the pressure lane's bottom, by the gap the bracket's tag is in.
    { title: "Paused", target_weight: 36, first: step({ name: "Pause", pump: "pressure", pressure: 0, seconds: 5 }) },
    // A ramp to 9 bar over 20 s: its target and its tag stand where the pressure lane's name is.
    { title: "Ramped", target_weight: 36, first: step({ name: "Pause", pump: "pressure", pressure: 9, transition: "smooth", seconds: 20, exit: { type: "pressure", condition: "over", value: 8 } }) },
    // A ramp to 8 bar over 25 s: no place in the name's first three rows is clear.
    { title: "Ramped longer", target_weight: 36, first: step({ name: "Pause", pump: "pressure", pressure: 8, transition: "smooth", seconds: 25, exit: { type: "pressure", condition: "over", value: 7 } }) },
    // A long ramp the run stops in: its target's tag stands where "Not reached" is.
    { title: "Unreached", target_weight: 18, first: step({ name: "Pause", pump: "pressure", pressure: 5, transition: "smooth", seconds: 60 }) },
  ];
  for (const other of others) {
    const posted = await page.request.post("/api/drafts", { data: { file: { ...file, title: other.title, target_weight: other.target_weight, steps: [other.first, brew] } } });
    expect(posted.status()).toBe(201);
    const id = ((await posted.json()) as { draft: { id: string } }).draft.id;
    await page.goto(`/library/drafts/${id}`);
    await stepsCard(page).getByRole("button", { name: "Select step 1, Pause" }).click();
    await expect(graph.getByRole("slider", { name: "Pause's target, bar" })).toBeVisible();
    drawnAt = "";
    for (const [width, height] of widths.slice(0, 2)) {
      await page.setViewportSize({ width, height });
      await expect(drawn).not.toHaveAttribute("width", drawnAt);
      drawnAt = (await drawn.getAttribute("width"))!;
      await expect.poll(() => graphClashes(graph), { message: `${other.title}, at ${width} px` }).toEqual([]);
    }
    if (other.title === "Unreached") await expect(graph.locator("[data-not-reached]")).toHaveCount(1);
    await page.setViewportSize({ width: 1280, height: 720 });
    expect((await page.request.delete(`/api/drafts/${id}`)).status()).toBe(204);
  }

  // Decaid's bundled Profiles: "Extractamundo Dos!"'s first step, whose target's tag stands where "Preinfusion" is,
  // and "7g basket"'s last, whose bracket stands on the line where the run ends (#621);
  // "Tea portafilter/black tea"'s first step, whose exit in a short band stood over the pressure lane's numbers on a phone,
  // whose temperature lane's numbers ran into each other at a phone's and a 600 px window, and whose "Drip" or "First drip" stood over that lane's lowest,
  // and "Soup 58"'s, whose exit and temperature lane's numbers did as black tea's (#637).
  const bundled = (JSON.parse(fs.readFileSync(new URL("../server/test/fixtures/decaid/profile-ids-v0.9.2/profile-ids.json", import.meta.url), "utf8")) as { bundled: { profile: Fields & { title: string; steps: unknown[] } }[] })
    .bundled;
  // A phone's, a 600 px window's and a wide one's.
  const axisWidths: [number, number][] = [
    [393, 852],
    [600, 900],
    [1280, 720],
  ];
  for (const title of ["Extractamundo Dos!", "7g basket", "Tea portafilter/black tea", "Soup 58"]) {
    const record = bundled.find((each) => each.profile.title === title)!.profile;
    const posted = await page.request.post("/api/drafts", { data: { file: record } });
    expect(posted.status()).toBe(201);
    const id = ((await posted.json()) as { draft: { id: string } }).draft.id;
    await page.goto(`/library/drafts/${id}`);
    const selected = title === "7g basket" ? record.steps.length : 1;
    await stepsCard(page).getByRole("button", { name: new RegExp(`^Select step ${selected},`) }).click();
    await expect(graph.locator("[data-handle='seconds']")).toBeVisible();
    const phone = title === "Tea portafilter/black tea" || title === "Soup 58";
    if (phone) await expect(graph.locator("[data-handle='exit']")).toBeVisible();
    drawnAt = "";
    for (const [width, height] of phone ? axisWidths : widths) {
      await page.setViewportSize({ width, height });
      await expect(drawn).not.toHaveAttribute("width", drawnAt);
      drawnAt = (await drawn.getAttribute("width"))!;
      await expect.poll(() => graphClashes(graph), { message: `${title}, at ${width} px` }).toEqual([]);
      // The exit, held inside the plot, still takes the pointer at its centre, as where a bracket stands near the plot's left edge on a phone.
      if (phone) {
        const exitHandle = graph.locator("[data-handle='exit']");
        await exitHandle.scrollIntoViewIfNeeded();
        const exitTakesPointer = await exitHandle.evaluate((handle) => {
          const box = handle.getBoundingClientRect();
          return handle.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
        });
        expect(exitTakesPointer, `${title}'s exit at ${width} px`).toBe(true);
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    expect((await page.request.delete(`/api/drafts/${id}`)).status()).toBe(204);
  }
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

test("the checks, a status beside Publish, count what stops it and the advice, and choosing one from their list selects its step", async ({ page }) => {
  await page.goto("/library/profiles");
  await page.getByRole("region", { name: "Drafts" }).getByRole("link", { name: /^Open the Draft Lab Soak, hotter$/ }).click();
  // Its percolation held to a pressure the run reaches and its settle given a length, so its exit applies: nothing stops it and there is no advice.
  await expect(checksStatus(page)).toHaveAccessibleName("Checks: Nothing stops publishing · 2 pieces of advice");
  await stepsCard(page).getByRole("button", { name: /^Select step \d, Percolation$/ }).click();
  await inspector(page).getByLabel("Target").fill("6");
  await stepsCard(page).getByRole("button", { name: /^Select step \d, Settle$/ }).click();
  await inspector(page).getByLabel("For at most").fill("2");
  await expect(checksStatus(page)).toHaveAccessibleName("Checks: Nothing stops publishing");
  await checksStatus(page).click();
  await expect(checks(page)).toContainText("Nothing stops this from publishing, and there is no advice.");
  await page.keyboard.press("Escape");
  await stepsCard(page).getByRole("button", { name: "Select step 2, New step" }).click();
  await inspector(page).getByLabel("Or at a weight of").fill("4");
  await expect(inspector(page).getByText("Needs a scale")).toBeVisible();
  // Advice alone lets it publish.
  await expect(checksStatus(page)).toHaveAccessibleName("Checks: Nothing stops publishing · 1 piece of advice");
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
  await inspector(page).getByLabel("Name").fill("");
  await expect(checksStatus(page)).toHaveAccessibleName("Checks: 1 thing stops publishing · 1 piece of advice");
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  // Its longest words wrap on a small phone rather than running past the screen.
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 640 });
  const status = (await checksStatus(page).boundingBox())!;
  expect(status.x + status.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  // In a short window the list stays within it, scrolling within itself to its last check.
  await page.setViewportSize({ width: 1280, height: 240 });
  await checksStatus(page).click();
  const list = (await checks(page).boundingBox())!;
  expect(list.y + list.height).toBeLessThanOrEqual(240);
  const last = checks(page).getByRole("region", { name: "Advice" }).getByRole("button");
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await page.keyboard.press("Escape");
  await page.setViewportSize(viewport);
  await checksStatus(page).click();
  const advice = checks(page).getByRole("region", { name: "Advice" });
  await expect(advice.getByRole("button", { name: "Step 2 ends at a weight in the cup, which needs a scale connected." })).toBeVisible();
  await expect(checks(page).getByRole("region", { name: "Stops it publishing" }).getByText("Step 2 has no name.")).toBeVisible();
  await page.keyboard.press("Escape");
  await stepsCard(page).getByRole("button", { name: "Select step 1, Fill" }).click();
  // Chosen from the list, a check selects its step and the list closes, with the inspector, in a window too short for it, scrolled back to its top.
  await page.setViewportSize({ width: 1280, height: 480 });
  await inspector(page).evaluate((card) => card.scrollTo({ top: card.scrollHeight }));
  expect(await inspector(page).evaluate((card) => card.scrollTop)).toBeGreaterThan(100);
  await checksStatus(page).click();
  await advice.getByRole("button", { name: /^Step 2 ends at a weight/ }).click();
  await expect(checks(page)).toHaveCount(0);
  await expect(inspector(page).getByRole("tab", { name: "Step 2" })).toHaveAttribute("data-state", "active");
  expect(await inspector(page).evaluate((card) => card.scrollTop)).toBe(0);
  await expect(inspector(page).getByLabel("Name")).toBeInViewport();
  await expect(inspector(page).getByRole("tab", { name: "Step 2" })).toBeFocused();
  // On a phone, where the inspector is far under the status, the page scrolls to it.
  await page.setViewportSize({ width: 393, height: 852 });
  await stepsCard(page).getByRole("button", { name: "Select step 1, Fill" }).click();
  await checksStatus(page).click();
  await advice.getByRole("button", { name: /^Step 2 ends at a weight/ }).click();
  await expect(inspector(page).getByRole("tab", { name: "Step 2" })).toBeInViewport();
  await expect(inspector(page).getByRole("tab", { name: "Step 2" })).toBeFocused();
  // Closed without a choice, the focus returns to the status. Opened afresh, once the list has gone, so its focus moves into it first.
  await expect(checks(page)).toHaveCount(0);
  await checksStatus(page).click();
  await expect(checks(page).locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(checksStatus(page)).toBeFocused();
  await page.setViewportSize(viewport);
  await inspector(page).getByLabel("Name").fill("Soak");
  await expect(checksStatus(page)).toHaveAccessibleName("Checks: Nothing stops publishing · 1 piece of advice");
});

test("in a wide window a Draft's steps are a rail left of the graph, under it in a narrower one, and only a Draft's page is wider", async ({ page }) => {
  const pageWidth = async () => (await page.locator("main").boundingBox())!.width;
  await page.setViewportSize({ width: 1710, height: 985 });
  await page.goto(`/library/profiles/${encodeURIComponent(soakId)}`);
  await expect(page.getByRole("region", { name: "How it runs" })).toBeVisible();
  expect(await pageWidth()).toBe(1152);

  await page.goto("/library/profiles");
  await page.getByRole("region", { name: "Drafts" }).getByRole("link", { name: /^Open the Draft Lab Soak, hotter$/ }).click();
  const graph = page.getByRole("region", { name: "How it runs" });
  await expect(graph.locator("svg[data-graph-end]")).toBeVisible();
  // The page and the header grow together, to 1600 px.
  const [main, bar, steps, drawn, fields] = await boxes(page.locator("main"), page.getByRole("banner").locator("> div"), stepsCard(page), graph, inspector(page));
  expect(main!.width).toBe(1600);
  expect([bar!.x, bar!.width]).toEqual([main!.x, main!.width]);
  expect(steps!.x + steps!.width).toBeLessThanOrEqual(drawn!.x);
  expect(Math.abs(steps!.y - drawn!.y)).toBeLessThan(1);
  expect(drawn!.x + drawn!.width).toBeLessThanOrEqual(fields!.x);

  // At 1280 the steps go under the graph, which is as wide as before the rail (712 px).
  await page.setViewportSize({ width: 1280, height: 720 });
  // The steps card moves to another parent, so it can be gone for a moment while it is measured.
  await expect
    .poll(async () => {
      const [steps, drawn] = await boxes(stepsCard(page), graph);
      return steps && drawn ? steps.y - (drawn.y + drawn.height) : -1;
    })
    .toBeGreaterThanOrEqual(0);
  expect((await graph.locator("svg[data-graph-end]").boundingBox())!.width).toBeGreaterThanOrEqual(712);

  // The inspector, taller than the window, stays in it once the page scrolls, and scrolls within itself to its last buttons.
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(async () => (await inspector(page).boundingBox())?.y).toBe(16);
  expect((await inspector(page).boundingBox())!.height).toBeLessThanOrEqual(720 - 32);
  expect(await inspector(page).evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await inspector(page).evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(inspector(page).getByRole("button", { name: "Delete the step" })).toBeInViewport({ ratio: 1 });
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
  // Each says it can be pressed, as every enabled button does; Duplicate, until a Profile is chosen, does not.
  await expect(page.getByRole("button", { name: "Start from Blooming" })).toHaveCSS("cursor", "pointer");
  await expect(page.getByRole("button", { name: "Choose a file" })).toHaveCSS("cursor", "pointer");
  await expect(page.getByRole("button", { name: "Duplicate", exact: true })).not.toHaveCSS("cursor", "pointer");
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
  const [draftsBox, profilesBox] = await boxes(drafts, page.getByRole("table", { name: "Profiles" }));
  expect(draftsBox!.y).toBeLessThan(profilesBox!.y);

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
  const graph = page.getByRole("region", { name: "How it runs" });
  // Its stop-at weight changed, the shape as it started still stops at its own 36 g, so the figures say how far the Draft runs past it.
  await inspector(page).getByRole("tab", { name: "Whole Profile" }).click();
  await inspector(page).getByLabel("Stop at weight", { exact: true }).fill("45");
  await expect(graph.getByText(/^[\d.]+ s longer than Declining lever as it started$/)).toBeVisible();
  await inspector(page).getByLabel("Stop at weight", { exact: true }).fill("36");
  await expect(graph.getByText("The same as Declining lever as it started").first()).toBeVisible();
  await stepsCard(page).getByRole("button", { name: "Select step 2, Peak" }).click();
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
  await inspector(page).getByLabel("Stop at weight", { exact: true }).fill("150");
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
