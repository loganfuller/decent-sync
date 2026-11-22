import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { shotFixture } from "../server/test/support/shot-fixtures.js";
import { NO_DYE2_LISTS, type SimulatedTablet } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";

// Seam 3 for #581: a Machine following a Draft, and a Trial Shot arriving.
// An Admin marks the Lab for trying Drafts on the Locations page; on a
// Draft's page the Lab's Machine, a simulated tablet, is had to follow it,
// after the notice that its Loaded Recipe ends, and the page says it has the
// Draft's steps. A Shot pulled there arrives by itself, listed as a Trial
// Shot and laid over the graph, setting the simulation to match it. A profile
// loaded on the tablet stops following, the page says what the Machine has,
// and one press follows again. Serials are made up, from 58151.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

type Fields = Record<string, unknown>;

/** Classic Italian espresso, which Decaid bundles, by the id Decaid gives it. */
const CLASSIC = "profile:39e939592679fb194706";
const SERIAL = "58151";

const classicRecord = (JSON.parse(fs.readFileSync(new URL("../server/test/fixtures/decaid/profile-ids-v0.9.2/profile-ids.json", import.meta.url), "utf8")) as { bundled: Fields[] }).bundled.find(
  (record) => record.id === CLASSIC,
)!;

const onMachine = (page: Page) => page.getByRole("region", { name: "On a Machine" });
const trials = (page: Page) => page.getByRole("region", { name: "Trial Shots" });
const graph = (page: Page) => page.getByRole("region", { name: "How it runs" });
const title = (tablet: SimulatedTablet) => (tablet.workflow().profile as Fields).title;

/** A Shot the tablet's Machine pulled just now with the Workflow it holds. */
function shotOf(tablet: SimulatedTablet, id: string): Fields {
  const fixture = shotFixture();
  return { ...fixture, id, timestamp: new Date().toISOString(), workflow: { ...tablet.workflow(), machine: { ...((fixture.workflow as Fields).machine as Fields), serialNumber: SERIAL } } };
}

test.beforeEach(({ page }) => signInAsAdmin(page));

test("a Machine at a Location marked for it follows a Draft, its Trial Shot arrives on the graph, and following that stopped is taken up again", async ({ page }) => {
  const lab = await createLocation(page, "Trial lab");
  const tablet = await tabletAt(page, server, "Trial lab group", lab, SERIAL, { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [classicRecord], ...NO_DYE2_LISTS });
  const { draft } = (await (await page.request.post("/api/drafts", { data: { shape: "classic" } })).json()) as { draft: { id: string; title: string } };

  // No Location tries Drafts yet, so the Draft's page offers no Machine.
  await page.goto(`/library/drafts/${draft.id}`);
  await expect(graph(page)).toBeVisible();
  await expect(onMachine(page)).toHaveCount(0);

  // An Admin marks the Lab.
  await page.goto("/locations");
  await page.getByRole("button", { name: "Edit Trial lab" }).click();
  await page.getByRole("switch", { name: "Drafts may be tried here" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("list", { name: "Locations" })).toContainText("Drafts may be tried here");

  // The Draft is followed on the Lab's Machine, after the notice.
  await page.goto(`/library/drafts/${draft.id}`);
  await expect(onMachine(page).getByRole("combobox", { name: "Machine" })).toContainText("Trial lab group");
  await onMachine(page).getByRole("switch", { name: "Follow on" }).click();
  const notice = page.getByRole("alertdialog", { name: "Follow this Draft on Trial lab group?" });
  await expect(notice).toContainText("Trial lab group's Loaded Recipe ends");
  await expect(notice).toContainText("Its dose, yield, Bean Batch, Grinder and Basket stay as they are");
  await notice.getByRole("button", { name: "Follow" }).click();
  await expect(onMachine(page)).toContainText("The Machine has these steps, since");
  await expect(onMachine(page)).toContainText(`on its tablet as “${draft.title} (Draft)”`);
  expect(title(tablet)).toBe(`${draft.title} (Draft)`);
  await expect(trials(page)).toContainText("None yet");

  // A save reaches the Machine by itself.
  const inspector = page.getByRole("region", { name: "Inspector" });
  await inspector.getByRole("tab", { name: "Profile" }).click();
  await inspector.getByLabel("Title").fill("Lab classic");
  await expect.poll(() => title(tablet)).toBe("Lab classic (Draft)");
  await expect(onMachine(page)).toContainText("The Machine has these steps, since");

  // Away from what the Trial Shot will give: another dose, a Bengle, the finest puck.
  const puck = graph(page).getByRole("slider", { name: "Puck, finer to coarser" });
  await graph(page).getByLabel("Dose").fill("21");
  await graph(page).getByRole("radio", { name: "Bengle" }).click();
  await puck.focus();
  await page.keyboard.press("Home");
  await expect(graph(page).getByText(/^21 g in, .*, on a Bengle$/)).toBeVisible();

  // A Shot pulled on it arrives by itself: listed, and laid over the graph on the standard puck, the simulation set to match it, with no tap.
  tablet.pullShot(shotOf(tablet, "trial-shot-58151"));
  await expect(trials(page).getByRole("listitem")).toHaveCount(1, { timeout: 15_000 });
  await expect(trials(page)).toContainText("On these steps");
  await expect(trials(page)).toContainText("Trial Shots · 1 on Trial lab group");
  await expect(graph(page)).toContainText("The Trial Shot, as it ran");
  await expect(trials(page).getByRole("listitem").getByRole("button")).toHaveAttribute("aria-current", "true");
  // Its 18 g weighed, the 32.5 g it stopped at, its DE1Pro, and the puck nearest its own.
  await expect(graph(page).getByText(/^18 g in, stopping at 32\.5 g, on a DE1, with the Shot of .* on Trial lab group over it$/)).toBeVisible();
  await expect(graph(page).getByRole("radio", { name: "DE1" })).toBeChecked();
  await expect.poll(async () => Number(await puck.getAttribute("aria-valuenow"))).toBeGreaterThan(-1);
  await expect(graph(page).getByRole("figure", { name: /^Simulated run of Lab classic on a standard puck\./ })).toBeVisible();
  await expect(graph(page).getByRole("complementary")).toHaveCount(0);
  await expect(graph(page).getByRole("table")).toHaveCount(0);
  // Beside the inspector the graph keeps its width, wider than a phone's 560 px.
  expect((await graph(page).locator("svg[data-graph-end]").first().boundingBox())!.width).toBeGreaterThanOrEqual(560);
  // Each can be changed after, the Trial Shot staying over the run.
  await graph(page).getByLabel("Dose").fill("19");
  await expect(graph(page).getByText(/^19 g in, stopping at 32\.5 g, on a DE1, with the Shot of /)).toBeVisible();
  await expect(trials(page).getByRole("listitem").getByRole("button")).toHaveAttribute("aria-current", "true");

  // A change of the Draft's steps makes that trial one on earlier steps, which opens against the steps it ran.
  await page.getByRole("region", { name: "Steps" }).getByRole("button", { name: "Add a step" }).click();
  await expect(trials(page)).toContainText("On earlier steps", { timeout: 15_000 });
  await trials(page).getByRole("listitem").getByRole("button").click();
  const earlier = page.getByRole("dialog", { name: /^Trial Shot of .*, on earlier steps$/ });
  const earlierGraph = earlier.getByRole("region", { name: "How it runs" });
  await expect(earlierGraph).toContainText("The Trial Shot, as it ran");
  // There too the steps it ran are simulated on the standard puck, set to match the Shot laid over them.
  await expect(earlierGraph.getByText(/^18 g in, stopping at 32\.5 g, on a DE1, with the Shot of .* on Trial lab group over it$/)).toBeVisible();
  await expect(earlierGraph.getByRole("complementary")).toHaveCount(0);
  // The svg's width attribute is its laid-out width once the graph has measured itself (in its first frame it may still be the zoomed width, which only lowers it).
  expect(Number(await earlier.locator("svg[data-graph-end]").first().getAttribute("width"))).toBeGreaterThanOrEqual(560);
  await expect(earlier.getByRole("link", { name: "Open the Shot" })).toHaveAttribute("href", "/shots/trial-shot-58151");
  await page.keyboard.press("Escape");

  // A profile loaded on the tablet stops following; the page says what the Machine has, and one press follows again.
  expect((await tablet.callApi("PUT", "/workflow", { profile: classicRecord.profile })).status).toBe(200);
  await expect(onMachine(page)).toContainText("Following stopped at", { timeout: 15_000 });
  await expect(onMachine(page)).toContainText("Trial lab group now has Classic Italian espresso.");
  await expect(onMachine(page).getByRole("switch", { name: "Follow on" })).not.toBeChecked();
  await onMachine(page).getByRole("button", { name: "Follow again" }).click();
  await expect(onMachine(page)).toContainText("The Machine has these steps, since");
  expect(title(tablet)).toBe("Lab classic (Draft)");

  // Turned off, the Machine keeps the steps and the page offers to follow again.
  await onMachine(page).getByRole("switch", { name: "Follow on" }).click();
  await expect(onMachine(page)).toContainText("It was turned off, or the Draft followed on another Machine.");
  expect(title(tablet)).toBe("Lab classic (Draft)");

  // The page fits a phone's width with the card and the list on it.
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(onMachine(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
