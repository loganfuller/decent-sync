import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { NO_DYE2_LISTS } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";
import { expectTip } from "./support/tooltips.js";

// Seam 3 for #578: the Profile page rebuilt on its graph. A simulated tablet
// at the Lab saves a Profile with an exit, a limit and a step of no length,
// then two Profiles saved from it, a fork, as a barista saves a changed
// Profile in a Skin; a Recipe names the newest, loaded on the Lab's Machine.
// Another tablet holds Decaid's bundled Classic Italian espresso and a Shot
// Decaid v0.9.2's simulated machine recorded on it
// (server/test/fixtures/decaid/simulated-shots-v0.9.2/), whose puck the
// simulation runs on. Serials are made up, from 57801.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

type Fields = Record<string, unknown>;

const tabletApi = { "/beans": [], "/bean-batches": [], "/grinders": [], ...NO_DYE2_LISTS };

/** Classic Italian espresso, which Decaid bundles, by the id Decaid gives it. */
const CLASSIC = "profile:39e939592679fb194706";
const SHOT = "simulated-classic-578";
/** The same Shot as recorded with no pressure, so its puck can't be worked out. */
const FLAT = "flat-classic-578";

/** A soak Profile: a fast fill that moves on over 4 bar, a step of no length, then 6 bar with the flow held back, with `changes` to its third step. */
function soak(title: string, percolation: Fields = {}): Fields {
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
      step({ name: "Percolation", pump: "pressure", pressure: 6, seconds: 60, temperature: 88, limiter: { value: 1.5, range: 2.5 }, ...percolation }),
    ],
    target_volume: null,
    target_weight: 40,
    target_volume_count_start: 2,
    tank_temperature: 0,
  };
}

async function waitForProfile(page: Page, id: string) {
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(id)}`)).status()).toBe(200);
}

const profilePage = (id: string) => `/library/profiles/${encodeURIComponent(id)}`;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("a Profile's page draws how it runs, lists its steps in words, its versions and the Recipes on it", async ({ page }) => {
  const lab = await createLocation(page, "Soak lab");
  const tablet = await tabletAt(page, server, "Soak lab group", lab, "57801", { ...tabletApi, "/profiles": [] });
  const first = await tablet.addProfile(soak("Lab Soak"));
  await waitForProfile(page, String(first.id));
  const second = await tablet.addProfile(soak("Lab Soak", { pressure: 6.5 }), { parentId: first.id });
  await waitForProfile(page, String(second.id));
  // Saved again from the first, a fork beside the second.
  const fork = await tablet.addProfile(soak("Lab Soak, held", { limiter: { value: 2, range: 1 } }), { parentId: first.id });
  await waitForProfile(page, String(fork.id));
  const recipe = (await (await page.request.post("/api/recipes", { data: { locationId: lab.id, slot: 3, content: { name: "Soak Espresso", profileId: second.id, dose: 20, yield: 44 } } })).json()) as {
    recipe: { id: string };
  };
  const machineId = ((await (await page.request.get("/api/machines")).json()) as { machines: { id: string; name: string }[] }).machines.find((each) => each.name === "Soak lab group")!.id;
  const database = await server.connectDatabase();
  try {
    await database.query("INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at) VALUES ($1, $2, now())", [machineId, recipe.recipe.id]);
  } finally {
    await database.end();
  }

  await page.goto(profilePage(String(second.id)));
  await expect(page.getByRole("heading", { name: /^Lab Soak/, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Version 2");
  await expect(page.getByRole("main").getByText(/Espresso · by Decent Sync fixtures · saved from/)).toBeVisible();

  const graph = page.getByRole("region", { name: "How it runs" });
  await expectTip(page.getByRole("main"), "How it runs, simulated", /^A simulation of what a Machine does with this Profile, not a measurement/);
  // Simulated on the standard puck as a DE1, 18 g in, stopping at its 40 g.
  await expect(graph.getByRole("radio", { name: "A standard puck" })).toBeChecked();
  await expect(graph.getByRole("radio", { name: "DE1" })).toBeChecked();
  await expect(graph.getByText("18 g in, stopping at 40 g, on a DE1")).toBeVisible();
  const svg = graph.getByRole("figure", { name: /^Simulated run of Lab Soak on a standard puck\./ });
  await expect(svg).toHaveAccessibleName(/Fill: \d+\.\d s, pressure passed 4 bar\. Settle: Passed through at once\. Percolation: \d+\.\d s, the Shot stopped at 40 g\./);
  // Two bands, the step of no length none; the Fill's exit a threshold in the pressure lane; the Percolation's flow limit a band.
  await expect(svg.locator("[data-step-band]")).toHaveCount(2);
  await expect(svg.locator("[data-exit='0']")).toContainText("Moves on over 4 bar");
  await expect(svg.locator("[data-limit='2']")).toContainText("Flow limited to 1.5 ml/s, easing over 2.5");
  await expect(svg.locator("[data-stop]")).toContainText(/^Stops at \d+\.\d s/);
  await expect(svg.locator("[data-cup-mark]")).toHaveText(["First drip", "10 g", "20 g", "30 g"]);
  await expect(svg.locator("[data-preinfusion]")).toContainText("Preinfusion");
  const figures = graph.getByRole("definition");
  const time = async () => Number((await graph.getByLabel("Simulated figures").getByRole("definition").first().textContent())!.replace(" s", ""));
  await expect(figures.first()).toHaveText(/^\d+\.\d s$/);
  // Pointing at a moment reads the values there.
  await svg.hover({ position: { x: 300, y: 120 } });
  await expect(svg.locator("[data-readout]")).toContainText("Pressure");
  await expect(svg.locator("[data-readout]")).toContainText("In the cup");
  // A finer puck runs longer.
  const medium = await time();
  await graph.getByRole("slider", { name: "Puck, finer to coarser" }).focus();
  await page.keyboard.press("Home");
  await expect.poll(time).toBeGreaterThan(medium);
  // The Recipe's dose and yield.
  await graph.getByRole("button", { name: "Use a Recipe's" }).click();
  await page.getByRole("menuitem", { name: "Soak Espresso, Soak lab" }).click();
  await expect(graph.getByText(/^20 g in, stopping at 44 g, on a DE1/)).toBeVisible();
  await graph.getByRole("radio", { name: "Bengle" }).click();
  await expect(graph.getByText(/^20 g in, stopping at 44 g, on a Bengle/)).toBeVisible();

  // The steps say what the simulation drawn did: now the Recipe's 20 g in, stopping at 44 g, on a Bengle.
  const steps = page.getByRole("region", { name: "Steps" });
  await expect(rows(steps.getByRole("table", { name: "Steps" }))).toHaveText([
    /^1FillPumps 8 ml\/s at onceOver 4 bar, or after 15 s\d+\.\d s, pressure passed 4 bar$/,
    /^2SettleStops the pumpAt oncePassed through at once$/,
    /^3PercolationHolds 6\.5 bar at once, flow limited to 1\.5 ml\/s, 2 °C coolerAfter 60 s\d+\.\d s, the Shot stopped at 44 g$/,
  ]);
  const facts = steps.getByLabel("The Profile");
  await expect(facts).toContainText("Brew temperature90 °C, unless a Recipe sets its own");
  await expect(facts).toContainText("Stops at40 g, unless a Recipe sets a yield");
  await expect(facts).toContainText("PreinfusionEnds after Settle");
  await expect(facts).toContainText("Water tankNot preheated");

  // Its versions, the latest first, both branches of the fork, each saved by the lab's Machine.
  const versions = page.getByRole("region", { name: "Versions" }).getByRole("list", { name: "Versions" }).getByRole("listitem");
  await expect(versions).toHaveCount(3);
  await expect(versions.nth(0)).toContainText("Version 3");
  await expect(versions.nth(0)).toContainText("saved from Version 1");
  await expect(versions.nth(1)).toContainText("Version 2 · this one");
  await expect(versions.nth(1)).toContainText("Soak lab group");
  await expect(versions.nth(1)).toContainText("saved from Version 1");
  await expect(versions.nth(2)).toContainText("Version 1");
  await expect(versions.nth(2)).toContainText("Shown nowhere · no Shots");

  const recipes = page.getByRole("region", { name: "Recipes on this version" });
  await expect(recipes.getByRole("listitem")).toHaveText(["Soak EspressoSoak lab, slot 3 · loaded on Soak lab group"]);
  await expect(page.getByRole("region", { name: "Shots" })).toContainText("No Shots on this version, none on earlier ones");

  // Export gives its profile as Decaid's JSON.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("Lab-Soak.json");
  const exported = JSON.parse(fs.readFileSync((await file.path())!, "utf8")) as Fields;
  expect(exported).toMatchObject({ title: "Lab Soak", target_weight: 40, steps: [{ name: "Fill" }, { name: "Settle" }, { name: "Percolation", pressure: 6.5 }] });

  // Comparing two versions: what differs in their steps, and each simulated on the same puck.
  await page.getByRole("link", { name: "Compare with Version 1" }).click();
  await expect(page).toHaveURL(new RegExp(`/compare/${encodeURIComponent(String(first.id))}$`));
  const differs = page.getByRole("table", { name: "What differs between the versions" });
  await expect(rows(differs).first()).toHaveText("Percolation doesHolds 6.5 bar at once, flow limited to 1.5 ml/s, 2 °C coolerHolds 6 bar at once, flow limited to 1.5 ml/s, 2 °C cooler");
  await expect(differs).toContainText("Simulated on a standard puck, 18 g in, stopping at 40 g, on a DE1");
  const both = page.getByRole("region", { name: "How each runs" }).getByRole("figure");
  await expect(both).toHaveAccessibleName(/^Simulated run of Version 2/);
  await expect(both.locator("[data-compared] path").first()).toHaveAttribute("d", /^M/);
  await expect(both.locator("[data-compared-stop]")).toContainText("Version 1 stops");
});

test("a Profile simulated on a Shot's puck says how close the simulation comes, and any Shot can be laid over it", async ({ page }) => {
  const lab = await createLocation(page, "Puck lab");
  const bundled = (JSON.parse(fs.readFileSync(new URL("../server/test/fixtures/decaid/profile-ids-v0.9.2/profile-ids.json", import.meta.url), "utf8")) as { bundled: Fields[] }).bundled;
  const classic = bundled.find((record) => record.id === CLASSIC)!;
  const tablet = await tabletAt(page, server, "Puck lab group", lab, "57811", { ...tabletApi, "/profiles": [classic] });
  await waitForProfile(page, CLASSIC);
  const recorded = JSON.parse(fs.readFileSync(new URL("../server/test/fixtures/decaid/simulated-shots-v0.9.2/classic-italian.json", import.meta.url), "utf8")) as Fields;
  const workflow = recorded.workflow as Fields;
  tablet.pullShot({ ...recorded, id: SHOT, workflow: { ...workflow, machine: { ...(workflow.machine as Fields), serialNumber: "57811" } } });
  await expect.poll(async () => (await page.request.get(`/api/shots/${SHOT}`)).status()).toBe(200);

  await page.goto(profilePage(CLASSIC));
  const graph = page.getByRole("region", { name: "How it runs" });
  await expect(page.getByRole("region", { name: "Shots" })).toHaveText("Shots1 ShotOpen in the Shots list");

  // Laid over the graph, the Shot is drawn in orange, from those on this Profile.
  await graph.getByRole("button", { name: "Lay a Shot over it" }).click();
  const picker = page.getByRole("dialog", { name: "Lay a Shot over the graph" });
  await picker.getByRole("region", { name: "On this Profile" }).getByRole("button", { name: /^Choose the Shot of / }).click();
  await expect(graph.getByRole("figure").locator("[data-compared] path").first()).toHaveAttribute("d", /^M/);
  await expect(graph.getByText(/, with the Shot of .* on Puck lab group over it$/)).toBeVisible();

  // On its puck: its dose and the weight it stopped at, the table of how close a run of its own steps comes.
  await graph.getByRole("radio", { name: "A Shot's puck" }).click();
  await page.getByRole("dialog", { name: "Simulate on a Shot's puck" }).getByRole("region", { name: "On this Profile" }).getByRole("button", { name: /^Choose / }).click();
  await expect(graph.getByRole("radio", { name: "A Shot's puck" })).toBeChecked();
  await expect(graph.getByRole("figure", { name: /^Simulated run of Classic Italian espresso on a Shot's puck\./ })).toBeVisible();
  const puck = graph.getByRole("complementary", { name: "The puck" });
  await expect(puck.getByRole("link", { name: "Classic Italian espresso on Puck lab group" })).toBeVisible();
  const fit = puck.getByRole("table", { name: "The simulation against the Shot" });
  await expect(rows(fit).first()).toHaveText(/^Duration\d+\.\d s\d+\.\d s$/);
  await expect(graph.getByLabel("Simulated figures")).toContainText("than the Shot");

  // A Shot whose puck can't be worked out leaves another to be chosen.
  const flat = await tabletAt(page, server, "Flat lab group", lab, "57812", { ...tabletApi, "/profiles": [classic] });
  const unpressed = (recorded.measurements as Fields[]).map((measurement) => ({ ...measurement, machine: { ...(measurement.machine as Fields), pressure: 0 } }));
  flat.pullShot({ ...recorded, id: FLAT, measurements: unpressed, workflow: { ...workflow, machine: { ...(workflow.machine as Fields), serialNumber: "57812" } } });
  await expect.poll(async () => (await page.request.get(`/api/shots/${FLAT}`)).status()).toBe(200);
  const onThisProfile = (title: string) => page.getByRole("dialog", { name: title }).getByRole("region", { name: "On this Profile" });
  await puck.getByRole("button", { name: "Choose another Shot" }).click();
  await onThisProfile("Simulate on a Shot's puck").getByRole("button", { name: /^Choose the Shot of .* on Flat lab group$/ }).click();
  await expect(graph.getByText("That Shot recorded no pressure and flow to work its puck out from.")).toBeVisible();
  await graph.getByRole("button", { name: "Choose another Shot" }).click();
  await onThisProfile("Simulate on a Shot's puck").getByRole("button", { name: /^Choose the Shot of .* on Puck lab group$/ }).click();
  await expect(fit).toBeVisible();

  // Each puck keeps its own dose: one typed on the standard puck isn't the Shot's, and is there again on return.
  await graph.getByRole("radio", { name: "A standard puck" }).click();
  await graph.getByLabel("Dose").fill("19");
  await expect(graph.getByText(/^19 g in, /)).toBeVisible();
  await graph.getByRole("radio", { name: "A Shot's puck" }).click();
  await expect(graph.getByLabel("Dose")).not.toHaveValue("19");
  await graph.getByRole("radio", { name: "A standard puck" }).click();
  await expect(graph.getByLabel("Dose")).toHaveValue("19");

  // At the end of whichever ran longer, the other reads as stopped, not as its last values.
  // The graph's time slider takes the arrow keys, and says what the readout shows.
  const overlaid = graph.getByRole("figure", { name: /^Simulated run of Classic Italian espresso on a standard puck\./ });
  const moment = overlaid.getByRole("slider", { name: "A moment on the graph" });
  await moment.focus();
  await page.keyboard.press("End");
  await expect(overlaid.locator("[data-readout]")).toContainText("Stopped");
  await expect(moment).toHaveAttribute("aria-valuetext", /Stopped/);
  await page.keyboard.press("Home");
  await expect(moment).toHaveAttribute("aria-valuetext", /^0\.0 s.*: Pressure /);
});

test("a Profile asking for an outlandish pressure still draws", async ({ page }) => {
  const lab = await createLocation(page, "Outlandish lab");
  const tablet = await tabletAt(page, server, "Outlandish lab group", lab, "57831", { ...tabletApi, "/profiles": [] });
  const saved = await tablet.addProfile(soak("Outlandish Soak", { pressure: 1e20, temperature: 1e20 }));
  await waitForProfile(page, String(saved.id));
  await page.goto(profilePage(String(saved.id)));
  const svg = page.getByRole("region", { name: "How it runs" }).getByRole("figure", { name: /^Simulated run of Outlandish Soak/ });
  await expect(svg).toBeVisible();
  await expect(svg.locator("[data-lane='pressure'] > g")).toHaveCount(6);
});

test("a Profile's page fits a phone", async ({ page }) => {
  const lab = await createLocation(page, "Phone lab");
  const tablet = await tabletAt(page, server, "Phone lab group", lab, "57821", { ...tabletApi, "/profiles": [] });
  const saved = await tablet.addProfile(soak("Phone Soak", { pressure: 7 }));
  await waitForProfile(page, String(saved.id));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(profilePage(String(saved.id)));
  const svg = page.getByRole("region", { name: "How it runs" }).getByRole("figure", { name: /^Simulated run of Phone Soak/ });
  await expect(svg).toBeVisible();
  // Pointing at its middle, where the readout fits neither side of the line, keeps the readout inside the graph.
  const graphBox = (await svg.boundingBox())!;
  await svg.hover({ position: { x: graphBox.width / 2, y: 120 } });
  const readout = svg.locator("[data-readout]");
  await expect(readout).toBeVisible();
  const readoutBox = (await readout.boundingBox())!;
  expect(readoutBox.x).toBeGreaterThanOrEqual(graphBox.x);
  expect(readoutBox.x + readoutBox.width).toBeLessThanOrEqual(graphBox.x + graphBox.width);
  await expect(page.getByRole("table", { name: "Steps" })).toBeVisible();
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect({ scrollWidth, clientWidth }).toEqual({ scrollWidth: 390, clientWidth: 390 });
});
