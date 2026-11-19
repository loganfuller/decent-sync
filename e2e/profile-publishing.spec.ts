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
// returned to through the same dialog. Serials are made up, from 58051.
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
  await inspector(page).getByLabel("Stop at weight").fill("38");
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
