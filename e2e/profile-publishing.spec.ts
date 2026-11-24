import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { NO_DYE2_LISTS } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";

// Seam 3 for #580: the publish dialog. A simulated tablet at the Lab saves
// a soak Profile, which two Recipes there name. Edit on its page starts a
// Draft, changed and published as a new version: the dialog lists what
// changed, the Locations, the Lab first as it showed the soak, and the
// Recipes there with where each is loaded, one of them left on the soak,
// which stays shown there. From the new version's page, the soak is
// returned to through the same dialog. A Duplicate, published as a separate
// Profile, says what it changes from the one it started from and moves no
// Recipes. A Draft that changes only the soak's notes is an edit of the
// soak instead (#667): the Draft page says so, and the dialog says which
// fields change and asks for no Locations, but for one made a separate
// Profile meanwhile. Serials are made up, from 58051.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

type Fields = Record<string, unknown>;

const CLASSIC = "profile:39e939592679fb194706";
const classicRecord = (JSON.parse(fs.readFileSync(new URL("../server/test/fixtures/decaid/profile-ids-v0.9.2/profile-ids.json", import.meta.url), "utf8")) as { bundled: Fields[] }).bundled.find(
  (record) => record.id === CLASSIC,
)!;

/** A soak Profile: a fast fill that moves on over 4 bar, then 6 bar with the flow held back. */
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
      step({ name: "Percolation", pump: "pressure", pressure: 6, seconds: 60, temperature: 88, limiter: { value: 1.5, range: 2.5 } }),
    ],
    target_volume: null,
    target_weight: 40,
    target_volume_count_start: 1,
    tank_temperature: 0,
  };
}

const inspector = (page: Page) => page.getByRole("region", { name: "Inspector" });

test.beforeEach(({ page }) => signInAsAdmin(page));

test("publishes a Draft as a new version at the Locations and with the Recipes chosen, then returns to the version before through the same dialog", async ({ page }) => {
  const lab = await createLocation(page, "Publish lab");
  await createLocation(page, "Publish roastery");
  const tablet = await tabletAt(page, server, "Publish lab group", lab, "58051", { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [classicRecord], ...NO_DYE2_LISTS });
  const soakId = String((await tablet.addProfile(soak("Lab Soak"))).id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(soakId)}`)).status()).toBe(200);
  for (const [name, slot] of [["Lab Espresso", 1], ["Lab Ristretto", 2]] as const) {
    const made = await page.request.post("/api/recipes", { data: { locationId: lab.id, slot, content: { name, profileId: soakId } } });
    expect(made.status(), await made.text()).toBe(201);
  }

  await page.goto(`/library/profiles/${encodeURIComponent(soakId)}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(/\/library\/drafts\//);
  // Unchanged, its steps are the soak's, which stops it publishing.
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await inspector(page).getByRole("tab", { name: "Whole Profile" }).click();
  await inspector(page).getByLabel("Stop at weight", { exact: true }).fill("38");
  await expect(page.getByText("saving…")).toHaveCount(0);

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Publish the Draft" });
  await expect(dialog.getByRole("region", { name: "What changed" })).toContainText("38 g, unless a Recipe sets a yield");
  await expect(dialog.getByRole("checkbox", { name: "Publish lab" })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Publish roastery" })).not.toBeChecked();
  const recipes = dialog.getByRole("list", { name: "Recipes at Publish lab" });
  await expect(recipes.getByRole("checkbox", { name: /Move Lab Espresso/ })).toBeChecked();
  await expect(recipes).toContainText("Loaded on no Machine now");
  await expect(dialog.getByText("Lab Soak is hidden here.")).toBeVisible();
  await recipes.getByRole("checkbox", { name: /Move Lab Ristretto/ }).click();
  await expect(dialog.getByText("Lab Soak stays shown here, as Lab Ristretto still names it.")).toBeVisible();
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();

  // The new version's page, saying what publishing did.
  await expect(page).toHaveURL(/\/library\/profiles\/profile%3A/);
  const notice = page.getByRole("status").filter({ hasText: "Shown at Publish lab" });
  await expect(notice).toContainText("Lab Soak stays shown at Publish lab, as Lab Ristretto still names it.");
  await expect(notice).toContainText("Moved to it: Lab Espresso at Publish lab.");
  await expect(page.getByRole("region", { name: "Recipes on this version" })).toContainText("Lab Espresso");
  const newId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
  await expect.poll(() => tablet.profiles().find((record) => record.id === newId)?.parentId, { timeout: 15_000 }).toBe(soakId);

  // Back to the soak, from the Versions card, through the same dialog.
  await page.getByRole("region", { name: "Versions" }).getByRole("button", { name: "Return to Version 1" }).click();
  const back = page.getByRole("dialog", { name: "Return to Version 1" });
  await expect(back.getByRole("region", { name: "What changed" })).toContainText("40 g, unless a Recipe sets a yield");
  await expect(back.getByRole("checkbox", { name: /Move Lab Espresso/ })).toBeChecked();
  await expect(back.getByText("Lab Soak is hidden here.")).toBeVisible();
  await back.getByRole("button", { name: "Return to this version" }).click();
  await expect(page).toHaveURL(new RegExp(`/library/profiles/${encodeURIComponent(soakId)}$`));
  await expect(page.getByRole("status").filter({ hasText: "Shown at Publish lab" })).toContainText("Lab Soak is hidden at Publish lab.");
  await expect(page.getByRole("region", { name: "Recipes on this version" })).toContainText("Lab Espresso");
  await expect.poll(() => tablet.profiles().find((record) => record.id === newId)?.visibility, { timeout: 15_000 }).toBe("hidden");
});

test("says what a separate Profile changes from the one it started from, and offers no Recipes to move", async ({ page }) => {
  const lab = await createLocation(page, "Separate lab");
  const tablet = await tabletAt(page, server, "Separate lab group", lab, "58052", { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [classicRecord], ...NO_DYE2_LISTS });
  // Its own steps, as a Profile's id is its steps' hash, not its title's.
  const soakId = String((await tablet.addProfile({ ...soak("Separate Soak"), target_weight: 42 })).id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(soakId)}`)).status()).toBe(200);
  const made = await page.request.post("/api/recipes", { data: { locationId: lab.id, slot: 1, content: { name: "Separate Espresso", profileId: soakId } } });
  expect(made.status(), await made.text()).toBe(201);

  await page.goto(`/library/profiles/${encodeURIComponent(soakId)}`);
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page).toHaveURL(/\/library\/drafts\//);
  await inspector(page).getByRole("tab", { name: "Whole Profile" }).click();
  await inspector(page).getByLabel("Stop at weight", { exact: true }).fill("36");
  await expect(page.getByText("saving…")).toHaveCount(0);

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Publish the Draft" });
  await expect(dialog.getByRole("region", { name: "What changed" })).toContainText("36 g, unless a Recipe sets a yield");
  // Compared with the soak, named over its column.
  await expect(dialog.getByRole("region", { name: "What changed" }).getByRole("columnheader", { name: "Separate Soak", exact: true })).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Separate lab" }).click();
  await expect(dialog.getByRole("list", { name: "Recipes at Separate lab" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Shown at Separate lab" })).toBeVisible();
});

test("publishes a Draft that changes only the notes as an edit of the Profile it started from, asking for no Locations or Recipes", async ({ page }) => {
  const lab = await createLocation(page, "Text lab");
  const tablet = await tabletAt(page, server, "Text lab group", lab, "58053", { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [classicRecord], ...NO_DYE2_LISTS });
  const soakId = String((await tablet.addProfile({ ...soak("Text Soak"), target_weight: 44, notes: "First notes" })).id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(soakId)}`)).status()).toBe(200);
  const made = await page.request.post("/api/recipes", { data: { locationId: lab.id, slot: 1, content: { name: "Text Espresso", profileId: soakId } } });
  expect(made.status(), await made.text()).toBe(201);

  await page.goto(`/library/profiles/${encodeURIComponent(soakId)}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(/\/library\/drafts\//);
  // Unchanged, there is nothing to publish, which no check calls a fault.
  await expect(page.getByText("No changes from Text Soak yet")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Checks: Nothing stops publishing/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();

  // Its notes reworded: its steps are still the soak's, so it publishes as an edit of the soak's notes.
  await inspector(page).getByRole("tab", { name: "Whole Profile" }).click();
  await inspector(page).getByLabel("Notes", { exact: true }).fill("Reworded in a Draft");
  await expect(page.getByText("saving…")).toHaveCount(0);
  await expect(page.getByText("Will publish as an edit of Text Soak's notes")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Checks: Nothing stops publishing/ })).toBeVisible();

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Publish the Draft" });
  await expect(dialog.getByText(/^Edits Text Soak's notes, as its page does/)).toBeVisible();
  const changed = dialog.getByRole("region", { name: "What changed" });
  await expect(changed.getByRole("row", { name: /Notes/ })).toContainText("First notes");
  await expect(changed.getByRole("row", { name: /Notes/ })).toContainText("Reworded in a Draft");
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();

  // The soak's own page, under its id, saying what changed; still shown at the Lab, with its Recipe.
  await expect(page).toHaveURL(new RegExp(`/library/profiles/${encodeURIComponent(soakId)}$`));
  await expect(page.getByRole("status").filter({ hasText: "Its notes changed." })).toBeVisible();
  await expect(page.getByRole("region", { name: "Recipes on this version" })).toContainText("Text Espresso");
  await expect.poll(() => (tablet.profiles().find((record) => record.id === soakId)?.profile as Fields | undefined)?.notes, { timeout: 15_000 }).toBe("Reworded in a Draft");
});

test("checks a Draft made a separate Profile while its page is open as one, not as an edit of the Profile it started from", async ({ page }) => {
  const lab = await createLocation(page, "Switch lab");
  const tablet = await tabletAt(page, server, "Switch lab group", lab, "58054", { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [classicRecord], ...NO_DYE2_LISTS });
  const soakId = String((await tablet.addProfile({ ...soak("Switch Soak"), target_weight: 46, notes: "First notes" })).id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(soakId)}`)).status()).toBe(200);

  await page.goto(`/library/profiles/${encodeURIComponent(soakId)}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(/\/library\/drafts\//);
  const draftPath = `/api/drafts/${page.url().split("/").pop()}`;
  await inspector(page).getByRole("tab", { name: "Whole Profile" }).click();
  await inspector(page).getByLabel("Notes", { exact: true }).fill("Reworded in a Draft");
  await expect(page.getByText("saving…")).toHaveCount(0);
  await expect(page.getByText("Will publish as an edit of Switch Soak's notes")).toBeVisible();

  // Made a separate Profile elsewhere, as by an assistant; the page learns of it from its next save's answer.
  const { draft } = (await (await page.request.get(draftPath)).json()) as { draft: { saves: number } };
  const switched = await page.request.put(draftPath, { data: { publishesAs: "separate", saves: draft.saves } });
  expect(switched.status(), await switched.text()).toBe(200);
  await inspector(page).getByLabel("Notes", { exact: true }).fill("Reworded again");
  await expect(page.getByText("saving…")).toHaveCount(0);
  await expect(page.getByText("Will publish as a new Profile, a copy of Switch Soak")).toBeVisible();
  // A separate Profile needs steps of its own.
  await expect(page.getByRole("button", { name: /^Checks: 1 thing stops publishing/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
});
