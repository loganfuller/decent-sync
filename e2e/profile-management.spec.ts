import { type Browser, type Page, expect, test } from "@playwright/test";
import { de1ProOnDecaid092, derivedProfile } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field, rows } from "./support/locators.js";
import { tabletAt } from "./support/tablets.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";

// Showing and hiding Profiles at Locations in the management interface,
// which is how a lab Profile is promoted to a cafe, and Archiving and
// deleting them there (ticket #88); and editing a Profile's title, author
// and notes on its page (ticket #576). A simulated tablet running the built
// plugin at the lab creates each Profile, as Profiles have no REST create;
// what each Location's tablets are written of them is
// server/test/library-profile-management.test.ts's.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

/** What each Machine's tablet holds over derivedDe1Pro()'s: no library. */
const tabletApi = { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] };

test.beforeEach(({ page }) => signInAsAdmin(page));

test("a lab Profile is shown at cafes, and hidden at one of them again", async ({ page }) => {
  const lab = await createLocation(page, "Roastery lab");
  await createLocation(page, "Uptown");
  await createLocation(page, "Belmont");
  const labTablet = await tabletAt(page, server, "Lab group", lab, "17001", tabletApi);
  const record = await labTablet.addProfile(derivedProfile("Lab Bloom", 8.5));
  const id = String(record.id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(id)}`)).status()).toBe(200);

  await page.goto(`/library/profiles/${encodeURIComponent(id)}`);
  await expect(page.getByRole("heading", { name: "Lab Bloom", level: 1 })).toBeVisible();
  const shownAt = (name: string) => page.getByRole("switch", { name: `Shown at ${name}` });
  await expect(shownAt("Roastery lab")).toBeChecked();
  await expect(shownAt("Uptown")).not.toBeChecked();
  await expect(shownAt("Belmont")).not.toBeChecked();

  await shownAt("Uptown").click();
  await expect(shownAt("Uptown")).toBeChecked();
  await shownAt("Belmont").click();
  await expect(shownAt("Belmont")).toBeChecked();

  await shownAt("Uptown").click();
  await expect(shownAt("Uptown")).not.toBeChecked();
  await expect(shownAt("Belmont")).toBeChecked();
  await expect(shownAt("Roastery lab")).toBeChecked();

  // No Shot was pulled with it, so its page has none to open (#547). The Shots list, opened by a Profile, as its page
  // opens it once it has Shots, names it in a chip that removes it.
  const shots = page.getByRole("region", { name: "Shots" });
  await expect(shots).toHaveText("ShotsNo Shots yet");
  await expect(shots.getByRole("link")).toHaveCount(0);
  await page.goto(`/shots?profileId=${encodeURIComponent(id)}`);
  await expect(page.getByRole("list", { name: "Filters set" }).getByRole("listitem")).toHaveText(["Library Profile:Lab Bloom"]);
  await page.getByRole("button", { name: "Remove the Library Profile filter" }).click();
  await expect(page).toHaveURL(/\/shots$/);

  // The list shows where it is shown now.
  await page.goto("/library/profiles");
  const row = page.getByRole("table", { name: "Profiles" }).getByRole("row").filter({ has: page.getByRole("link", { name: "Lab Bloom", exact: true }) });
  await expect(row.getByRole("cell").nth(2)).toHaveText("Belmont, Roastery lab");
});

test("a Profile is Archived, keeping where it was shown, restored, and deleted by an Admin", async ({ page }) => {
  const lab = await createLocation(page, "Archive lab");
  const cafe = await createLocation(page, "Archive cafe");
  const labTablet = await tabletAt(page, server, "Archive lab group", lab, "17011", tabletApi);
  const record = await labTablet.addProfile(derivedProfile("Retired Bloom", 7.25));
  const id = String(record.id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(id)}`)).status()).toBe(200);
  expect((await page.request.put(`/api/profiles/${encodeURIComponent(id)}/locations/${cafe.id}`, { data: { shown: true } })).status()).toBe(200);

  await page.goto(`/library/profiles/${encodeURIComponent(id)}`);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("heading", { name: "Retired Bloom", level: 1 })).toContainText("Archived");
  await expect(page.getByText(/It is Archived, so it is shown nowhere/)).toBeVisible();
  // Each Location's choice is kept.
  await expect(page.getByRole("switch", { name: "Shown at Archive cafe" })).toBeChecked();

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Shown at Archive cafe" })).toBeChecked();

  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Profiles", level: 1 })).toBeVisible();
  // The heading shows before the list has loaded, so wait for the list, or for its saying there are none.
  await expect(page.getByRole("table", { name: "Profiles" }).or(page.getByText(/^No Profiles yet\./))).toBeVisible();
  await expect(page.getByRole("link", { name: "Retired Bloom", exact: true })).toHaveCount(0);
});

test("a Profile's title, author and notes are edited on its page, its history listing the edit, but neither a bundled Profile's nor by a Viewer", async ({ page, browser }) => {
  // What reaches the tablets, and the refusals, are server/test/library-profile-text.test.ts's.
  const lab = await createLocation(page, "Text lab");
  const bundled = (de1ProOnDecaid092()["/profiles"] as Record<string, unknown>[]).find((record) => record.isDefault === true)!;
  const labTablet = await tabletAt(page, server, "Text lab group", lab, "17021", { ...tabletApi, "/profiles": [bundled] });
  const record = await labTablet.addProfile({ ...derivedProfile("Edit Bloom", 6.75), author: "Lab", notes: "First notes" });
  const id = String(record.id);
  await expect.poll(async () => (await page.request.get(`/api/profiles/${encodeURIComponent(id)}`)).status()).toBe(200);

  await page.goto(`/library/profiles/${encodeURIComponent(id)}`);
  const card = page.getByLabel("Title, author and notes", { exact: true });
  const editButton = page.getByRole("button", { name: "Edit the title, author and notes" });
  await expect(field(card, "Author")).toHaveText("Lab");
  await editButton.click();
  const form = page.getByRole("form", { name: "Edit the title, author and notes" });
  await expect(form.getByLabel("Title")).toHaveValue("Edit Bloom");
  await form.getByLabel("Title").fill("Edit Bloom v2");
  await form.getByLabel("Author").fill("Coffee lead");
  await form.getByLabel("Notes").fill("A longer bloom, then 6 bar.");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Edit Bloom v2", level: 1 })).toBeVisible();
  await expect(field(card, "Title")).toHaveText("Edit Bloom v2");
  await expect(field(card, "Author")).toHaveText("Coffee lead");
  await expect(field(card, "Notes")).toHaveText("A longer bloom, then 6 bar.");
  // Its id is the same: the steps that decide it are as they were.
  await expect(page.getByText(id, { exact: true })).toBeVisible();
  await expect.poll(() => (labTablet.profiles().find((held) => held.id === id)?.profile as Record<string, unknown> | undefined)?.title).toBe("Edit Bloom v2");

  // Its history lists the edit, made here.
  const history = rows(page.getByRole("table", { name: "History" }));
  await expect(history.nth(0)).toContainText("You, here");
  await expect(history.nth(0)).toContainText("TitleEdit Bloom v2");
  await expect(history.nth(0)).toContainText("AuthorCoffee lead");

  // A bundled Profile's are Decaid's: its page offers no Edit.
  await page.goto(`/library/profiles/${encodeURIComponent(String(bundled.id))}`);
  await expect(field(card, "Title")).toHaveText(String((bundled.profile as Record<string, unknown>).title));
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
  await expect(editButton).toHaveCount(0);

  // A Viewer reads the card, with no control.
  await asViewer(page, browser, async (valsPage) => {
    await valsPage.goto(`/library/profiles/${encodeURIComponent(id)}`);
    await expect(field(valsPage.getByLabel("Title, author and notes", { exact: true }), "Title")).toHaveText("Edit Bloom v2");
    await expect(valsPage.getByRole("button", { name: "Edit the title, author and notes" })).toHaveCount(0);
  });
});

/** Runs `work` with a page signed in as a new Viewer. */
async function asViewer(page: Page, browser: Browser, work: (page: Page) => Promise<void>) {
  const response = await page.request.post("/api/invites", { data: { email: "viewer-576@example.com", role: "viewer", locationIds: [] } });
  expect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const context = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await context.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, {
      data: { name: "Val Viewer", password: "account password 1" },
    });
    expect(accepted.status()).toBe(201);
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}
